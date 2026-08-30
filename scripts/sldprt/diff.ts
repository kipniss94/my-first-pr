/**
 * Differential analysis of two `.SLDPRT` files.
 *
 *   npx tsx scripts/sldprt/diff.ts <before.sldprt> <after.sldprt>
 *
 * This replaces the step a human would do by opening both models in a CAD
 * viewer and comparing them. Given two files that differ by exactly one known
 * change — a 10 mm cube and a 20 mm cube, or the same part with one hole added
 * — the bytes that moved are, by construction, the bytes that encode that
 * change. It is the fastest honest route to the coordinate arrays: no guessing
 * about what a field means, because the edit that produced it is known.
 *
 * The two files must differ in one thing only. Two unrelated parts produce a
 * diff where everything changed, which tells you nothing.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { readCompoundFile, isCompoundFile, type CfbFile } from '../../apps/api/src/processing/cfb.js';
import { entropy, findNumericRuns, probeCompression } from './inspect.js';
import zlib from 'node:zlib';

interface Stream {
  path: string;
  data: Buffer;
}

async function readStreams(file: string): Promise<{ streams: Stream[]; whole: Buffer }> {
  const buffer = await fs.readFile(file);
  if (!isCompoundFile(buffer)) return { streams: [{ path: '<raw file>', data: buffer }], whole: buffer };

  const cfb: CfbFile | null = readCompoundFile(buffer);
  if (!cfb) return { streams: [{ path: '<raw file>', data: buffer }], whole: buffer };

  const streams = cfb.entries
    .filter((entry) => entry.type === 2 && entry.size > 0)
    .map((entry) => ({ path: entry.path, data: decompressed(cfb.read(entry)) }));
  return { streams, whole: buffer };
}

/** Compare payloads, not envelopes: a recompressed stream differs everywhere. */
function decompressed(data: Buffer): Buffer {
  const probe = probeCompression(data);
  if (!probe.kind) return data;
  try {
    const body = data.subarray(probe.offset);
    if (probe.kind === 'zlib') return zlib.inflateSync(body);
    if (probe.kind === 'gzip') return zlib.gunzipSync(body);
    return zlib.inflateRawSync(body);
  } catch {
    return data;
  }
}

interface ChangedRange {
  offset: number;
  length: number;
}

/** Contiguous byte ranges that differ, merged across small gaps. */
function changedRanges(a: Buffer, b: Buffer, mergeGap = 16): ChangedRange[] {
  const ranges: ChangedRange[] = [];
  const limit = Math.min(a.length, b.length);
  let start = -1;

  for (let i = 0; i < limit; i += 1) {
    if (a[i] !== b[i]) {
      if (start < 0) start = i;
    } else if (start >= 0 && i - start > 0) {
      const last = ranges[ranges.length - 1];
      // Two edits a few bytes apart are one field, not two.
      if (last && start - (last.offset + last.length) <= mergeGap) {
        last.length = i - last.offset;
      } else {
        ranges.push({ offset: start, length: i - start });
      }
      start = -1;
    }
  }
  if (start >= 0) ranges.push({ offset: start, length: limit - start });
  if (a.length !== b.length) ranges.push({ offset: limit, length: Math.abs(a.length - b.length) });
  return ranges;
}

/** A number that could be a real dimension rather than reinterpreted text. */
function physical(value: number): boolean {
  const magnitude = Math.abs(value);
  return value === 0 || (magnitude > 1e-9 && magnitude < 1e6);
}

/**
 * Report the numbers that changed inside a changed range.
 *
 * This is what turns "these 48 bytes moved" into "this is a coordinate": if a
 * double went from 0.01 to 0.02 when the modelled cube went from 10 mm to
 * 20 mm, the field is a length in metres and the array around it is geometry.
 *
 * Values are held to the same plausibility window the inspector uses. Text and
 * tags read as denormal doubles around 1e-306, and printing those as if they
 * were dimensions would send the whole analysis chasing noise.
 */
function changedNumbers(a: Buffer, b: Buffer, range: ChangedRange, width: 4 | 8): string[] {
  const out: string[] = [];
  const read = (buffer: Buffer, at: number) =>
    width === 8 ? buffer.readDoubleLE(at) : buffer.readFloatLE(at);

  const first = Math.floor(range.offset / width) * width;
  const last = Math.min(a.length, b.length) - width;
  for (let at = first; at <= Math.min(last, range.offset + range.length); at += width) {
    let before: number;
    let after: number;
    try {
      before = read(a, at);
      after = read(b, at);
    } catch {
      break;
    }
    if (before === after) continue;
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
    if (!physical(before) || !physical(after)) continue;

    const ratio = before !== 0 ? after / before : Number.NaN;
    out.push(
      `    f${width * 8} @${at}: ${before.toPrecision(8)} → ${after.toPrecision(8)}` +
        (Number.isFinite(ratio) ? `  (×${ratio.toPrecision(5)})` : ''),
    );
    if (out.length >= 12) break;
  }
  return out;
}

async function main(): Promise<void> {
  const [beforeFile, afterFile] = process.argv.slice(2);
  if (!beforeFile || !afterFile) {
    console.error('usage: npx tsx scripts/sldprt/diff.ts <before.sldprt> <after.sldprt>');
    process.exit(2);
  }

  const before = await readStreams(beforeFile);
  const after = await readStreams(afterFile);

  const names = new Set([...before.streams.map((s) => s.path), ...after.streams.map((s) => s.path)]);
  const byPathBefore = new Map(before.streams.map((s) => [s.path, s.data]));
  const byPathAfter = new Map(after.streams.map((s) => [s.path, s.data]));

  console.log(`\n=== ${path.basename(beforeFile)}  →  ${path.basename(afterFile)} ===`);
  console.log(`${before.whole.length} B → ${after.whole.length} B\n`);

  const identical: string[] = [];
  const onlyBefore: string[] = [];
  const onlyAfter: string[] = [];

  for (const name of [...names].sort()) {
    const a = byPathBefore.get(name);
    const b = byPathAfter.get(name);

    if (!a) {
      onlyAfter.push(name);
      continue;
    }
    if (!b) {
      onlyBefore.push(name);
      continue;
    }
    if (a.length === b.length && a.equals(b)) {
      identical.push(name);
      continue;
    }

    const ranges = changedRanges(a, b);
    const changedBytes = ranges.reduce((total, range) => total + range.length, 0);
    const share = ((changedBytes / Math.max(a.length, b.length)) * 100).toFixed(1);

    console.log(
      `~ ${name}\n  ${a.length} B → ${b.length} B · ${ranges.length} region(s) · ${changedBytes} B changed (${share}%) · H ${entropy(a).toFixed(2)} → ${entropy(b).toFixed(2)}`,
    );

    // A stream where almost everything moved is recompressed or re-serialised
    // wholesale; the byte offsets in it carry no meaning worth printing.
    if (Number(share) > 60) {
      console.log('  (rewritten wholesale — offsets not comparable)');
      const runsBefore = findNumericRuns(a, 8, 24, 2);
      const runsAfter = findNumericRuns(b, 8, 24, 2);
      if (runsBefore[0] || runsAfter[0]) {
        console.log(
          `  longest f64 run: ${runsBefore[0]?.count ?? 0} → ${runsAfter[0]?.count ?? 0} values`,
        );
      }
      console.log();
      continue;
    }

    for (const range of ranges.slice(0, 8)) {
      console.log(`  @${range.offset} +${range.length}`);
      const numbers = [...changedNumbers(a, b, range, 8), ...changedNumbers(a, b, range, 4)];
      for (const line of numbers.slice(0, 8)) console.log(line);
    }
    if (ranges.length > 8) console.log(`  … and ${ranges.length - 8} more regions`);
    console.log();
  }

  if (onlyBefore.length > 0) console.log(`only in ${path.basename(beforeFile)}: ${onlyBefore.join(', ')}`);
  if (onlyAfter.length > 0) console.log(`only in ${path.basename(afterFile)}: ${onlyAfter.join(', ')}`);
  console.log(`unchanged streams (${identical.length}): ${identical.slice(0, 20).join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
