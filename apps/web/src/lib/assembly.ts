'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bestLocated, type AssemblyState, type ComponentStatus, type JobError, type JobResult, type JobState } from '@docuview/shared';
import { ApiError, getJob, uploadComponent } from './api';
import { pathOf, recordedLocation } from './open';

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
  /** Where SolidWorks had the file when the assembly was saved. */
  originalPath: string | null;
}

/** Where the assembly itself was: recorded by SolidWorks, and inside what was dropped. */
export interface AssemblyPlace {
  recorded: string | null;
  here: string | null;
}

/** A component whose geometry can actually go into the 3D scene. */
export interface RenderableComponent {
  id: string;
  name: string;
  source: string;
  mode: 'nmg' | 'mesh';
  formatId: string;
  /**
   * Geometry of the other configurations the assembly uses, by name. The part
   * as saved is `source`; a configuration missing here is drawn as that.
   */
  configurations: Record<string, string>;
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
    originalPath: component.originalPath ?? null,
  }));
}

export function useAssembly(
  parentJobId: string | null,
  assembly: AssemblyState | null,
  place: AssemblyPlace = { recorded: null, here: null },
) {
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

  // Take in what the server knows — components sent from elsewhere (files
  // dropped on the window, another tab) — without clobbering the ones this
  // panel is sending or has already opened.
  const signature = assembly?.components.map((c) => `${c.name}:${c.jobId ?? ''}`).join('|') ?? '';
  useEffect(() => {
    setComponents((current) => {
      if (current.length === 0) return seed(assembly);
      if (!assembly) return current;
      let changed = false;
      const next = current.map((local) => {
        const remote = assembly.components.find((c) => c.name.toLowerCase() === local.name.toLowerCase());
        const newer = remote?.jobId && remote.jobId !== local.jobId && (local.status === 'missing' || local.status === 'failed');
        if (!remote || !newer) return local;
        changed = true;
        // Pending until its own job says otherwise; a ready one is fetched.
        return {
          ...local,
          status: remote.status === 'ready' ? ('ready' as const) : ('pending' as const),
          jobId: remote.jobId,
          fileId: remote.fileId,
          uploaded: 100,
          result: null,
          error: null,
        };
      });
      for (const remote of assembly.components) {
        if (current.some((local) => local.name.toLowerCase() === remote.name.toLowerCase())) continue;
        next.push(...seed({ ...assembly, components: [remote] }));
        changed = true;
      }
      return changed ? next : current;
    });
    // `signature` stands in for the assembly's content; `assembly` itself is a
    // fresh object on every poll and would restart this on each tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const patch = useCallback((name: string, changes: Partial<ComponentView>) => {
    setComponents((current) =>
      current.map((component) => (component.name === name ? { ...component, ...changes } : component)),
    );
  }, []);

  /* ------------------------- watch component jobs ------------------------- */

  // A folder of parts is dozens of jobs at once; each asks less often then, so
  // together they stay within what the server answers.
  const preparing = useRef(0);
  preparing.current = components.filter((c) => c.status === 'pending').length;

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
        schedule(() => void tick(), POLL_INTERVAL_MS * Math.max(1, Math.ceil(preparing.current / 4)));
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
      // for, once each, and none it already has. Of two files with the same
      // name the one where the assembly had it is taken. A file it does not
      // name is sent only when nothing else matched — the user may know better.
      const state = new Map(components.map((c) => [c.name.toLowerCase(), c]));
      const copies = new Map<string, File[]>();
      for (const file of files) {
        const key = file.name.toLowerCase();
        const component = state.get(key);
        if (!component || (component.status !== 'missing' && component.status !== 'failed')) continue;
        copies.set(key, [...(copies.get(key) ?? []), file]);
      }
      const named = [...copies.entries()].map(([key, found]) => {
        const where = recordedLocation(state.get(key)?.originalPath, place.recorded, place.here);
        return (where ? bestLocated(found, pathOf, where) : undefined) ?? found[0];
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
            originalPath: index >= 0 ? current[index].originalPath : null,
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
    [components, parentJobId, patch, place.here, place.recorded],
  );

  /* ---------------------- what the scene can actually show ---------------- */

  const renderable = useMemo<RenderableComponent[]>(() => {
    const sources: RenderableComponent[] = [];
    for (const component of components) {
      const result = component.result;
      if (component.status !== 'ready' || !result) continue;
      if (result.viewer !== 'cad-nmg' && result.viewer !== 'cad-mesh') continue;
      const configurations: Record<string, string> = {};
      const listed = result.meta.configurations;
      if (listed && typeof listed === 'object') {
        for (const [name, url] of Object.entries(listed as Record<string, unknown>)) {
          if (typeof url === 'string') configurations[name] = url;
        }
      }
      sources.push({
        id: component.jobId ?? component.name,
        name: component.name,
        source: result.source,
        mode: result.viewer === 'cad-nmg' ? 'nmg' : 'mesh',
        formatId: typeof result.meta.formatId === 'string' ? result.meta.formatId : 'stl',
        configurations,
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
