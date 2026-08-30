/**
 * The bench instrument for reverse-engineering `.SLDPRT`.
 *
 *   npx tsx scripts/sldprt/inspect.ts <file.sldprt> [more files...]
 *
 * This is the "engineer looks at the bytes" step, mechanised. For every stream
 * inside the compound file it reports what the stream *is likely to be* — how
 * random it looks, whether it decompresses, whether it contains long runs of
 * plausible coordinates — because that is what separates a geometry stream from
 * a settings blob without anyone having to guess.
 *
 * It deliberately reuses the application's own CFB reader. If that reader
 * cannot open a real SolidWorks file, this tool says so loudly, which is itself
 * the first finding worth having.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { isCompoundFile, readCompoundFile, type CfbEntry } from '../../apps/api/src/processing/cfb.js';

/* ----------------------------- measurements ------------------------------- */

/** Shannon entropy in bits per byte. Above ~7.5 means compressed or encrypted. */
export function entropy(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  const counts = new Uint32Array(256);
  for (const byte of buffer) counts[byte] += 1;
  let bits = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const p = count / buffer.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

export interface CompressionProbe {
  kind: 'zlib' | 'gzip' | 'raw-deflate' | null;
  /** Offset the compressed payload starts at. */
  offset: number;
  inflatedBytes: number;
  inflatedEntropy: number;
}

/**
 * Try to decompress a stream.
 *
 * A container often prefixes its payload with a small header, so the zlib
 * signature is looked for at a bounded set of leading offsets rather than only
 * at zero. Raw deflate has no signature at all, so it is only attempted where a
 * zlib/gzip header did not match.
 */
export function probeCompression(buffer: Buffer, maxOffset = 64): CompressionProbe {
  const empty: CompressionProbe = { kind: null, offset: -1, inflatedBytes: 0, inflatedEntropy: 0 };
  if (buffer.length < 8) return empty;

  const limit = Math.min(maxOffset, buffer.length - 8);
  for (let offset = 0; offset <= limit; offset += 1) {
    const a = buffer[offset];
    const b = buffer[offset + 1];

    // zlib: CMF/FLG where CM=8 and the pair is a multiple of 31.
    if ((a & 0x0f) === 0x08 && ((a << 8) | b) % 31 === 0) {
      const out = tryInflate(() => zlib.inflateSync(buffer.subarray(offset)));
      if (out) return { kind: 'zlib', offset, inflatedBytes: out.length, inflatedEntropy: entropy(out) };
    }
    if (a === 0x1f && b === 0x8b) {
      const out = tryInflate(() => zlib.gunzipSync(buffer.subarray(offset)));
      if (out) return { kind: 'gzip', offset, inflatedBytes: out.length, inflatedEntropy: entropy(out) };
    }
  }

  // Raw deflate, only at the first few offsets: without a header this is a
  // guess, and a false positive here would send the analysis the wrong way.
  for (let offset = 0; offset <= Math.min(8, buffer.length - 8); offset += 1) {
    const out = tryInflate(() => zlib.inflateRawSync(buffer.subarray(offset)));
    if (out && out.length > buffer.length / 4) {
      return { kind: 'raw-deflate', offset, inflatedBytes: out.length, inflatedEntropy: entropy(out) };
    }
  }
  return empty;
}

function tryInflate(run: () => Buffer): Buffer | null {
  try {
    const out = run();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export interface NumericRun {
  /** Byte offset of the first value. */
  offset: number;
  /** How many consecutive plausible values. */
  count: number;
  width: 4 | 8;
  min: number;
  max: number;
  /** Share of values that are distinct, 0..1. Real coordinates score high. */
  variety: number;
}

/**
 * Find long runs of numbers that could be model coordinates.
 *
 * A vertex array is the one thing in a CAD file that looks like hundreds of
 * consecutive finite numbers inside a sane physical range. Anything else —
 * flags, ids, offsets, text — breaks the run almost immediately, so the longest
 * runs are where the geometry is.
 *
 * SolidWorks works in metres internally, so the plausible window is wide: a
 * 1 micron feature and a 100 metre weldment both have to pass.
 *
 * Plausibility alone is not enough, and getting this wrong wastes the whole
 * exercise. Image pixels, padding and repeated tags also decode into "finite
 * numbers in range" and produce long fake runs. A real vertex array is made of
 * mostly *different* numbers, so runs whose values keep repeating are dropped.
 */
export function findNumericRuns(
  buffer: Buffer,
  width: 4 | 8,
  minRun = 24,
  limit = 12,
  minVariety = 0.35,
): NumericRun[] {
  const read = width === 8 ? buffer.readDoubleLE.bind(buffer) : buffer.readFloatLE.bind(buffer);
  const plausible = (value: number): boolean =>
    Number.isFinite(value) && (value === 0 || (Math.abs(value) > 1e-7 && Math.abs(value) < 1e4));

  const runs: NumericRun[] = [];
  // Values are stored aligned in every format we have seen, so stepping by the
  // value width is both correct and four times cheaper than a byte-wise scan.
  for (let start = 0; start + width <= buffer.length; start += width) {
    let end = start;
    let min = Infinity;
    let max = -Infinity;
    const seen = new Set<number>();
    while (end + width <= buffer.length) {
      const value = read(end);
      if (!plausible(value)) break;
      if (value < min) min = value;
      if (value > max) max = value;
      if (seen.size < 4096) seen.add(value);
      end += width;
    }
    const count = (end - start) / width;
    if (count >= minRun) {
      const variety = Math.min(1, seen.size / Math.min(count, 4096));
      if (variety >= minVariety) runs.push({ offset: start, count, width, min, max, variety });
      start = end - width;
    } else if (count > 0) {
      start = end - width;
    }
  }

  return runs.sort((a, b) => b.count - a.count).slice(0, limit);
}

/**
 * Guess the record size of a table by looking for the stride that repeats most.
 *
 * Fixed-size records leave a fingerprint: the same 4-byte value (a type tag, a
 * small count, a padding word) recurs at a constant distance. The distance that
 * accounts for the most repeats is the likely record size.
 */
export function guessRecordStride(buffer: Buffer, maxStride = 512): { stride: number; hits: number }[] {
  if (buffer.length < 64) return [];
  const positions = new Map<number, number[]>();
  const sample = Math.min(buffer.length - 4, 1 << 20);

  for (let offset = 0; offset + 4 <= sample; offset += 4) {
    const key = buffer.readUInt32LE(offset);
    // Zero and 0xFFFFFFFF are everywhere and say nothing about structure.
    if (key === 0 || key === 0xffffffff) continue;
    const list = positions.get(key);
    if (list) {
      if (list.length < 64) list.push(offset);
    } else {
      positions.set(key, [offset]);
    }
  }

  const strides = new Map<number, number>();
  for (const list of positions.values()) {
    for (let i = 1; i < list.length; i += 1) {
      const gap = list[i] - list[i - 1];
      if (gap < 8 || gap > maxStride) continue;
      strides.set(gap, (strides.get(gap) ?? 0) + 1);
    }
  }

  return [...strides.entries()]
    .map(([stride, hits]) => ({ stride, hits }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 6);
}

/* -------------------------------- report ---------------------------------- */

export interface StreamReport {
  path: string;
  size: number;
  entropy: number;
  head: string;
  compression: CompressionProbe;
  /** Runs measured on the decompressed payload when there is one. */
  doubleRuns: NumericRun[];
  floatRuns: NumericRun[];
  strides: { stride: number; hits: number }[];
  /** Printable ASCII fragments, which usually name the thing. */
  strings: string[];
}

export interface FileReport {
  file: string;
  size: number;
  isCompoundFile: boolean;
  containerReadable: boolean;
  streamCount: number;
  streams: StreamReport[];
  notes: string[];
}

const PRINTABLE = /[\x20-\x7e]{6,}/g;

function extractStrings(buffer: Buffer, limit = 12): string[] {
  const found = new Set<string>();
  // Both encodings: stream payloads mix 8-bit and UTF-16 text freely.
  for (const text of [buffer.toString('latin1'), buffer.toString('utf16le')]) {
    for (const match of text.matchAll(PRINTABLE)) {
      const candidate = match[0].trim();
      // A row of identical characters is padding or image data, not a name.
      if (new Set(candidate).size < 3) continue;
      found.add(candidate.slice(0, 80));
      if (found.size >= limit * 3) break;
    }
  }
  return [...found].slice(0, limit);
}

function analyseStream(streamPath: string, data: Buffer): StreamReport {
  const compression = probeCompression(data);
  const payload =
    compression.kind !== null
      ? (tryInflate(() => inflateWith(compression, data)) ?? data)
      : data;

  return {
    path: streamPath,
    size: data.length,
    entropy: Number(entropy(data).toFixed(3)),
    head: data.subarray(0, 24).toString('hex'),
    compression,
    doubleRuns: findNumericRuns(payload, 8),
    floatRuns: findNumericRuns(payload, 4),
    strides: guessRecordStride(payload),
    strings: extractStrings(payload.subarray(0, 1 << 16)),
  };
}

function inflateWith(probe: CompressionProbe, data: Buffer): Buffer {
  const body = data.subarray(probe.offset);
  if (probe.kind === 'zlib') return zlib.inflateSync(body);
  if (probe.kind === 'gzip') return zlib.gunzipSync(body);
  return zlib.inflateRawSync(body);
}

export async function inspectFile(file: string): Promise<FileReport> {
  const buffer = await fs.readFile(file);
  const notes: string[] = [];
  const report: FileReport = {
    file: path.basename(file),
    size: buffer.length,
    isCompoundFile: isCompoundFile(buffer),
    containerReadable: false,
    streamCount: 0,
    streams: [],
    notes,
  };

  if (!report.isCompoundFile) {
    notes.push('Not a compound file: the first eight bytes are not the CFB signature.');
    report.streams.push(analyseStream('<raw file>', buffer));
    return report;
  }

  const cfb = readCompoundFile(buffer);
  if (!cfb) {
    // This is a finding, not a failure to be swallowed: it means the reader in
    // the application would fail on this file too.
    notes.push('CFB signature present but our reader could not parse the container.');
    report.streams.push(analyseStream('<raw file>', buffer));
    return report;
  }

  report.containerReadable = true;
  const streams = cfb.entries.filter((entry) => entry.type === 2);
  report.streamCount = streams.length;

  for (const entry of streams.sort((a, b) => b.size - a.size)) {
    if (entry.size === 0) continue;
    report.streams.push(analyseStream(entry.path, cfb.read(entry)));
  }

  const storages = cfb.entries.filter((entry) => entry.type === 1);
  if (storages.length > 0) {
    notes.push(`Storages: ${storages.map((s) => s.path).join(', ')}`);
  }
  return report;
}

/* --------------------------------- output ---------------------------------- */

function printReport(report: FileReport): void {
  console.log(`\n=== ${report.file} — ${(report.size / 1024).toFixed(1)} KB ===`);
  console.log(`compound file: ${report.isCompoundFile} · readable: ${report.containerReadable} · streams: ${report.streamCount}`);
  for (const note of report.notes) console.log(`note: ${note}`);

  console.log(
    `\n${'stream'.padEnd(38)} ${'size'.padStart(9)} ${'H'.padStart(5)} ${'zip'.padEnd(12)} ${'f64 run'.padStart(8)} ${'f32 run'.padStart(8)}  stride`,
  );
  for (const stream of report.streams) {
    const zip = stream.compression.kind
      ? `${stream.compression.kind}@${stream.compression.offset}`
      : '-';
    const f64 = stream.doubleRuns[0]?.count ?? 0;
    const f32 = stream.floatRuns[0]?.count ?? 0;
    const stride = stream.strides[0] ? `${stream.strides[0].stride}(${stream.strides[0].hits})` : '-';
    console.log(
      `${stream.path.slice(0, 38).padEnd(38)} ${String(stream.size).padStart(9)} ${stream.entropy.toFixed(2).padStart(5)} ${zip.padEnd(12)} ${String(f64).padStart(8)} ${String(f32).padStart(8)}  ${stride}`,
    );
  }

  // The interesting streams get a closer look: this is where geometry hides.
  const candidates = report.streams
    .filter((s) => (s.doubleRuns[0]?.count ?? 0) >= 48 || (s.floatRuns[0]?.count ?? 0) >= 48)
    .slice(0, 6);

  if (candidates.length > 0) {
    console.log('\n--- geometry candidates ---');
    for (const stream of candidates) {
      console.log(`\n${stream.path}  (${stream.size} B, H=${stream.entropy})`);
      for (const run of [...stream.doubleRuns.slice(0, 3), ...stream.floatRuns.slice(0, 3)]) {
        console.log(
          `  f${run.width * 8} @${run.offset}: ${run.count} values, ${run.min.toExponential(3)} … ${run.max.toExponential(3)}, variety ${(run.variety * 100).toFixed(0)}%`,
        );
      }
      if (stream.strings.length > 0) console.log(`  text: ${stream.strings.slice(0, 5).join(' | ')}`);
    }
  }
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: npx tsx scripts/sldprt/inspect.ts <file.sldprt> [...]');
    process.exit(2);
  }

  const outDir = path.resolve('docs/sldprt/reports');
  await fs.mkdir(outDir, { recursive: true });

  for (const file of files) {
    try {
      const report = await inspectFile(file);
      printReport(report);
      const target = path.join(outDir, `${path.basename(file)}.json`);
      await fs.writeFile(target, JSON.stringify(report, null, 2));
      console.log(`\nreport → ${path.relative(process.cwd(), target)}`);
    } catch (err) {
      console.error(`FAILED ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// Only run as a CLI; the differ imports the analysis functions above.
if (process.argv[1] && process.argv[1].endsWith('inspect.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
