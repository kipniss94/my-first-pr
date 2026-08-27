'use client';

import { useSyncExternalStore } from 'react';
import type { JobError, JobStage, JobState } from '@docuview/shared';
import { ApiError, cancelJob, getJob, uploadFile, type UploadHandle } from './api';

export type SessionPhase = 'uploading' | 'processing' | 'ready' | 'error' | 'cancelled';

export interface Session {
  id: string;
  fileName: string;
  fileSize: number;
  phase: SessionPhase;
  /** The stage shown in the progress rail. */
  stage: JobStage;
  /** 0..100 for the current stage, or -1 when the duration is unknown. */
  progress: number;
  uploadedBytes: number;
  jobId: string | null;
  fileId: string | null;
  job: JobState | null;
  error: JobError | null;
  startedAt: number;
}

/**
 * A module-scoped store so an upload survives the client-side navigation from
 * the landing page to the viewer. Without it the browser would either have to
 * finish uploading before navigating, or restart the upload afterwards.
 */
const sessions = new Map<string, Session>();
const uploads = new Map<string, UploadHandle>();
const pollers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

const POLL_INTERVAL_MS = 250;

function emit(): void {
  for (const listener of listeners) listener();
}

function update(id: string, patch: Partial<Session>): void {
  const current = sessions.get(id);
  if (!current) return;
  sessions.set(id, { ...current, ...patch });
  emit();
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getSession(id: string | null): Session | null {
  return id ? sessions.get(id) ?? null : null;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React binding. Returns `null` until a session with this id exists. */
export function useSession(id: string | null): Session | null {
  return useSyncExternalStore(
    subscribe,
    () => getSession(id),
    () => null,
  );
}

/* ------------------------------- lifecycle -------------------------------- */

export function startUpload(file: File): string {
  const id = newId();
  sessions.set(id, {
    id,
    fileName: file.name,
    fileSize: file.size,
    phase: 'uploading',
    stage: 'uploading',
    progress: 0,
    uploadedBytes: 0,
    jobId: null,
    fileId: null,
    job: null,
    error: null,
    startedAt: Date.now(),
  });
  emit();

  const handle = uploadFile(file, (loaded, total) => {
    update(id, { uploadedBytes: loaded, progress: total > 0 ? Math.round((loaded / total) * 100) : -1 });
  });
  uploads.set(id, handle);

  handle.promise.then(
    (response) => {
      uploads.delete(id);
      const session = sessions.get(id);
      if (!session || session.phase === 'cancelled') return;
      update(id, {
        phase: 'processing',
        stage: response.job.stage,
        progress: response.job.progress,
        jobId: response.jobId,
        fileId: response.fileId,
        job: response.job,
        uploadedBytes: session.fileSize,
      });
      poll(id, response.jobId);
    },
    (err: unknown) => {
      uploads.delete(id);
      const session = sessions.get(id);
      if (!session || session.phase === 'cancelled') return;
      const info =
        err instanceof ApiError
          ? err.info
          : { code: 'upload_failed', message: "We couldn't upload this file.", retryable: true };
      update(id, { phase: info.code === 'cancelled' ? 'cancelled' : 'error', error: info });
    },
  );

  return id;
}

/** Rebuild a session for a job that already exists (page reload, shared link). */
export function attachToJob(jobId: string): string {
  for (const session of sessions.values()) {
    if (session.jobId === jobId) return session.id;
  }
  const id = newId();
  sessions.set(id, {
    id,
    fileName: 'Document',
    fileSize: 0,
    phase: 'processing',
    stage: 'detecting',
    progress: -1,
    uploadedBytes: 0,
    jobId,
    fileId: null,
    job: null,
    error: null,
    startedAt: Date.now(),
  });
  emit();
  poll(id, jobId);
  return id;
}

function poll(id: string, jobId: string): void {
  const existing = pollers.get(id);
  if (existing) clearTimeout(existing);

  const tick = async () => {
    const session = sessions.get(id);
    if (!session || session.phase === 'cancelled' || session.phase === 'error') return;

    let job: JobState;
    try {
      job = await getJob(jobId);
    } catch (err) {
      const info =
        err instanceof ApiError
          ? err.info
          : { code: 'network_error', message: "We lost contact with the document service.", retryable: true };
      update(id, { phase: 'error', error: info });
      return;
    }

    const patch: Partial<Session> = {
      job,
      stage: job.stage,
      progress: job.progress,
      fileId: job.fileId,
      fileName: job.fileName || session.fileName,
      fileSize: job.size || session.fileSize,
    };

    if (job.status === 'succeeded') {
      update(id, { ...patch, phase: 'ready', stage: 'ready', progress: 100 });
      return;
    }
    if (job.status === 'failed') {
      update(id, {
        ...patch,
        phase: 'error',
        error: job.error ?? { code: 'processing_failed', message: "We couldn't process this file.", retryable: true },
      });
      return;
    }
    if (job.status === 'cancelled') {
      update(id, { ...patch, phase: 'cancelled' });
      return;
    }

    update(id, patch);
    pollers.set(id, setTimeout(tick, POLL_INTERVAL_MS));
  };

  pollers.set(id, setTimeout(tick, 0));
}

export function cancelSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;

  uploads.get(id)?.abort();
  uploads.delete(id);
  const poller = pollers.get(id);
  if (poller) clearTimeout(poller);
  pollers.delete(id);

  if (session.jobId) void cancelJob(session.jobId).catch(() => undefined);
  update(id, { phase: 'cancelled', error: null });
}

/**
 * The viewer marks the document as fully open once its own loading finished,
 * which is later than the server's "ready".
 */
export function markViewerStage(id: string, stage: JobStage, progress: number): void {
  const session = sessions.get(id);
  if (!session || session.phase !== 'ready') return;
  update(id, { stage, progress });
}

export function forgetSession(id: string): void {
  const poller = pollers.get(id);
  if (poller) clearTimeout(poller);
  pollers.delete(id);
  uploads.delete(id);
  sessions.delete(id);
  emit();
}
