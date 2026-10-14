import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { tmpDir } from '../src/config.js';
import { ProcessingPool } from '../src/processing/pool.js';
import type { ProcessRequest } from '../src/processing/types.js';

/** A request no processor claims: the worker answers at once with an error. */
function request(n: number): ProcessRequest {
  return {
    fileId: `pool-test-${n}`,
    filePath: '',
    assetsDir: '',
    formatId: 'none',
    processor: 'no-such-processor',
    extension: '',
    displayName: '',
    size: 0,
    options: { libreOfficeBin: null, dwgConverterCmd: null, cadConverterCmd: null, timeoutMs: 10_000 },
  };
}

/**
 * A worker is recycled after 25 jobs. The next job used to be handed to it in
 * the few milliseconds between the kill and the process actually exiting; the
 * write failed with EPIPE and, with nothing listening for it, took the whole
 * API down. The model check hit it on its 76th part.
 */
describe('processing pool', () => {
  const pool = new ProcessingPool(1);

  before(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
  });

  after(() => pool.shutdown());

  it('keeps serving jobs submitted back to back across a worker recycle', { timeout: 120_000 }, async () => {
    for (let n = 0; n < 30; n += 1) {
      await assert.rejects(pool.submit(request(n)), (err: Error & { code?: string }) => {
        assert.equal(err.code, 'unsupported_format', `job ${n}: ${err.message}`);
        return true;
      });
    }
  });
});
