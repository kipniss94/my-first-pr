import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE, ACCESS_MAX_AGE_SECONDS, accessCode, accessToken, normaliseCode, safeNext } from '@/lib/access';

export const runtime = 'nodejs';

/**
 * A wrong guess costs time. Ten tries per address per ten minutes makes the
 * code — eight characters from a 32-letter alphabet — impractical to guess
 * even over a public link.
 */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_TRIES = 10;
const tries = new Map<string, { count: number; since: number }>();

/**
 * A redirect within this site, by path. Behind the gateway or a tunnel the
 * web app sees its own internal address, so an absolute URL built from the
 * request would send a phone to 127.0.0.1. A relative Location is valid HTTP
 * and always lands on the address the visitor actually used.
 */
function go(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: path } });
}

function clientAddress(request: NextRequest): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'local'
  );
}

/**
 * The link in the QR code and the one the launcher opens carry the code, so a
 * phone that scans it — or the computer running DocuView — goes straight in.
 * Whoever holds that link holds the code, which is why it is only ever shown
 * on the screen of the computer running DocuView.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  return check(request, params.get('code') ?? '', params.get('next') ?? '/');
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  return check(request, String(form.get('code') ?? ''), String(form.get('next') ?? '/'));
}

async function check(request: NextRequest, submitted: string, nextParam: string) {
  const next = safeNext(nextParam);
  const back = (error: string) => go(`/access?error=${error}&next=${encodeURIComponent(next)}`);

  const code = accessCode();
  if (!code) return go(next);

  const who = clientAddress(request);
  const now = Date.now();
  const record = tries.get(who);
  if (record && now - record.since < WINDOW_MS && record.count >= MAX_TRIES) return back('wait');

  const given = normaliseCode(submitted);
  if (given !== code) {
    tries.set(who, record && now - record.since < WINDOW_MS ? { count: record.count + 1, since: record.since } : { count: 1, since: now });
    return back('wrong');
  }

  tries.delete(who);
  const response = go(next);
  response.cookies.set(ACCESS_COOKIE, accessToken(code), {
    httpOnly: true,
    sameSite: 'lax',
    secure: request.headers.get('x-forwarded-proto') === 'https' || request.nextUrl.protocol === 'https:',
    maxAge: ACCESS_MAX_AGE_SECONDS,
    path: '/',
  });
  return response;
}
