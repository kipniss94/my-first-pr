import { RU, RU_PATTERNS } from './i18n-ru';
import type { Lang } from './prefs-keys';

/** Translation shared by the browser (`useT`) and server-rendered pages (`serverT`). */

export type Params = Record<string, string | number>;

export function fill(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in params ? String(params[key]) : whole));
}

export function lookup(lang: Lang, text: string): string {
  if (lang !== 'ru') return text;
  const exact = RU[text];
  if (exact !== undefined) return exact;
  // Messages with a name or a number in them (often from the server).
  for (const [pattern, replacement] of RU_PATTERNS) {
    if (pattern.test(text)) return text.replace(pattern, replacement);
  }
  return text;
}

/** Russian plural form: 1 файл, 2 файла, 5 файлов, 21 файл. */
export function russianForm(n: number): 0 | 1 | 2 {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return 2;
  if (last === 1) return 0;
  if (last >= 2 && last <= 4) return 1;
  return 2;
}

export function pluralIn(lang: Lang, n: number, en: [string, string], ru: [string, string, string], params?: Params): string {
  const text = lang === 'ru' ? ru[russianForm(n)] : en[n === 1 ? 0 : 1];
  return fill(text, { n, ...params });
}
