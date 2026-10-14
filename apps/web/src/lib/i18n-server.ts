import { fill, lookup, pluralIn, type Params } from './i18n-core';
import { serverLang } from './server-lang';

/** `useT()` for server components: the same dictionary, the language from the request. */
export async function serverT() {
  const lang = await serverLang();
  return {
    lang,
    t: (text: string, params?: Params) => fill(lookup(lang, text), params),
    tp: (n: number, en: [string, string], ru: [string, string, string], params?: Params) => pluralIn(lang, n, en, ru, params),
  };
}
