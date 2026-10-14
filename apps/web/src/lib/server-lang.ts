import { cookies, headers } from 'next/headers';
import { LANG_COOKIE, THEME_COOKIE, type Lang, type Theme } from './prefs-keys';

/**
 * The visitor's language and theme on the server: the cookies the toggles
 * write; with no language chosen yet, the browser's Accept-Language decides.
 */
export async function serverLang(): Promise<Lang> {
  const chosen = (await cookies()).get(LANG_COOKIE)?.value;
  if (chosen === 'ru' || chosen === 'en') return chosen;
  return /^ru/i.test((await headers()).get('accept-language') ?? '') ? 'ru' : 'en';
}

export async function serverTheme(): Promise<Theme> {
  return (await cookies()).get(THEME_COOKIE)?.value === 'light' ? 'light' : 'dark';
}
