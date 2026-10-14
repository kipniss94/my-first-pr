import type { AssemblyState, CapabilitiesResponse, JobError, JobState, UploadResponse } from '@docuview/shared';

/**
 * Empty by default: the browser calls `/api/v1/...` on its own origin and Next
 * proxies to the API service. Set `NEXT_PUBLIC_API_BASE` to bypass the proxy.
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

export function apiUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${API_BASE}${pathOrUrl}`;
}

const GENERIC_ERROR: JobError = {
  code: 'network_error',
  message: "We couldn't reach the document service.",
  hint: 'Check your connection and try again.',
  retryable: true,
};

export class ApiError extends Error {
  constructor(readonly info: JobError, readonly status = 0) {
    super(info.message);
    this.name = 'ApiError';
  }
}

async function readError(response: Response): Promise<JobError> {
  try {
    const body = (await response.json()) as { error?: JobError };
    if (body?.error?.message) return body.error;
  } catch {
    /* fall through to the generic message */
  }
  return {
    code: `http_${response.status}`,
    message: "We couldn't complete that request.",
    retryable: response.status >= 500,
  };
}

/**
 * Many documents open at once all poll, and a folder of parts is many uploads:
 * the server's request limits are reachable in normal use. A refused request
 * waits for the window the server names and goes again, this many times,
 * rather than turning into "we couldn't reach the service".
 */
const RATE_LIMIT_RETRIES = 30;

/** Milliseconds until the server takes requests again, from its rate-limit headers. */
function retryDelay(header: (name: string) => string | null): number {
  const reset = /reset=(\d+)/.exec(header('RateLimit') ?? '')?.[1] ?? header('Retry-After');
  const seconds = Number(reset);
  return Math.min(60, Math.max(1, Number.isFinite(seconds) && seconds > 0 ? seconds : 5)) * 1000 + 250;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `fetch` for anything the API serves, waiting out its rate limit. */
/**
 * When DocuView is opened to other devices the API asks for the access code.
 * The answer is the same wherever it surfaces — a page load, an upload, a
 * viewer fetching its file: go to the code page, then come back here.
 */
export function requireAccess(status: number, error: JobError | undefined | null): boolean {
  if (status !== 401 || error?.code !== 'access_required' || typeof window === 'undefined') return false;
  if (!window.location.pathname.startsWith('/access')) {
    const next = window.location.pathname + window.location.search;
    window.location.assign(`/access?next=${encodeURIComponent(next)}`);
  }
  return true;
}

export async function fetchApi(pathOrUrl: string, init?: RequestInit): Promise<Response> {
  for (let tries = 0; ; tries += 1) {
    const response = await fetch(apiUrl(pathOrUrl), init);
    if (response.status === 401) {
      const body = (await response.clone().json().catch(() => null)) as { error?: JobError } | null;
      requireAccess(401, body?.error);
    }
    if (response.status !== 429 || tries >= RATE_LIMIT_RETRIES || init?.signal?.aborted) return response;
    await pause(retryDelay((name) => response.headers.get(name)));
  }
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetchApi(path, { ...init, headers: { Accept: 'application/json', ...init?.headers } });
  } catch {
    throw new ApiError(GENERIC_ERROR);
  }
  if (!response.ok) throw new ApiError(await readError(response), response.status);
  return (await response.json()) as T;
}

export function getCapabilities(): Promise<CapabilitiesResponse> {
  return getJson<CapabilitiesResponse>('/api/v1/capabilities');
}

export function getJob(jobId: string): Promise<JobState> {
  return getJson<JobState>(`/api/v1/jobs/${jobId}`, { cache: 'no-store' });
}

export function cancelJob(jobId: string): Promise<{ cancelled: boolean }> {
  return getJson<{ cancelled: boolean }>(`/api/v1/jobs/${jobId}`, { method: 'DELETE' });
}

export function deleteFile(fileId: string): Promise<{ deleted: boolean }> {
  return getJson<{ deleted: boolean }>(`/api/v1/files/${fileId}`, { method: 'DELETE' });
}

export interface UploadHandle {
  promise: Promise<UploadResponse>;
  abort(): void;
}

/** What the server returns when an assembly component is supplied. */
export interface ComponentUploadResponse extends UploadResponse {
  assembly: AssemblyState;
}

/**
 * Send one component of an assembly. It becomes an ordinary job, so the viewer
 * can watch it and draw the part the moment it is ready.
 */
export function uploadComponent(
  parentJobId: string,
  file: File,
  onProgress: (loaded: number, total: number) => void = () => undefined,
): { promise: Promise<ComponentUploadResponse>; abort(): void } {
  const handle = uploadTo(`/api/v1/jobs/${parentJobId}/components`, file, onProgress);
  return { promise: handle.promise as Promise<ComponentUploadResponse>, abort: handle.abort };
}

/**
 * Uploads via XHR rather than `fetch` because upload progress events are the
 * only honest way to fill the "Uploading" stage — `fetch` cannot report them.
 */
export function uploadFile(file: File, onProgress: (loaded: number, total: number) => void): UploadHandle {
  return uploadTo('/api/v1/uploads', file, onProgress);
}

const CANCELLED: JobError = { code: 'cancelled', message: 'Upload cancelled.', retryable: true };

function uploadTo(path: string, file: File, onProgress: (loaded: number, total: number) => void): UploadHandle {
  let xhr: XMLHttpRequest | null = null;
  let aborted = false;
  let wake: (() => void) | null = null;

  const attempt = () =>
    new Promise<{ status: number; body: unknown; delay: number }>((resolve, reject) => {
      const request = new XMLHttpRequest();
      xhr = request;
      const form = new FormData();
      form.append('file', file, file.name);

      request.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress(event.loaded, event.total);
      });

      request.addEventListener('load', () => {
        // A refusal is retried whatever its body says — a proxy in between
        // may answer it in plain text.
        if (request.status === 429) {
          resolve({ status: 429, body: null, delay: retryDelay((name) => request.getResponseHeader(name)) });
          return;
        }
        let body: unknown;
        try {
          body = JSON.parse(request.responseText);
        } catch {
          reject(new ApiError(GENERIC_ERROR, request.status));
          return;
        }
        resolve({ status: request.status, body, delay: 0 });
      });

      request.addEventListener('error', () => reject(new ApiError(GENERIC_ERROR, request.status)));
      request.addEventListener('timeout', () =>
        reject(
          new ApiError({
            code: 'upload_timeout',
            message: 'The upload timed out.',
            hint: 'Check your connection and try again.',
            retryable: true,
          }),
        ),
      );
      request.addEventListener('abort', () => reject(new ApiError(CANCELLED)));

      request.open('POST', apiUrl(path));
      request.responseType = 'text';
      request.send(form);
    });

  const promise = (async (): Promise<UploadResponse> => {
    for (let tries = 0; ; tries += 1) {
      if (aborted) throw new ApiError(CANCELLED);
      const outcome = await attempt();
      if (outcome.status >= 200 && outcome.status < 300) return outcome.body as UploadResponse;
      if (outcome.status === 429 && tries < RATE_LIMIT_RETRIES) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, outcome.delay);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = null;
        continue;
      }
      const error = (outcome.body as { error?: JobError } | null)?.error;
      requireAccess(outcome.status, error);
      throw new ApiError(
        error ?? { code: `http_${outcome.status}`, message: "We couldn't upload this file.", retryable: true },
        outcome.status,
      );
    }
  })();

  return {
    promise,
    abort: () => {
      aborted = true;
      (xhr as XMLHttpRequest | null)?.abort();
      (wake as (() => void) | null)?.();
    },
  };
}

/** Fetch a binary asset with coarse progress, used by the CAD and PDF loaders. */
export async function fetchWithProgress(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetchApi(url, { signal });
  if (!response.ok) throw new ApiError(await readError(response), response.status);

  const total = Number(response.headers.get('content-length') ?? 0);
  if (!response.body || !onProgress || total === 0) {
    return response.arrayBuffer();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
  }
  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}
