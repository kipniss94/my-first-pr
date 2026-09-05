/**
 * Hunt for a known dimension inside a `.SLDPRT`.
 *
 *   npx tsx scripts/sldprt/find.ts <file.sldprt> 45.5 12 8
 *
 * The most direct route into an unknown geometry format: take a measurement you
 * know from the model — an overall length, a hole diameter — and find where
 * that number is written. Every hit is a coordinate field whose meaning is
 * already known, which anchors everything around it.
 *
 * Each value is searched in millimetres and in metres, because SolidWorks works
 * in metres internally while an engineer reads millimetres off the drawing.
 * Halves are searched too: a part is very often modelled about its own centre,
 * so a 45.5 mm length shows up as ±22.75 mm.
 *
 * Both byte orders are searched. That is not defensive coding: the geometry in
 * a SolidWorks part lives in a Parasolid partition, and Parasolid stores its
 * reals **big-endian**. Searching only little-endian finds nothing at all, which
 * is exactly what this tool did before the first real file was examined.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { isCompoundFile, readCompoundFile } from '../../apps/api/src/processing/cfb.js';
import { probeCompression } from './inspect.js';

interface Hit {
  stream: string;
  offset: number;
  width: 4 | 8;
  order: 'LE' | 'BE';
  stored: number;
  /** Which interpretation matched, e.g. `45.5 mm as metres`. */
  as: string;
}

/** Relative tolerance: a stored double rarely round-trips exactly from a drawing. */
const TOLERANCE = 1e-9;

function close(a: number, b: number): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale > 0 && Math.abs(a - b) / scale < TOLERANCE;
}

function interpretations(value: number): { target: number; as: string }[] {
  return [
    { target: value, as: `${value} as-is` },
    { target: value / 1000, as: `${value} mm in metres` },
    { target: value * 1000, as: `${value} m in millimetres` },
    { target: value / 2, as: `half of ${value}` },
    { target: value / 2000, as: `half of ${value} mm in metres` },
    { target: -value / 2000, as: `minus half of ${value} mm in metres` },
  ];
}

function scan(stream: string, data: Buffer, values: number[]): Hit[] {
  const hits: Hit[] = [];
  const targets = values.flatMap(interpretations);

  const readers: { width: 4 | 8; order: 'LE' | 'BE'; read: (at: number) => number }[] = [
    { width: 8, order: 'BE', read: (at) => data.readDoubleBE(at) },
    { width: 8, order: 'LE', read: (at) => data.readDoubleLE(at) },
    { width: 4, order: 'BE', read: (at) => data.readFloatBE(at) },
    { width: 4, order: 'LE', read: (at) => data.readFloatLE(at) },
  ];

  for (const { width, order, read } of readers) {
    // Step one byte: a value can sit at an offset that is not a multiple of its
    // own width when it follows a variable-length header.
    for (let offset = 0; offset + width <= data.length; offset += 1) {
      let stored: number;
      try {
        stored = read(offset);
      } catch {
        break;
      }
      if (!Number.isFinite(stored) || stored === 0) continue;

      for (const { target, as } of targets) {
        // float32 cannot hold a double's precision, so compare at its own scale.
        const matched = width === 8 ? close(stored, target) : close(stored, Math.fround(target));
        if (matched) {
          hits.push({ stream, offset, width, order, stored, as });
          break;
        }
      }
      if (hits.length > 400) return hits;
    }
  }
  return hits;
}

function payload(data: Buffer): Buffer {
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

async function main(): Promise<void> {
  const [file, ...rest] = process.argv.slice(2);
  const values = rest.map(Number).filter((value) => Number.isFinite(value) && value !== 0);

  if (!file || values.length === 0) {
    console.error('usage: npx tsx scripts/sldprt/find.ts <file.sldprt> <value> [more values...]');
    console.error('       values are dimensions you can read off the model, in millimetres');
    process.exit(2);
  }

  const buffer = await fs.readFile(file);
  const streams: { path: string; data: Buffer }[] = [];

  if (isCompoundFile(buffer)) {
    const cfb = readCompoundFile(buffer);
    if (cfb) {
      for (const entry of cfb.entries) {
        if (entry.type === 2 && entry.size > 0) streams.push({ path: entry.path, data: payload(cfb.read(entry)) });
      }
    }
  }
  if (streams.length === 0) streams.push({ path: '<raw file>', data: buffer });

  console.log(`\n=== ${path.basename(file)} — looking for ${values.join(', ')} ===\n`);

  let total = 0;
  for (const stream of streams) {
    const hits = scan(stream.path, stream.data, values);
    if (hits.length === 0) continue;
    total += hits.length;

    console.log(`${stream.path}  (${stream.data.length} B) — ${hits.length} hit(s)`);
    // Cluster hits: a coordinate array produces many neighbouring offsets, and
    // that clustering is a stronger signal than any single hit.
    for (const hit of hits.slice(0, 15)) {
      console.log(
        `  @${String(hit.offset).padStart(8)} f${hit.width * 8}${hit.order} = ${hit.stored.toPrecision(10)}   ${hit.as}`,
      );
    }
    if (hits.length > 15) console.log(`  … and ${hits.length - 15} more`);

    const offsets = hits.map((hit) => hit.offset).sort((a, b) => a - b);
    const gaps = new Map<number, number>();
    for (let i = 1; i < offsets.length; i += 1) {
      const gap = offsets[i] - offsets[i - 1];
      if (gap > 0 && gap <= 256) gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
    }
    const common = [...gaps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (common.length > 0) {
      console.log(`  spacing: ${common.map(([gap, n]) => `${gap} B ×${n}`).join(', ')}`);
    }
    console.log();
  }

  if (total === 0) {
    console.log('No hits. Either the value is stored differently (scaled, quantised, or in a');
    console.log('compression we did not recognise), or the geometry stream is not readable.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
