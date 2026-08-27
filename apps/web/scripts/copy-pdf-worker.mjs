/**
 * PDF.js runs its parser in a web worker loaded from a URL. Copying the worker
 * into `public/` keeps it same-origin (no CDN, no CSP exception) and pins it to
 * the exact pdfjs-dist version installed here.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../public');

async function main() {
  const entry = require.resolve('pdfjs-dist/package.json');
  const root = path.dirname(entry);
  const candidates = ['build/pdf.worker.min.mjs', 'build/pdf.worker.mjs'];

  await fs.mkdir(publicDir, { recursive: true });
  for (const candidate of candidates) {
    const source = path.join(root, candidate);
    try {
      await fs.access(source);
      await fs.copyFile(source, path.join(publicDir, 'pdf.worker.min.mjs'));
      const { version } = require('pdfjs-dist/package.json');
      console.log(`pdf.worker.min.mjs copied from pdfjs-dist ${version}`);
      return;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('Could not find the PDF.js worker inside pdfjs-dist.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
