import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * The access code, enforced on the API.
 *
 * The launcher sets DOCUVIEW_ACCESS_CODE when DocuView is opened to other
 * devices. Pages are gated by the web app; API calls are checked here, because
 * they reach the API through the web app's proxy carrying the browser's
 * cookie — and because Next.js middleware cannot see large upload bodies.
 *
 * Calls made on the machine itself — the launcher's health check, the model
 * check tool — come straight from loopback without passing the proxy, and are
 * trusted: nothing outside this computer can produce one.
 */

const COOKIE = 'dv_access';

export function normaliseCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

/** Must match apps/web/src/lib/access.ts. */
export function accessToken(code: string): string {
  return createHmac('sha256', 'docuview-access-v1').update(normaliseCode(code)).digest('hex');
}

function cookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return undefined;
}

function fromThisMachine(req: Request): boolean {
  const address = req.socket.remoteAddress ?? '';
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  // The web app's proxy is on loopback too, but it always says who it forwards.
  return loopback && req.headers['x-forwarded-for'] === undefined && req.headers['x-forwarded-host'] === undefined;
}

export function accessGate(code = process.env.DOCUVIEW_ACCESS_CODE) {
  const normalised = normaliseCode(code ?? '');
  const expected = normalised ? Buffer.from(accessToken(normalised)) : null;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!expected || fromThisMachine(req)) {
      next();
      return;
    }
    const given = Buffer.from(cookie(req.headers.cookie, COOKIE) ?? '');
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      next();
      return;
    }
    res.status(401).json({
      error: { code: 'access_required', message: 'Enter the access code to use DocuView.', retryable: false },
    });
  };
}
