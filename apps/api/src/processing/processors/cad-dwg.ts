import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { JobResult } from '@docuview/shared';
import { ProcessingError, type ProcessorContext } from '../context.js';

/**
 * DWG is a closed format with no usable open-source reader in JavaScript, so we
 * shell out to whatever converter the operator installed. The command template
 * is configuration, never user input — the only thing interpolated is a path we
 * generated ourselves.
 *
 * Placeholders: {input} {indir} {output} {outdir}
 *
 * Examples:
 *   ODA File Converter:
 *     DWG_CONVERTER_CMD="/usr/bin/ODAFileConverter {indir} {outdir} ACAD2018 DXF 0 1"
 *   LibreDWG:
 *     DWG_CONVERTER_CMD="/usr/bin/dwg2dxf -o {output} {input}"
 */
export async function processDwg(ctx: ProcessorContext): Promise<JobResult> {
  const { request } = ctx;
  const template = request.options.dwgConverterCmd;

  if (!template) {
    throw new ProcessingError(
      'engine_missing',
      'DWG files need a converter that is not installed on this server.',
      'Save the drawing as DXF in your CAD application and upload that, or configure DWG_CONVERTER_CMD (ODA File Converter or LibreDWG) on the server.',
      false,
      'DWG_CONVERTER_CMD is not set',
    );
  }

  ctx.progress('processing', 20);

  const workDir = path.join(os.tmpdir(), `docuview-dwg-${randomUUID()}`);
  const inDir = path.join(workDir, 'in');
  const outDir = path.join(workDir, 'out');
  await fs.mkdir(inDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });

  // Converters key the output name off the input name, so give it a safe one.
  const inputCopy = path.join(inDir, 'drawing.dwg');
  const outputPath = path.join(outDir, 'drawing.dxf');
  await fs.copyFile(request.filePath, inputCopy);

  try {
    const parts = template
      .split(/\s+/)
      .filter(Boolean)
      .map((token) =>
        token
          .replace('{input}', inputCopy)
          .replace('{indir}', inDir)
          .replace('{output}', outputPath)
          .replace('{outdir}', outDir),
      );
    const [bin, ...args] = parts;

    await run(bin, args, request.options.timeoutMs, ctx);
    ctx.progress('preparing-geometry', 70);

    const produced = await findDxf(outDir);
    if (!produced) {
      throw new ProcessingError(
        'conversion_failed',
        "We couldn't convert this DWG drawing.",
        'The DWG version may be newer than the converter supports. Saving as DXF from your CAD application is the fastest workaround.',
        false,
        'converter produced no .dxf',
      );
    }

    await fs.mkdir(request.assetsDir, { recursive: true });
    const target = path.join(request.assetsDir, 'converted.dxf');
    await fs.copyFile(produced, target);
    const stat = await fs.stat(target);

    return {
      kind: 'cad',
      viewer: 'cad-dxf',
      source: `/api/v1/files/${request.fileId}/assets/converted.dxf`,
      meta: {
        formatId: 'dwg',
        convertedTo: 'DXF',
        convertedBytes: stat.size,
      },
      warnings: ['This DWG was converted to DXF for viewing. Some proprietary DWG objects may not survive the conversion.'],
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function run(bin: string, args: string[], timeoutMs: number, ctx: ProcessorContext): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new ProcessingError('timeout', 'Converting this drawing took too long and was stopped.', undefined, true, 'dwg converter timeout'),
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
          'The DWG converter could not be started on this server.',
          'Check the DWG_CONVERTER_CMD setting.',
          false,
          err.message,
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // ODA File Converter exits non-zero in some builds even on success, so we
      // only trust the presence of the output file. Log the code either way.
      ctx.log(code === 0 ? 'info' : 'warn', `dwg converter exited with code ${code}`);
      if (stderr) ctx.log('warn', `dwg converter stderr: ${stderr.slice(-500)}`);
      resolve();
    });
  });
}

async function findDxf(dir: string): Promise<string | null> {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.toLowerCase().endsWith('.dxf')) return full;
    }
  }
  return null;
}
