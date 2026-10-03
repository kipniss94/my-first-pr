'use client';

import { createContext, Fragment, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { RU, RU_PATTERNS } from './i18n-ru';
import { LANG_COOKIE, THEME_COOKIE, type Lang, type Theme } from './prefs-keys';

export type { Lang, Theme } from './prefs-keys';

/**
 * The visitor's two preferences: interface language and colour theme.
 *
 * Both live in cookies so the server renders the page the way it will stay —
 * no flash of the dark theme before the light one, no English text swapped
 * for Russian after hydration. The root layout reads the cookies and hands
 * them to `PrefsProvider`; the toggles write them back.
 */

export type Params = Record<string, string | number>;

/*
 * Code outside React (the 3D scene's labels) reads the language here. It is
 * set from the provider on every render, which on the client is the only
 * place it changes.
 */
let currentLang: Lang = 'en';
let currentTheme: Theme = 'dark';
const themeListeners = new Set<(theme: Theme) => void>();

function fill(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in params ? String(params[key]) : whole));
}

function lookup(lang: Lang, text: string): string {
  if (lang !== 'ru') return text;
  const exact = RU[text];
  if (exact !== undefined) return exact;
  // Messages with a name or a number in them (often from the server).
  for (const [pattern, replacement] of RU_PATTERNS) {
    if (pattern.test(text)) return text.replace(pattern, replacement);
  }
  return text;
}

/** A translated template with React nodes (a highlighted name, a link) in its placeholders. */
function interleave(text: string, nodes: Record<string, ReactNode>): ReactNode {
  const parts = text.split(/\{(\w+)\}/);
  return parts.map((part, index) =>
    index % 2 === 1 ? <Fragment key={index}>{part in nodes ? nodes[part] : `{${part}}`}</Fragment> : part,
  );
}

/** Russian plural form: 1 файл, 2 файла, 5 файлов, 21 файл. */
function russianForm(n: number): 0 | 1 | 2 {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return 2;
  if (last === 1) return 0;
  if (last >= 2 && last <= 4) return 1;
  return 2;
}

function pluralIn(lang: Lang, n: number, en: [string, string], ru: [string, string, string], params?: Params): string {
  const text = lang === 'ru' ? ru[russianForm(n)] : en[n === 1 ? 0 : 1];
  return fill(text, { n, ...params });
}

/** Translate outside React. */
export function translate(text: string, params?: Params): string {
  return fill(lookup(currentLang, text), params);
}

export function translatePlural(n: number, en: [string, string], ru: [string, string, string], params?: Params): string {
  return pluralIn(currentLang, n, en, ru, params);
}

export function currentLanguage(): Lang {
  return currentLang;
}

export function currentThemeName(): Theme {
  return currentTheme;
}

/** Called with the new theme whenever it changes (the 3D scene repaints its background). */
export function onThemeChange(listener: (theme: Theme) => void): () => void {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

function writeCookie(name: string, value: string): void {
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
}

interface PrefsValue {
  lang: Lang;
  theme: Theme;
  setLang(lang: Lang): void;
  setTheme(theme: Theme): void;
}

const PrefsContext = createContext<PrefsValue | null>(null);

export function PrefsProvider({ lang, theme, children }: { lang: Lang; theme: Theme; children: React.ReactNode }) {
  const [state, setState] = useState({ lang, theme });
  currentLang = state.lang;
  currentTheme = state.theme;

  const setLang = useCallback((next: Lang) => {
    writeCookie(LANG_COOKIE, next);
    document.documentElement.lang = next;
    currentLang = next;
    setState((current) => ({ ...current, lang: next }));
  }, []);

  const setTheme = useCallback((next: Theme) => {
    writeCookie(THEME_COOKIE, next);
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    currentTheme = next;
    setState((current) => ({ ...current, theme: next }));
    for (const listener of themeListeners) listener(next);
  }, []);

  const value = useMemo(() => ({ ...state, setLang, setTheme }), [setLang, setTheme, state]);
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

function usePrefs(): PrefsValue {
  const value = useContext(PrefsContext);
  if (!value) {
    // Outside the provider (a test harness): English, dark, and no switching.
    return { lang: 'en', theme: 'dark', setLang: () => undefined, setTheme: () => undefined };
  }
  return value;
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const { theme, setTheme } = usePrefs();
  return [theme, setTheme];
}

export function useLang(): [Lang, (lang: Lang) => void] {
  const { lang, setLang } = usePrefs();
  return [lang, setLang];
}

export interface Translator {
  lang: Lang;
  /** The text in the interface language; `{name}` placeholders are filled from `params`. */
  t(text: string, params?: Params): string;
  /** A counted phrase: English one/other, Russian one/few/many; `{n}` is the count. */
  tp(n: number, en: [string, string], ru: [string, string, string], params?: Params): string;
  /** Like `t`, with React nodes in the placeholders. */
  tx(text: string, nodes: Record<string, ReactNode>): ReactNode;
}

export function useT(): Translator {
  const { lang } = usePrefs();
  return useMemo(
    () => ({
      lang,
      t: (text: string, params?: Params) => fill(lookup(lang, text), params),
      tp: (n: number, en: [string, string], ru: [string, string, string], params?: Params) =>
        pluralIn(lang, n, en, ru, params),
      tx: (text: string, nodes: Record<string, ReactNode>) => interleave(lookup(lang, text), nodes),
    }),
    [lang],
  );
}
