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
    const timers: ReturnType<typeof setTimeout>[] = [];
    let cancelled = false;

    for (const component of components) {
      if (!component.jobId || component.status !== 'pending' || watched.current.has(component.jobId)) continue;
      const jobId = component.jobId;
      const name = component.name;
      watched.current.add(jobId);

      const tick = async (): Promise<void> => {
        if (cancelled) return;
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
        if (cancelled) return;

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
        timers.push(setTimeout(tick, POLL_INTERVAL_MS));
      };

      timers.push(setTimeout(tick, 0));
    }

    return () => {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [components, patch]);

  /* ---------------------------- accept new files -------------------------- */

  const add = useCallback(
    async (files: File[]): Promise<void> => {
      if (!parentJobId) return;
      setRejected(null);

      for (const file of files) {
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
