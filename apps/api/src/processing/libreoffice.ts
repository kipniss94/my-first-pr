import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessingError } from './context.js';

export interface ConvertOptions {
  bin: string | null;
  inputPath: string;
  /** LibreOffice output filter, e.g. `pdf:writer_pdf_Export`, `xlsx`, `png`. */
  target: string;
  outDir: string;
  timeoutMs: number;
  /** Extension of the produced file, used to find it afterwards. */
  outExtension: string;
}

/**
 * Convert a document with a headless LibreOffice.
 *
 * Every call gets its own `UserInstallation` profile: without it two concurrent
 * conversions silently share a profile lock and the second one hangs forever.
 */
export async function libreOfficeConvert(options: ConvertOptions): Promise<string> {
  if (!options.bin) {
    throw new ProcessingError(
      'engine_missing',
      'This format needs LibreOffice on the server, and it is not installed.',
      'Install LibreOffice (`apt install libreoffice`) or run the app with Docker, where it is included.',
      false,
      'LIBREOFFICE_BIN not resolved',
    );
  }

  const profileDir = path.join(os.tmpdir(), `docuview-lo-${randomUUID()}`);
  await fs.mkdir(options.outDir, { recursive: true });

  const args = [
    `-env:UserInstallation=file://${profileDir}`,
    '--headless',
    '--norestore',
    '--nolockcheck',
    '--nodefault',
    '--nofirststartwizard',
    '--convert-to',
    options.target,
    '--outdir',
    options.outDir,
    options.inputPath,
  ];

  try {
    await run(options.bin, args, options.timeoutMs);
    const produced = await findOutput(options.outDir, options.outExtension, options.inputPath);
    if (!produced) {
      throw new ProcessingError(
        'conversion_failed',
        "We couldn't convert this document.",
        'The file may be corrupted or password protected.',
        false,
        'LibreOffice produced no output file',
      );
    }
    return produced;
  } finally {
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function run(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new ProcessingError(
          'timeout',
          'Converting this document took too long and was stopped.',
          'Try a smaller document.',
          true,
          'LibreOffice timeout',
        ),
      );
    }, timeoutMs);

    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-2000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new ProcessingError(
          'engine_missing',
          'The document converter could not be started on the server.',
          'Check that LibreOffice is installed and executable.',
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
            "We couldn't convert this document.",
            'The file may be corrupted or password protected.',
            false,
            `LibreOffice exit ${code}: ${stderr}`,
          ),
        );
    });
  });
}

/** LibreOffice names the output after the input basename. */
async function findOutput(outDir: string, extension: string, inputPath: string): Promise<string | null> {
  const expected = `${path.basename(inputPath, path.extname(inputPath))}.${extension}`;
  const direct = path.join(outDir, expected);
  try {
    await fs.access(direct);
    return direct;
  } catch {
    /* fall through to a directory scan */
  }
  const entries = await fs.readdir(outDir);
  const match = entries.find((e) => e.toLowerCase().endsWith(`.${extension.toLowerCase()}`));
  return match ? path.join(outDir, match) : null;
}
