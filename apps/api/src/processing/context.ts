import type { ProcessRequest } from './types.js';

/**
 * The contract a processor sees.
 *
 * This lives apart from `runner.ts` on purpose: the runner starts reading stdin
 * the moment it is imported, so anything that merely needs these types must not
 * pull that side effect in with them.
 */
export interface ProcessorContext {
  request: ProcessRequest;
  progress(stage: string, percent: number): void;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

/** An error with a message that is safe, and useful, to show a person. */
export class ProcessingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly retryable = false,
    /** Technical detail for the log only. Never reaches the browser. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ProcessingError';
  }
}
