'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssemblyState, ComponentStatus, JobError, JobResult, JobState } from '@docuview/shared';
import { ApiError, getJob, uploadComponent } from './api';

/**
 * Component resolution for an assembly, on the browser side.
 *
 * An assembly file names the parts it is built from but does not contain them.
 * This hook holds that list, accepts the files as the user supplies them, and
 * watches each component's own job — so the viewer can draw every part the
 * moment it is ready rather than waiting for the whole set.
 */

export interface ComponentView {
  /** File name the assembly asked for. */
  name: string;
  status: ComponentStatus;
  jobId: string | null;
  fileId: string | null;
  /** 0..100 while the file is being sent. */
  uploaded: number;
  /** Set once the component's job finished; this is what the scene loads. */
  result: JobResult | null;
  error: JobError | null;
}

/** A component whose geometry can actually go into the 3D scene. */
export interface RenderableComponent {
  id: string;
  name: string;
  source: string;
  mode: 'nmg' | 'mesh';
  formatId: string;
}

const POLL_INTERVAL_MS = 400;

function seed(assembly: AssemblyState | null): ComponentView[] {
  if (!assembly) return [];
  return assembly.components.map((component) => ({
    name: component.name,
    status: component.status,
    jobId: component.jobId,
    fileId: component.fileId,
    uploaded: component.status === 'missing' ? 0 : 100,
    result: null,
    error: null,
  }));
}

export function useAssembly(parentJobId: string | null, assembly: AssemblyState | null) {
  const [components, setComponents] = useState<ComponentView[]>(() => seed(assembly));
  const [rejected, setRejected] = useState<{ name: string; message: string } | null>(null);
  const watched = useRef(new Set<string>());
  // Polls outlive re-renders: every result that arrives changes the list, and
  // cancelling the rest each time would drop answers already on their way —
  // with a folder of parts arriving at once, most of them. They stop only
  // when the document closes.
  const alive = useRef(true);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    alive.current = true;
    const pending = timers.current;
    return () => {
      alive.current = false;
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  // Re-seed when a different document is opened, but never clobber components
  // the user has already supplied in this session.
  const signature = assembly?.components.map((c) => c.name).join('|') ?? '';
  useEffect(() => {
    setComponents((current) => (current.length > 0 ? current : seed(assembly)));
    // `signature` stands in for the assembly identity; `assembly` itself is a
    // fresh object on every poll and would restart this on each tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const patch = useCallback((name: string, changes: Partial<ComponentView>) => {
    setComponents((current) =>
      current.map((component) => (component.name === name ? { ...component, ...changes } : component)),
    );
  }, []);

  /* ------------------------- watch component jobs ------------------------- */

  useEffect(() => {
    const schedule = (run: () => void, ms: number) => {
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        run();
      }, ms);
      timers.current.add(timer);
    };

    for (const component of components) {
      // Pending ones until they finish; ready ones reopened from the server
      // (a reload, a shared link) once, for the result the scene needs.
      const waiting = component.status === 'pending' || (component.status === 'ready' && !component.result);
      if (!component.jobId || !waiting || watched.current.has(component.jobId)) continue;
      const jobId = component.jobId;
      const name = component.name;
      watched.current.add(jobId);

      const tick = async (): Promise<void> => {
        if (!alive.current) return;
        let job: JobState;
        try {
          job = await getJob(jobId);
        } catch (err) {
          patch(name, {
            status: 'failed',
            error:
              err instanceof ApiError
                ? err.info
                : { code: 'network_error', message: 'We lost contact with the document service.', retryable: true },
          });
          return;
        }
        if (!alive.current) return;

        if (job.status === 'succeeded') {
          patch(name, { status: 'ready', result: job.result, error: null });
          return;
        }
        if (job.status === 'failed' || job.status === 'cancelled') {
          patch(name, {
            status: 'failed',
            error: job.error ?? { code: 'component_failed', message: "We couldn't open this component.", retryable: true },
          });
          return;
        }
        schedule(() => void tick(), POLL_INTERVAL_MS);
      };

      schedule(() => void tick(), 0);
    }
  }, [components, patch]);

  /* ---------------------------- accept new files -------------------------- */

  const add = useCallback(
    async (files: File[]): Promise<void> => {
      if (!parentJobId) return;
      setRejected(null);

      // A whole folder can be dropped: send only the files the assembly asks
      // for, once each, and none it already has. A file it does not name is
      // sent only when nothing else matched — the user may know better.
      const state = new Map(components.map((c) => [c.name.toLowerCase(), c.status]));
      const seen = new Set<string>();
      const named = files.filter((file) => {
        const key = file.name.toLowerCase();
        if (!state.has(key) || seen.has(key)) return false;
        seen.add(key);
        const status = state.get(key);
        return status === 'missing' || status === 'failed';
      });
      const anyNamed = files.some((file) => state.has(file.name.toLowerCase()));
      const toSend = state.size > 0 && anyNamed ? named : files;

      for (const file of toSend) {
        // Show the row as busy straight away, adding it if the assembly did not
        // name this file — the user knows their own model better than our scan.
        setComponents((current) => {
          const index = current.findIndex((component) => component.name.toLowerCase() === file.name.toLowerCase());
          const entry: ComponentView = {
            name: index >= 0 ? current[index].name : file.name,
            status: 'pending',
            jobId: null,
            fileId: null,
            uploaded: 0,
            result: null,
            error: null,
          };
          if (index < 0) return [...current, entry];
          const next = [...current];
          next[index] = entry;
          return next;
        });

        const target = components.find((c) => c.name.toLowerCase() === file.name.toLowerCase())?.name ?? file.name;
        try {
          const response = await uploadComponent(parentJobId, file, (loaded, total) => {
            patch(target, { uploaded: total > 0 ? Math.round((loaded / total) * 100) : 0 });
          }).promise;
          patch(target, { jobId: response.jobId, fileId: response.fileId, status: 'pending', uploaded: 100 });
        } catch (err) {
          const info =
            err instanceof ApiError
              ? err.info
              : { code: 'upload_failed', message: "We couldn't send this component.", retryable: true };
          patch(target, { status: 'failed', error: info });
          setRejected({ name: file.name, message: info.message });
        }
      }
    },
    [components, parentJobId, patch],
  );

  /* ---------------------- what the scene can actually show ---------------- */

  const renderable = useMemo<RenderableComponent[]>(() => {
    const sources: RenderableComponent[] = [];
    for (const component of components) {
      const result = component.result;
      if (component.status !== 'ready' || !result) continue;
      if (result.viewer !== 'cad-nmg' && result.viewer !== 'cad-mesh') continue;
      sources.push({
        id: component.jobId ?? component.name,
        name: component.name,
        source: result.source,
        mode: result.viewer === 'cad-nmg' ? 'nmg' : 'mesh',
        formatId: typeof result.meta.formatId === 'string' ? result.meta.formatId : 'stl',
      });
    }
    return sources;
  }, [components]);

  const counts = useMemo(() => {
    const tally = { missing: 0, pending: 0, ready: 0, failed: 0 };
    for (const component of components) tally[component.status] += 1;
    return tally;
  }, [components]);

  return { components, renderable, counts, add, rejected, dismissRejected: () => setRejected(null) };
}
