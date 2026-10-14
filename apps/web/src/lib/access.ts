import { createHmac } from 'node:crypto';

/**
 * The access code that guards DocuView once it is reachable from other
 * devices. The API enforces it (apps/api/src/access.ts); this side only signs
 * a browser in. There is deliberately no Next.js middleware: with one present,
 * Next buffers every request body and cuts uploads off at 10 MB. Set by the launcher (DOCUVIEW_ACCESS_CODE) only when the app is
 * opened to the network or the internet; on the local machine there is none.
 *
 * The browser keeps a token derived from the code, never the code itself.
 */
export const ACCESS_COOKIE = 'dv_access';
export const ACCESS_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Codes are shown as XXXX-XXXX; spacing, dashes and case never matter. */
export function normaliseCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

export function accessCode(): string | null {
  const code = normaliseCode(process.env.DOCUVIEW_ACCESS_CODE ?? '');
  return code ? code : null;
}

/** Must match apps/api/src/access.ts — the API checks the same cookie. */
export function accessToken(code: string): string {
  return createHmac('sha256', 'docuview-access-v1').update(normaliseCode(code)).digest('hex');
}

/** Only ever send people back to a page of this site. */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/access')) return '/';
  return value;
}
