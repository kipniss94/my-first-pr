import type { JobResult } from '@docuview/shared';

/** One unit of work handed to the isolated processing layer. */
export interface ProcessRequest {
  fileId: string;
  filePath: string;
  assetsDir: string;
  formatId: string;
  processor: string;
  extension: string;
  displayName: string;
  size: number;
  options: {
    libreOfficeBin: string | null;
    dwgConverterCmd: string | null;
    timeoutMs: number;
  };
}

/** NDJSON messages a worker writes back on stdout. */
export type ProcessMessage =
  | { type: 'ready' }
  | { type: 'progress'; stage: string; progress: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'result'; result: JobResult }
  | { type: 'error'; code: string; message: string; hint?: string; retryable?: boolean; detail?: string };
