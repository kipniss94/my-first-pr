'use client';

import { locationScore } from '@docuview/shared';
import { rememberPath } from './open';

/**
 * Finding an assembly's missing files under a folder the user points at.
 *
 * Edge and Chrome let a page walk a chosen folder itself: only the files the
 * assembly needs are read, however big the tree, and the browser does not
 * first ask to "upload" thousands of unrelated files. Elsewhere the folder
 * picker hands over every file and the same matching runs on that list.
 */

export interface FoundCopy {
  file: File;
  /** Path inside the chosen folder, the folder's own name first. */
  path: string;
  modified: number;
  size: number;
}

export interface ScanProgress {
  folders: number;
  files: number;
  /** Distinct wanted names found so far. */
  found: number;
}

export interface ScanResult {
  /** Copies found per wanted name (lower case). */
  copies: Map<string, FoundCopy[]>;
  folders: number;
  files: number;
}

/* Minimal typings of the File System Access API, which TypeScript's DOM library lacks. */
interface DirectoryHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<DirectoryHandle | FileHandle>;
}
interface FileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}
type PickerWindow = Window & {
  showDirectoryPicker?: (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<DirectoryHandle>;
};

/** True when the browser can walk a folder itself. */
export function canWalkFolders(): boolean {
  return typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function';
}

/** System and tool folders nobody keeps parts in, and that are slow or forbidden to read. */
const SKIPPED = /^(\$|\.)|^(System Volume Information|node_modules|Windows|ProgramData|AppData)$/i;

export class ScanCancelled extends Error {}

/**
 * Ask for a folder and walk it. Null when the user closed the picker.
 * `wanted` holds lower-case file names.
 */
export async function pickAndScan(
  wanted: Set<string>,
  onProgress: (progress: ScanProgress) => void,
  signal: AbortSignal,
): Promise<ScanResult | null> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) return null;
  let root: DirectoryHandle;
  try {
    root = await picker({ id: 'docuview-parts', mode: 'read' });
  } catch {
    return null;
  }

  const copies = new Map<string, FoundCopy[]>();
  const progress: ScanProgress = { folders: 0, files: 0, found: 0 };
  let lastReport = 0;
  const report = (force = false) => {
    const now = performance.now();
    if (!force && now - lastReport < 120) return;
    lastReport = now;
    onProgress({ ...progress });
  };

  const walk = async (directory: DirectoryHandle, path: string): Promise<void> => {
    if (signal.aborted) throw new ScanCancelled();
    progress.folders += 1;
    report();
    let entries: AsyncIterable<DirectoryHandle | FileHandle>;
    try {
      entries = directory.values();
    } catch {
      return;
    }
    const subfolders: [DirectoryHandle, string][] = [];
    try {
      for await (const entry of entries) {
        if (signal.aborted) throw new ScanCancelled();
        if (entry.kind === 'directory') {
          if (!SKIPPED.test(entry.name)) subfolders.push([entry, `${path}/${entry.name}`]);
          continue;
        }
        progress.files += 1;
        const key = entry.name.toLowerCase();
        if (!wanted.has(key)) continue;
        try {
          const file = await entry.getFile();
          const filePath = `${path}/${entry.name}`;
          rememberPath(file, filePath);
          const list = copies.get(key) ?? [];
          if (list.length === 0) progress.found += 1;
          list.push({ file, path: filePath, modified: file.lastModified, size: file.size });
          copies.set(key, list);
        } catch {
          /* locked or vanished: as if it were not there */
        }
      }
    } catch (err) {
      if (err instanceof ScanCancelled) throw err;
      return; // a folder we may not read
    }
    for (const [folder, folderPath] of subfolders) await walk(folder, folderPath);
  };

  await walk(root, root.name);
  report(true);
  return { copies, folders: progress.folders, files: progress.files };
}

/** The same matching over the files a folder picker handed over. */
export function scanFileList(files: File[], wanted: Set<string>): ScanResult {
  const copies = new Map<string, FoundCopy[]>();
  const folders = new Set<string>();
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    folders.add(path.split('/').slice(0, -1).join('/'));
    const key = file.name.toLowerCase();
    if (!wanted.has(key)) continue;
    rememberPath(file, path);
    copies.set(key, [...(copies.get(key) ?? []), { file, path, modified: file.lastModified, size: file.size }]);
  }
  return { copies, folders: folders.size, files: files.length };
}

/**
 * Of several copies of one file, the one to suggest: the copy in the folder
 * the assembly recorded for it when its folder names say so, else the newest.
 */
export function suggestedCopy(copies: FoundCopy[], recorded: string | null): { index: number; byPlace: number | null } {
  let newest = 0;
  for (let k = 1; k < copies.length; k += 1) if (copies[k].modified > copies[newest].modified) newest = k;
  if (!recorded) return { index: newest, byPlace: null };
  const scores = copies.map((copy) => locationScore(copy.path, { recorded }));
  const best = Math.max(...scores);
  // Only a match of at least the file's own folder name counts, and only a clear one.
  if (best < 100 || scores.filter((score) => score === best).length > 1) return { index: newest, byPlace: null };
  const byPlace = scores.indexOf(best);
  return { index: byPlace, byPlace };
}
