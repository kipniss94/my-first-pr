import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { JobError, JobResult, JobStage, JobState, JobStatus } from '@docuview/shared';
import { config } from '../config.js';
import { logger } from '../logger.js';

export interface JobInput {
  fileId: string;
  fileName: string;
  size: number;
  expiresAt: string;
}

type Runner = (job: JobRecord, report: ProgressReporter) => Promise<JobResult>;

export interface ProgressReporter {
  (stage: JobStage, progress: number): void;
}

export class JobRecord {
  readonly id = randomUUID();
  readonly createdAt = new Date().toISOString();
  updatedAt = this.createdAt;
  status: JobStatus = 'queued';
  stage: JobStage = 'detecting';
  progress = -1;
  format: JobState['format'] = null;
  result: JobResult | null = null;
  error: JobError | null = null;
  /** Set when the client cancels; the runner checks it between steps. */
  cancelled = false;
  /** Handle to the processing child process, so cancel can kill it. */
  abort: (() => void) | null = null;

  constructor(readonly input: JobInput) {}

  toState(): JobState {
    return {
      id: this.id,
      fileId: this.input.fileId,
      fileName: this.input.fileName,
      size: this.input.size,
      status: this.status,
      stage: this.stage,
      progress: this.progress,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      format: this.format,
      result: this.result,
      error: this.error,
      expiresAt: this.input.expiresAt,
    };
  }
}

/**
 * A deliberately small in-process queue. The public surface (`enqueue`, `get`,
 * `cancel`, `events`) is the same one a Redis/BullMQ backend would expose, so
 * swapping it out later does not touch the routes.
 */
export class JobQueue extends EventEmitter {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly waiting: JobRecord[] = [];
  private active = 0;

  constructor(private readonly runner: Runner, private readonly concurrency = config.processingConcurrency) {
    super();
  }

  enqueue(input: JobInput): JobRecord {
    const job = new JobRecord(input);
    this.jobs.set(job.id, job);
    this.waiting.push(job);
    queueMicrotask(() => this.pump());
    return job;
  }

  get(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  findByFile(fileId: string): JobRecord | undefined {
    for (const job of this.jobs.values()) {
      if (job.input.fileId === fileId) return job;
    }
    return undefined;
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status === 'succeeded' || job.status === 'failed') return false;
    job.cancelled = true;
    job.abort?.();
    const index = this.waiting.indexOf(job);
    if (index >= 0) this.waiting.splice(index, 1);
    this.finish(job, 'cancelled');
    return true;
  }

  /** Drop bookkeeping for a file that has been deleted. */
  forget(fileId: string): void {
    for (const [id, job] of this.jobs) {
      if (job.input.fileId === fileId) this.jobs.delete(id);
    }
  }

  /** Remove finished jobs whose file has expired. */
  prune(now = Date.now()): void {
    for (const [id, job] of this.jobs) {
      if (Date.parse(job.input.expiresAt) <= now) this.jobs.delete(id);
    }
  }

  private pump(): void {
    while (this.active < this.concurrency && this.waiting.length > 0) {
      const job = this.waiting.shift();
      if (!job || job.cancelled) continue;
      this.active += 1;
      void this.run(job).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async run(job: JobRecord): Promise<void> {
    job.status = 'running';
    this.touch(job);
    const report: ProgressReporter = (stage, progress) => {
      if (job.cancelled) return;
      job.stage = stage;
      job.progress = progress;
      this.touch(job);
    };
    try {
      const result = await this.runner(job, report);
      if (job.cancelled) return;
      job.result = result;
      job.stage = 'ready';
      job.progress = 100;
      this.finish(job, 'succeeded');
    } catch (err) {
      if (job.cancelled) return;
      job.error = toUserError(err);
      logger.error({ err, jobId: job.id, fileId: job.input.fileId }, 'job failed');
      this.finish(job, 'failed');
    }
  }

  private finish(job: JobRecord, status: JobStatus): void {
    job.status = status;
    job.abort = null;
    this.touch(job);
  }

  private touch(job: JobRecord): void {
    job.updatedAt = new Date().toISOString();
    this.emit('update', job);
  }
}

/** Errors carrying a user-facing message, thrown by the processing layer. */
export class UserFacingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'UserFacingError';
  }
}

/**
 * Turn anything thrown inside the pipeline into a sentence a person can act on.
 * Stack traces, file paths and library names stay in the log.
 */
export function toUserError(err: unknown): JobError {
  if (err instanceof UserFacingError) {
    return { code: err.code, message: err.message, hint: err.hint, retryable: err.retryable };
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return {
      code: 'timeout',
      message: 'This file took too long to prepare and was stopped.',
      hint: 'Very large assemblies can exceed the processing limit. Try a smaller file or a simplified export.',
      retryable: true,
    };
  }
  return {
    code: 'processing_failed',
    message: "We couldn't process this file.",
    hint: 'The file may be corrupted, password protected, or use features we do not support yet.',
    retryable: true,
  };
}
