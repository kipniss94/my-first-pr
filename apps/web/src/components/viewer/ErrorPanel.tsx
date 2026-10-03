'use client';

import Link from 'next/link';
import type { JobError } from '@docuview/shared';
import { useT } from '@/lib/prefs';

interface ErrorPanelProps {
  error: JobError;
  fileName?: string;
  onRetry?: () => void;
}

/**
 * The only error surface the user ever sees.
 *
 * Everything here is a sentence plus a next step. Codes, stack traces and
 * library names stay in the server log; the code is shown only as a small
 * reference so a support conversation has something to anchor on.
 */
export function ErrorPanel({ error, fileName, onRetry }: ErrorPanelProps) {
  const { t } = useT();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-md text-center" role="alert" data-testid="error-panel">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-danger/40 bg-danger/10">
          <svg viewBox="0 0 24 24" className="h-6 w-6 text-danger" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M12 8.5v4.2M12 16.2v.4" strokeLinecap="round" />
            <path d="M10.3 4.3 2.9 17.2A1.9 1.9 0 0 0 4.6 20h14.8a1.9 1.9 0 0 0 1.7-2.8L13.7 4.3a1.9 1.9 0 0 0-3.4 0Z" strokeLinejoin="round" />
          </svg>
        </div>

        <h2 className="mt-5 text-lg font-semibold tracking-tight text-mist-100">{t(error.message)}</h2>
        {error.hint && <p className="mt-2.5 text-sm leading-relaxed text-mist-400">{t(error.hint)}</p>}
        {fileName && <p className="mt-3 truncate font-mono text-xs text-mist-500">{fileName}</p>}

        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          {error.retryable && onRetry && (
            <button type="button" onClick={onRetry} className="btn btn-subtle">
              {t('Try again')}
            </button>
          )}
          <Link href="/" className="btn btn-primary">
            {t('Upload another file')}
          </Link>
        </div>

        <p className="mt-6 font-mono text-[11px] uppercase tracking-widest text-mist-500">
          {t('reference')}: {error.code}
        </p>
      </div>
    </div>
  );
}

/** Compact inline variant for failures inside an already-open viewer. */
export function InlineError({ message, hint }: { message: string; hint?: string }) {
  const { t } = useT();
  return (
    <div role="alert" className="m-4 rounded-xl border border-danger/35 bg-danger/10 px-4 py-3">
      <p className="text-sm font-medium text-mist-100">{t(message)}</p>
      {hint && <p className="mt-1 text-[13px] leading-relaxed text-mist-400">{t(hint)}</p>}
    </div>
  );
}

/** Non-fatal notes from the pipeline: shown, dismissible, never blocking. */
export function WarningList({ warnings, onDismiss }: { warnings: string[]; onDismiss?: () => void }) {
  const { t } = useT();
  if (warnings.length === 0) return null;
  return (
    <div className="border-b border-warn/25 bg-warn/8 px-4 py-2.5" data-testid="warnings">
      <div className="flex items-start gap-3">
        <svg viewBox="0 0 16 16" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 4.8v4M8 10.9v.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <ul className="min-w-0 flex-1 space-y-1">
          {warnings.map((warning) => (
            <li key={warning} className="text-[13px] leading-relaxed text-mist-300">
              {t(warning)}
            </li>
          ))}
        </ul>
        {onDismiss && (
          <button type="button" onClick={onDismiss} className="btn-icon shrink-0" aria-label={t('Dismiss notices')}>
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
