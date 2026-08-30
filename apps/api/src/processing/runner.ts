/**
 * Processing layer entry point.
 *
 * Runs as a pooled child process: reads newline-delimited `ProcessRequest`
 * objects from stdin, handles them one at a time, and streams NDJSON messages
 * back on stdout. Nothing here may import the Express app — this file is the
 * seam where the pipeline could later move to its own container or queue.
 */
import readline from 'node:readline';
import type { JobResult } from '@docuview/shared';
import { ProcessingError, type ProcessorContext } from './context.js';
import type { ProcessMessage, ProcessRequest } from './types.js';
import { processOcct } from './processors/cad-occt.js';
import { processDwg } from './processors/cad-dwg.js';
import { processProprietaryCad } from './processors/cad-proprietary.js';
import { processWord } from './processors/office-word.js';
import { processSheet } from './processors/office-sheet.js';
import { processSlides } from './processors/office-slides.js';
import { processOfficePdf } from './processors/office-pdf.js';

export { ProcessingError } from './context.js';
export type { ProcessorContext } from './context.js';

type Processor = (ctx: ProcessorContext) => Promise<JobResult>;

const PROCESSORS: Record<string, Processor> = {
  'cad-occt': processOcct,
  'cad-dwg': processDwg,
  'cad-proprietary': processProprietaryCad,
  'office-word': processWord,
  'office-sheet': processSheet,
  'office-slides': processSlides,
  'office-pdf': processOfficePdf,
};

function send(message: ProcessMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(request: ProcessRequest): Promise<void> {
  const processor = PROCESSORS[request.processor];
  if (!processor) {
    send({
      type: 'error',
      code: 'unsupported_format',
      message: "We don't have a processor for this file type yet.",
      retryable: false,
      detail: `no processor named ${request.processor}`,
    });
    return;
  }

  const ctx: ProcessorContext = {
    request,
    progress: (stage, percent) => send({ type: 'progress', stage, progress: percent }),
    log: (level, message) => send({ type: 'log', level, message }),
  };

  try {
    const result = await processor(ctx);
    send({ type: 'result', result });
  } catch (err) {
    if (err instanceof ProcessingError) {
      send({
        type: 'error',
        code: err.code,
        message: err.message,
        hint: err.hint,
        retryable: err.retryable,
        detail: err.detail ?? err.stack,
      });
    } else {
      send({
        type: 'error',
        code: 'processing_failed',
        message: "We couldn't process this file.",
        hint: 'The file may be corrupted, password protected, or use features we do not support yet.',
        retryable: true,
        detail: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err),
      });
    }
  }
}

/**
 * Requests are handled strictly one at a time: the pool never sends a second
 * request before the first has produced a `result` or `error` message, so a
 * simple queue is enough to survive a burst arriving in one stdin chunk.
 */
let chain: Promise<void> = Promise.resolve();

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request: ProcessRequest;
  try {
    request = JSON.parse(trimmed) as ProcessRequest;
  } catch (err) {
    send({
      type: 'error',
      code: 'processing_failed',
      message: "We couldn't process this file.",
      retryable: true,
      detail: `unparsable request: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  chain = chain.then(() => handle(request));
});

input.on('close', () => {
  void chain.finally(() => process.exit(0));
});

// Unhandled failures must still surface as a user-facing error rather than a
// silent exit that the pool would have to guess about.
process.on('uncaughtException', (err) => {
  send({
    type: 'error',
    code: 'processing_failed',
    message: "We couldn't process this file.",
    retryable: true,
    detail: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err),
  });
  process.exit(1);
});

send({ type: 'ready' });
