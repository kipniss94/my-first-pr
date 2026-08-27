import type { CapabilitiesResponse, JobError, JobState, UploadResponse } from '@docuview/shared';

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

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), { ...init, headers: { Accept: 'application/json', ...init?.headers } });
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

/**
 * Uploads via XHR rather than `fetch` because upload progress events are the
 * only honest way to fill the "Uploading" stage — `fetch` cannot report them.
 */
export function uploadFile(file: File, onProgress: (loaded: number, total: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<UploadResponse>((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    });

    xhr.addEventListener('load', () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        reject(new ApiError(GENERIC_ERROR, xhr.status));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as UploadResponse);
      } else {
        const error = (body as { error?: JobError }).error;
        reject(
          new ApiError(
            error ?? { code: `http_${xhr.status}`, message: "We couldn't upload this file.", retryable: true },
            xhr.status,
          ),
        );
      }
    });

    xhr.addEventListener('error', () => reject(new ApiError(GENERIC_ERROR, xhr.status)));
    xhr.addEventListener('timeout', () =>
      reject(
        new ApiError({
          code: 'upload_timeout',
          message: 'The upload timed out.',
          hint: 'Check your connection and try again.',
          retryable: true,
        }),
      ),
    );
    xhr.addEventListener('abort', () =>
      reject(new ApiError({ code: 'cancelled', message: 'Upload cancelled.', retryable: true })),
    );

    xhr.open('POST', apiUrl('/api/v1/uploads'));
    xhr.responseType = 'text';
    xhr.send(form);
  });

  return { promise, abort: () => xhr.abort() };
}

/** Fetch a binary asset with coarse progress, used by the CAD and PDF loaders. */
export async function fetchWithProgress(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(apiUrl(url), { signal });
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
