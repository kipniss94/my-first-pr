'use client';

import { JOB_STAGES, type JobStage } from '@docuview/shared';
import { formatBytes } from '@/lib/format';
import type { Session } from '@/lib/session';

const STAGE_COPY: Record<JobStage, { label: string; detail: string }> = {
  uploading: { label: 'Uploading', detail: 'Sending the file to the document service' },
  detecting: { label: 'Identifying', detail: 'Reading the file signature to work out what it is' },
  processing: { label: 'Processing', detail: 'Converting the document with the matching engine' },
  'preparing-geometry': { label: 'Preparing geometry', detail: 'Normalising the model for the browser' },
  'loading-viewer': { label: 'Loading viewer', detail: 'Fetching the viewer and the prepared document' },
  ready: { label: 'Ready', detail: 'Done' },
};

/**
 * The staged progress rail.
 *
 * Named stages beat a single indeterminate bar: when something takes a while,
 * the user can see *what* is taking a while, and the perceived wait drops.
 */
export function StageRail({ session, onCancel }: { session: Session; onCancel: () => void }) {
  const stages = JOB_STAGES.filter((stage) => stage !== 'ready');
  const currentIndex = stages.indexOf(session.stage as (typeof stages)[number]);
  const activeIndex = currentIndex === -1 ? stages.length : currentIndex;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-md" data-testid="stage-rail">
        <p className="truncate text-center text-[15px] font-medium text-mist-100" title={session.fileName}>
          {session.fileName}
        </p>
        <p className="mt-1 text-center text-xs text-mist-500">
          {session.fileSize > 0 ? formatBytes(session.fileSize) : 'Preparing'}
          {session.stage === 'uploading' && session.fileSize > 0 && (
            <> · {formatBytes(session.uploadedBytes)} sent</>
          )}
        </p>

        <ol className="mt-8 space-y-1">
          {stages.map((stage, index) => {
            const state = index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'todo';
            const copy = STAGE_COPY[stage];
            return (
              <li key={stage} className="flex items-start gap-3 rounded-lg px-2 py-2" data-stage={stage} data-state={state}>
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center">
                  {state === 'done' && (
                    <svg viewBox="0 0 20 20" className="h-4 w-4 text-ok" aria-hidden="true">
                      <path d="M4.5 10.5 8 14l7.5-8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                  {state === 'active' && (
                    <span className="relative flex h-3 w-3">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
                      <span className="relative inline-flex h-3 w-3 rounded-full bg-accent" />
                    </span>
                  )}
                  {state === 'todo' && <span className="h-1.5 w-1.5 rounded-full bg-ink-600" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={`block text-sm font-medium ${
                      state === 'todo' ? 'text-mist-500' : state === 'active' ? 'text-mist-100' : 'text-mist-300'
                    }`}
                  >
                    {copy.label}
                  </span>
                  {state === 'active' && <span className="mt-0.5 block text-xs text-mist-400">{copy.detail}</span>}
                </span>
                {state === 'active' && session.progress >= 0 && (
                  <span className="font-mono text-xs tabular-nums text-mist-400">{session.progress}%</span>
                )}
              </li>
            );
          })}
        </ol>

        <div className="mt-6 h-1 overflow-hidden rounded-full bg-ink-700">
          <div
            className="h-full rounded-full bg-linear-to-r from-accent to-cyan transition-[width] duration-300 ease-out"
            style={{
              width:
                session.progress >= 0
                  ? `${Math.min(100, ((activeIndex + session.progress / 100) / stages.length) * 100)}%`
                  : `${((activeIndex + 0.5) / stages.length) * 100}%`,
            }}
          />
        </div>

        <div className="mt-6 text-center">
          <button type="button" onClick={onCancel} className="btn btn-ghost">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
