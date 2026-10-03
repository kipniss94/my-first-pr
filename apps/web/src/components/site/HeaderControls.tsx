'use client';

import { useLang, useT, useTheme } from '@/lib/prefs';

/**
 * Theme and language, top right of every header. Two small buttons: the
 * theme one shows where it leads (a sun in the dark, a moon in the light);
 * the language one shows the two choices with the current one lit.
 */
export function HeaderControls({ className = '' }: { className?: string }) {
  const [theme, setTheme] = useTheme();
  const [lang, setLang] = useLang();
  const { t } = useT();
  const toLight = theme === 'dark';

  return (
    <div className={`flex shrink-0 items-center gap-1 ${className}`}>
      <button
        type="button"
        className="btn-icon"
        onClick={() => setTheme(toLight ? 'light' : 'dark')}
        title={t(toLight ? 'Switch to the light theme' : 'Switch to the dark theme')}
        aria-label={t(toLight ? 'Switch to the light theme' : 'Switch to the dark theme')}
        data-testid="theme-toggle"
        data-theme-now={theme}
      >
        {toLight ? (
          <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <circle cx="10" cy="10" r="3.4" />
            <path
              d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7l1.3 1.3M14 14l1.3 1.3M4.7 15.3 6 14M14 6l1.3-1.3"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M15.5 12.3A6.2 6.2 0 0 1 7.7 4.5a6.2 6.2 0 1 0 7.8 7.8Z" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      <div
        role="group"
        aria-label={t('Interface language')}
        className="flex items-center rounded-lg border border-line bg-ink-800 p-0.5"
        data-testid="lang-toggle"
      >
        {(['en', 'ru'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setLang(option)}
            aria-pressed={lang === option}
            title={t(option === 'en' ? 'Switch the interface to English' : 'Switch the interface to Russian')}
            data-testid={`lang-${option}`}
            className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
              lang === option ? 'bg-ink-600 text-mist-100' : 'text-mist-500 hover:text-mist-200'
            }`}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}
