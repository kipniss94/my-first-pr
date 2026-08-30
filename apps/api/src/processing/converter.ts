/**
 * Optional bridge to a native CAD converter.
 *
 * Reading a SolidWorks or CATIA solid needs that vendor's kernel, which cannot
 * ship in an open web service. Operators who do hold a licence — ODA, CAD
 * Exchanger, a SolidWorks Document Manager wrapper — point `CAD_CONVERTER_CMD`
 * at it and every proprietary upload gains full geometry, measurement and
 * sectioning through the normal STEP path.
 *
 * Without it the file still opens; it just opens as its stored preview.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProcessingError } from './context.js';

export interface ConvertToStepOptions {
  command: string;
  inputPath: string;
  outDir: string;
  /** Extension of the source file, passed to the converter as `{informat}`. */
  informat: string;
  timeoutMs: number;
  log?(level: 'info' | 'warn' | 'error', message: string): void;
}

/**
 * Split a command template into argv, honouring quotes.
 *
 * The command is never handed to a shell: the operator's template becomes an
 * argv array and user-controlled values only ever arrive as whole arguments, so
 * a file name can never turn into a second command.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of command.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

const STEP_EXTENSIONS = ['.step', '.stp', '.STEP', '.STP'];

/** Run the configured converter and return the STEP file it produced. */
export async function convertToStep(options: ConvertToStepOptions): Promise<string> {
  const outPath = path.join(options.outDir, 'converted.step');
  await fs.mkdir(options.outDir, { recursive: true });

  const tokens = tokenizeCommand(options.command);
  if (tokens.length === 0) {
    throw new ProcessingError(
      'converter_misconfigured',
      'The CAD converter on this server is not configured correctly.',
      undefined,
      false,
      'CAD_CONVERTER_CMD is empty after tokenizing',
    );
  }

  const substitutions: Record<string, string> = {
    '{input}': options.inputPath,
    '{indir}': path.dirname(options.inputPath),
    '{output}': outPath,
    '{outdir}': options.outDir,
    '{informat}': options.informat,
    '{outformat}': 'step',
  };

  const [bin, ...rest] = tokens.map((token) =>
    token.replace(/\{(input|indir|output|outdir|informat|outformat)\}/g, (placeholder) => substitutions[placeholder] ?? placeholder),
  );

  await run(bin, rest, options.timeoutMs, options.log);

  const produced = await findStep(options.outDir, outPath);
  if (!produced) {
    throw new ProcessingError(
      'conversion_failed',
      "The CAD converter on this server couldn't read this file.",
      'The model may use a newer version of the format than the converter supports.',
      false,
      'converter produced no STEP output',
    );
  }
  return produced;
}

function run(
  bin: string,
  args: string[],
  timeoutMs: number,
  log?: (level: 'info' | 'warn' | 'error', message: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new ProcessingError(
          'timeout',
          'Converting this model took too long and was stopped.',
          'Try a smaller assembly, or export a STEP file from your CAD system.',
          true,
          'CAD converter timeout',
        ),
      );
    }, timeoutMs);

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      log?.('info', `converter: ${chunk.toString('utf8').trim().slice(0, 300)}`);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new ProcessingError(
          'converter_missing',
          'The CAD converter on this server could not be started.',
          'Check the CAD_CONVERTER_CMD setting.',
          false,
          err.message,
        ),
      );
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new ProcessingError(
            'conversion_failed',
            "The CAD converter on this server couldn't read this file.",
            'The model may be newer than the converter supports.',
            false,
            `converter exit ${code}: ${stderr}`,
          ),
        );
    });
  });
}

/** Converters name their output inconsistently, so accept any STEP in the folder. */
async function findStep(outDir: string, preferred: string): Promise<string | null> {
  const direct = await fs
    .stat(preferred)
    .then((stat) => stat.size > 0)
    .catch(() => false);
  if (direct) return preferred;

  const entries = await fs.readdir(outDir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (STEP_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      const candidate = path.join(outDir, entry);
      const stat = await fs.stat(candidate).catch(() => null);
      if (stat && stat.size > 0) return candidate;
    }
  }
  return null;
}
