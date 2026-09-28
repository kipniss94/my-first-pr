/**
 * Where the files of an assembly were, and which of the files found on this
 * computer is the one it means.
 *
 * SolidWorks records, for every file an assembly references, the full path it
 * had when the assembly was saved — often on another computer, a PDM vault or
 * another drive. The absolute path is useless here, but the shape of it is
 * not: a part two folders up and across from the assembly then is two folders
 * up and across from it now, and a folder called "в2" is not "в1". Files a
 * browser hands over carry only their path inside what was dropped, so all of
 * this compares folder names, never drives.
 */

/** Folder and file names of a path, whichever separator it uses. */
export function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== '.');
}

const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

/** Segments with `..` applied; a `..` that climbs above the start is kept. */
function normalise(segments: string[]): string[] {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop();
    else out.push(segment);
  }
  return out;
}

/** The folder a file is in. */
function folderOf(path: string): string[] {
  return pathSegments(path).slice(0, -1);
}

/** Number of leading segments two folders share. */
function sharedStart(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && same(a[n], b[n])) n += 1;
  return n;
}

/** Number of trailing segments two folders share. */
function sharedEnd(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && same(a[a.length - 1 - n], b[b.length - 1 - n])) n += 1;
  return n;
}

/**
 * The folder of `to` seen from the folder of `from`, e.g. `['..', '..',
 * 'Библиотека', 'Ручка']`, or `[]` when both were side by side. Null when the
 * two were on different drives or roots and have nothing in common.
 */
export function relativeFolder(from: string, to: string): string[] | null {
  const a = folderOf(from);
  const b = folderOf(to);
  const common = sharedStart(a, b);
  if (common === 0 && a.length > 0 && b.length > 0) return null;
  return [...Array<string>(a.length - common).fill('..'), ...b.slice(common)];
}

/** The deepest folder holding every one of the files. */
export function commonFolder(files: string[]): string[] {
  const folders = files.map(folderOf);
  if (folders.length === 0) return [];
  let common = folders[0];
  for (const folder of folders.slice(1)) common = common.slice(0, sharedStart(common, folder));
  return common;
}

export interface RecordedLocation {
  /** Where SolidWorks recorded the file the assembly wants. */
  recorded: string;
  /** Where SolidWorks recorded the assembly itself. */
  assemblyRecorded?: string | null;
  /** The assembly's path inside the same drop as the candidates, when known. */
  assemblyHere?: string | null;
}

/**
 * How well a file found here fits where the assembly recorded it; higher is
 * better, and only the order matters.
 *
 * Best is the exact spot: the recorded way from the assembly to the part,
 * walked from where the assembly is now. Then the more of the recorded
 * folders the candidate's folders end with, the better ("3д модель\в2" beats
 * a lone "3д модель"). Last, closeness to the assembly breaks ties between
 * copies that look alike — the one beside it rather than one in another
 * version of the project.
 */
export function locationScore(candidate: string, where: RecordedLocation): number {
  const here = folderOf(candidate);
  let score = sharedEnd(here, folderOf(where.recorded)) * 100;
  if (where.assemblyHere) {
    const assembly = folderOf(where.assemblyHere);
    if (where.assemblyRecorded) {
      const way = relativeFolder(where.assemblyRecorded, where.recorded);
      if (way) {
        const expected = normalise([...assembly, ...way]);
        if (expected.length === here.length && sharedStart(expected, here) === here.length) score += 100_000;
      }
    }
    score += sharedStart(here, assembly);
  }
  return score;
}

/** The candidate that best fits the recorded location; the first on a tie. */
export function bestLocated<T>(candidates: T[], pathOf: (candidate: T) => string, where: RecordedLocation | null): T | undefined {
  if (!where || candidates.length < 2) return candidates[0];
  let best = candidates[0];
  let bestScore = locationScore(pathOf(best), where);
  for (const candidate of candidates.slice(1)) {
    const score = locationScore(pathOf(candidate), where);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
