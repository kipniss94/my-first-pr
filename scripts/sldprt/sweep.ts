/**
 * Run the container reader over every sample and report what it reaches.
 *
 *   npx tsx scripts/sldprt/sweep.ts
 *
 * A corpus-wide pass, not a spot check: a reader that works on the file you
 * happened to open is worth very little, and the failures are the interesting
 * part.
 */
import fs from 'node:fs';
import path from 'node:path';
import { findParasolidPartitions, isSolidWorksPackage } from '../../apps/api/src/processing/sldprt/container.js';

const dir = process.argv[2] ?? 'samples';
const files = fs.readdirSync(dir).filter((f) => /\.(sldprt|sldasm)$/i.test(f)).sort();

let recognised = 0;
const sizes: number[] = [];
const failed: string[] = [];

for (const name of files) {
  const buffer = fs.readFileSync(path.join(dir, name));
  if (isSolidWorksPackage(buffer)) recognised += 1;
  const partitions = findParasolidPartitions(buffer);
  if (partitions.length > 0 && partitions[0].data.length > 512) sizes.push(partitions[0].data.length);
  else failed.push(`${name} (${(buffer.length / 1024).toFixed(0)} KB, ${partitions.length} parasolid streams)`);
}

sizes.sort((a, b) => a - b);
console.log(`files              ${files.length}`);
console.log(`recognised         ${recognised}`);
console.log(`geometry extracted ${sizes.length}`);
if (sizes.length > 0) {
  const total = sizes.reduce((a, b) => a + b, 0);
  console.log(`partition bytes    min ${sizes[0]}  median ${sizes[sizes.length >> 1]}  max ${sizes[sizes.length - 1]}  total ${(total / 1048576).toFixed(1)} MB`);
}
if (failed.length > 0) {
  console.log(`\nno geometry (${failed.length}):`);
  for (const line of failed.slice(0, 20)) console.log(`  ${line}`);
}
