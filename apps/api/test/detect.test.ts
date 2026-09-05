import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { detectFormat } from '../src/processing/detect.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

async function detect(name: string, pretendExtension?: string) {
  const file = path.join(fixtures, name);
  const stat = await fs.stat(file);
  const extension = pretendExtension ?? (/\.([^.]+)$/.exec(name)?.[1] ?? '');
  return detectFormat(file, extension.toLowerCase(), stat.size);
}

/**
 * These run against the generated fixtures, so `npm run fixtures` has to have
 * been run first. Detection is the gate every upload passes through, and it is
 * the one place where being wrong means opening the wrong viewer.
 */
describe('format detection', () => {
  let available = true;

  before(async () => {
    available = await fs
      .access(path.join(fixtures, 'cube.step'))
      .then(() => true)
      .catch(() => false);
    if (!available) {
      console.warn('fixtures missing - run `npm run fixtures` first');
    }
  });

  it('recognises STEP and reads its schema', async (t) => {
    if (!available) return t.skip('fixtures missing');
    const result = await detect('cube.step');
    assert.equal(result.format?.id, 'step');
    assert.equal(result.version, 'AP214');
    assert.equal(result.extensionMismatch, false);
  });

  it('recognises binary and ASCII STL', async (t) => {
    if (!available) return t.skip('fixtures missing');
    assert.equal((await detect('stepped-block.stl')).version, 'Binary STL');
    assert.equal((await detect('cube-ascii.stl')).version, 'ASCII STL');
  });

  it('recognises DXF and reads the AutoCAD version', async (t) => {
    if (!available) return t.skip('fixtures missing');
    const result = await detect('plate.dxf');
    assert.equal(result.format?.id, 'dxf');
    assert.match(result.version ?? '', /AC1015/);
  });

  it('recognises PDF and its version', async (t) => {
    if (!available) return t.skip('fixtures missing');
    const result = await detect('report.pdf');
    assert.equal(result.format?.id, 'pdf');
    assert.equal(result.version, 'PDF 1.4');
  });

  it('tells OOXML containers apart', async (t) => {
    if (!available) return t.skip('fixtures missing');
    assert.equal((await detect('inspection-report.docx')).format?.id, 'docx');
    assert.equal((await detect('bill-of-materials.xlsx')).format?.id, 'xlsx');
    assert.equal((await detect('pipeline-overview.pptx')).format?.id, 'pptx');
  });

  it('trusts the content over the extension', async (t) => {
    if (!available) return t.skip('fixtures missing');
    // A PDF renamed to .stl must still open as a PDF, and say so.
    const result = await detect('report.pdf', 'stl');
    assert.equal(result.format?.id, 'pdf');
    assert.equal(result.extensionMismatch, true);
  });

  it('does not promote unknown binary content into a supported format', async (t) => {
    if (!available) return t.skip('fixtures missing');
    const result = await detect('garbage.bin', 'step');
    assert.equal(result.format, null);
  });
});

/* -------------------------------------------------------------------------- */

describe('storage safety', () => {
  it('strips directories and control characters from display names', async () => {
    const { sanitizeDisplayName } = await import('../src/storage/store.js');
    assert.equal(sanitizeDisplayName('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeDisplayName('C:\\Users\\me\\model.step'), 'model.step');
    assert.equal(sanitizeDisplayName('a\u0000b\u001fc.stl'), 'abc.stl');
    assert.equal(sanitizeDisplayName(''), 'document');
    assert.equal(sanitizeDisplayName('x'.repeat(400)).length, 180);
  });

  it('recovers a name that busboy read as latin-1', async () => {
    const { sanitizeDisplayName } = await import('../src/storage/store.js');
    // What the wire carries, and what busboy hands us for it.
    const wire = Buffer.from('\u044e\u0431\u043a\u0430.SLDPRT', 'utf8');
    assert.equal(sanitizeDisplayName(wire.toString('latin1')), '\u044e\u0431\u043a\u0430.SLDPRT');
    // A name that really is latin-1 is not valid UTF-8, so it survives as it came.
    assert.equal(sanitizeDisplayName('caf\u00e9.step'), 'caf\u00e9.step');
  });

  it('refuses asset names that would escape the asset directory', async () => {
    const { assetPath } = await import('../src/storage/store.js');
    const fileId = '11111111-2222-3333-4444-555555555555';
    assert.ok(assetPath(fileId, 'model.bin').endsWith('/assets/model.bin'));
    for (const bad of ['../meta.json', 'a/b.json', '/etc/passwd', '..', '', 'a'.repeat(200)]) {
      assert.throws(() => assetPath(fileId, bad), /invalid asset name/, `should reject ${bad}`);
    }
  });

  it('refuses file ids that are not UUIDs', async () => {
    const { fileDir } = await import('../src/storage/store.js');
    assert.throws(() => fileDir('../../etc'), /invalid file id/);
    assert.throws(() => fileDir('short'), /invalid file id/);
  });
});

describe('generated HTML sanitising', () => {
  it('removes scripts, event handlers and javascript: URLs', async () => {
    const { sanitizeHtml } = await import('../src/processing/processors/office-word.js');
    const dirty = [
      '<p onclick="steal()">hi</p>',
      '<script>alert(1)</script>',
      '<img src="x" onerror=alert(1)>',
      "<a href='javascript:alert(1)'>x</a>",
      '<iframe src="http://evil"></iframe>',
    ].join('');
    const clean = sanitizeHtml(dirty);
    assert.ok(!/<script/i.test(clean), 'script tag survived');
    assert.ok(!/onclick/i.test(clean), 'inline handler survived');
    assert.ok(!/onerror/i.test(clean), 'inline handler survived');
    assert.ok(!/javascript:/i.test(clean), 'javascript: URL survived');
    assert.ok(!/<iframe/i.test(clean), 'iframe survived');
    assert.ok(clean.includes('hi'), 'document text was lost');
  });
});

describe('job queue', () => {
  it('reports failures as user-facing messages, never stack traces', async () => {
    const { JobQueue, toUserError } = await import('../src/jobs/queue.js');
    const error = toUserError(new Error('ENOENT: /srv/data/uploads/secret/original.bin'));
    assert.ok(!error.message.includes('/srv'), 'a filesystem path leaked to the user');
    assert.equal(error.code, 'processing_failed');

    const queue = new JobQueue(async () => {
      throw new Error('boom');
    }, 1);
    const job = queue.enqueue({
      fileId: 'x',
      fileName: 'f.step',
      size: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await new Promise<void>((resolve) => {
      queue.on('update', () => {
        if (job.status === 'failed') resolve();
      });
    });
    assert.equal(job.error?.message, "We couldn't process this file.");
    assert.ok(!JSON.stringify(job.toState()).includes('boom'), 'the raw error leaked');
  });

  it('cancels a queued job', async () => {
    const { JobQueue } = await import('../src/jobs/queue.js');
    const queue = new JobQueue(async () => new Promise(() => undefined), 1);
    const job = queue.enqueue({
      fileId: 'y',
      fileName: 'f.step',
      size: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(queue.cancel(job.id), true);
    assert.equal(job.status, 'cancelled');
  });
});

describe('retention', () => {
  it('deletes uploads whose retention window has passed', async () => {
    const { config, uploadsDir } = await import('../src/config.js');
    const store = await import('../src/storage/store.js');
    await store.initStorage();

    const fileId = store.newFileId();
    await store.createFileDir(fileId);
    await fs.writeFile(store.originalPath(fileId), 'test');
    await store.writeMeta({
      fileId,
      displayName: 'expired.step',
      extension: 'step',
      size: 4,
      declaredMime: 'application/step',
      createdAt: new Date(Date.now() - 2 * config.retentionSeconds * 1000).toISOString(),
      expiresAt: new Date(Date.now() - config.retentionSeconds * 1000).toISOString(),
    });

    assert.ok(await exists(path.join(uploadsDir, fileId)));
    await store.sweepExpired();
    assert.equal(await exists(path.join(uploadsDir, fileId)), false, 'expired upload survived the sweep');
  });

  after(async () => {
    // Leave no test data behind.
    const { uploadsDir } = await import('../src/config.js');
    for (const entry of await fs.readdir(uploadsDir).catch(() => [])) {
      const meta = await fs
        .readFile(path.join(uploadsDir, entry, 'meta.json'), 'utf8')
        .then((raw) => JSON.parse(raw) as { displayName: string })
        .catch(() => null);
      if (meta?.displayName === 'expired.step') {
        await fs.rm(path.join(uploadsDir, entry), { recursive: true, force: true });
      }
    }
  });
});

async function exists(target: string): Promise<boolean> {
  return fs
    .access(target)
    .then(() => true)
    .catch(() => false);
}
