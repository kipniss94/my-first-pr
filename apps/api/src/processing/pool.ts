import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobResult } from '@docuview/shared';
import { config, tmpDir } from '../config.js';
import { UserFacingError, type ProgressReporter } from '../jobs/queue.js';
import { logger } from '../logger.js';
import type { ProcessMessage, ProcessRequest } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const runningFromSource = here.includes(`${path.sep}src${path.sep}`) || here.endsWith(`${path.sep}src`);

/** Recycle a worker after this many jobs so a slow leak cannot accumulate. */
const MAX_JOBS_PER_WORKER = 25;
/** Retire an idle worker so a quiet server does not hold WASM heaps forever. */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

interface PendingJob {
  request: ProcessRequest;
  report: ProgressReporter;
  resolve(result: JobResult): void;
  reject(error: unknown): void;
  setAbort(abort: () => void): void;
}

class Worker {
  readonly child: ChildProcess;
  private buffer = '';
  private stderrTail = '';
  private current: PendingJob | null = null;
  private timer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  jobsRun = 0;
  dead = false;

  constructor(private readonly onFree: (worker: Worker) => void, private readonly onDead: (worker: Worker) => void) {
    const runnerPath = path.join(here, runningFromSource ? 'runner.ts' : 'runner.js');
    const args = [
      `--max-old-space-size=${config.processingMaxOldSpaceMb}`,
      ...(runningFromSource ? ['--import', 'tsx'] : []),
      runnerPath,
    ];
    this.child = spawn(process.execPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // A deliberately small environment: the processing layer never needs our
      // configuration or any secret the API process may hold.
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: process.env.NODE_ENV,
        TMPDIR: process.env.TMPDIR,
      },
      cwd: tmpDir,
    });

    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    this.child.on('error', (err) => this.die(err, 'spawn error'));
    this.child.on('close', (code, signal) => {
      this.die(new Error(`processing worker exited (code ${code}, signal ${signal})`), 'exit');
    });
    this.armIdleTimer();
  }

  get busy(): boolean {
    return this.current !== null;
  }

  run(job: PendingJob): void {
    this.current = job;
    this.jobsRun += 1;
    this.clearIdleTimer();

    job.setAbort(() => this.kill('cancelled by client'));
    this.timer = setTimeout(() => {
      this.failCurrent(
        new UserFacingError(
          'timeout',
          'This file took too long to prepare and was stopped.',
          'Very large assemblies can exceed the processing limit. Try a simplified export.',
          true,
        ),
      );
      this.kill('timeout');
    }, config.processingTimeoutMs);

    this.child.stdin?.write(`${JSON.stringify(job.request)}\n`);
  }

  kill(reason: string): void {
    if (this.dead) return;
    logger.debug({ reason, pid: this.child.pid }, 'killing processing worker');
    this.child.kill('SIGKILL');
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (!line) continue;
      let message: ProcessMessage;
      try {
        message = JSON.parse(line) as ProcessMessage;
      } catch {
        logger.debug({ line: line.slice(0, 200) }, 'non-JSON output from processing worker');
        continue;
      }
      this.handle(message);
    }
  }

  private handle(message: ProcessMessage): void {
    const job = this.current;
    switch (message.type) {
      case 'ready':
        return;
      case 'progress':
        job?.report(message.stage as never, message.progress);
        return;
      case 'log':
        logger[message.level]({ fileId: job?.request.fileId }, message.message);
        return;
      case 'result':
        this.finish(() => job?.resolve(message.result));
        return;
      case 'error':
        logger.warn({ fileId: job?.request.fileId, detail: message.detail }, 'processing reported an error');
        this.finish(() =>
          job?.reject(new UserFacingError(message.code, message.message, message.hint, message.retryable ?? false)),
        );
        return;
    }
  }

  private finish(settle: () => void): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.current = null;
    settle();
    if (this.jobsRun >= MAX_JOBS_PER_WORKER) {
      this.kill('max jobs reached');
      return;
    }
    this.armIdleTimer();
    this.onFree(this);
  }

  private failCurrent(error: unknown): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const job = this.current;
    this.current = null;
    job?.reject(error);
  }

  private die(err: Error, reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.clearIdleTimer();
    if (this.current) {
      const stderr = this.stderrTail.slice(-1500);
      logger.error({ err, reason, stderr, fileId: this.current.request.fileId }, 'processing worker died');
      // A worker killed by the OS almost always means the file blew the heap.
      this.failCurrent(
        new UserFacingError(
          'out_of_memory',
          'This file is too complex for the current processing limits.',
          'Try a simplified or smaller export of the model.',
          false,
        ),
      );
    }
    this.onDead(this);
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.kill('idle'), IDLE_TIMEOUT_MS);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

/**
 * A pool of warm processing workers.
 *
 * One process per job was the simplest thing that worked, but it paid ~2s of
 * interpreter and WebAssembly start-up on every single CAD file. Keeping the
 * workers warm removes that from the critical path while preserving what the
 * isolation was for: a parser crash or a runaway allocation takes down one
 * worker, never the API, and the memory ceiling is still enforced per process.
 */
export class ProcessingPool {
  private readonly workers = new Set<Worker>();
  private readonly waiting: PendingJob[] = [];

  constructor(private readonly size = config.processingConcurrency) {}

  submit(
    request: ProcessRequest,
    report: ProgressReporter = () => undefined,
    setAbort: (abort: () => void) => void = () => undefined,
  ): Promise<JobResult> {
    return new Promise<JobResult>((resolve, reject) => {
      this.waiting.push({ request, report, resolve, reject, setAbort });
      this.pump();
    });
  }

  /** Start one worker up front so the first upload does not pay for the boot. */
  prewarm(): void {
    if (this.workers.size === 0) this.spawnWorker();
  }

  shutdown(): void {
    for (const worker of this.workers) worker.kill('shutdown');
    this.workers.clear();
  }

  private pump(): void {
    while (this.waiting.length > 0) {
      const free = [...this.workers].find((worker) => !worker.busy && !worker.dead);
      if (free) {
        const job = this.waiting.shift();
        if (job) free.run(job);
        continue;
      }
      if (this.workers.size < this.size) {
        this.spawnWorker();
        continue;
      }
      return;
    }
  }

  private spawnWorker(): void {
    const worker = new Worker(
      () => this.pump(),
      (dead) => {
        this.workers.delete(dead);
        this.pump();
      },
    );
    this.workers.add(worker);
  }
}
