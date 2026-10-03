'use client';

import { useSyncExternalStore } from 'react';
import {
  ACCEPTED_EXTENSIONS,
  bestLocated,
  locationScore,
  type AssemblyComponent,
  type AssemblyState,
  type RecordedLocation,
} from '@docuview/shared';
import { uploadComponent } from './api';
import { formatBytes } from './format';
import {
  allSessions,
  forgetSession,
  getSession,
  refreshSession,
  startUpload,
  whenSettled,
  type Session,
} from './session';

/**
 * Opening files, one or many, the way they arrive: dropped on the window,
 * picked in a dialog, a whole folder at once.
 *
 * One file opens in its own tab. Several open one after another, each in its
 * own tab — unless they belong together. Assemblies are opened first and read
 * for the parts they are made of; every part one of them asks for is handed
 * to it instead of opening on its own, a sub-assembly already laid out inside
 * a dropped assembly is folded into it, and what is still missing is said out
 * loud, file by file. Parts an assembly opened earlier is waiting for go to it
 * the same way.
 */

export const FALLBACK_MAX_BYTES = 250 * 1024 * 1024;

export function extensionOf(name: string): string {
  return /\.([A-Za-z0-9_]{1,12})$/.exec(name)?.[1].toLowerCase() ?? '';
}

const isAssemblyFile = (name: string) => extensionOf(name) === 'sldasm';

/** Why this file cannot be opened, or null when it can. */
export function refusal(file: File, maxBytes: number): { message: string; hint: string } | null {
  if (file.size === 0) return { message: `“${file.name}” is empty.`, hint: 'Pick a file that has content in it.' };
  if (file.size > maxBytes) {
    return {
      message: `“${file.name}” is ${formatBytes(file.size)}, over the ${formatBytes(maxBytes)} limit.`,
      hint: 'Try a compressed or simplified export.',
    };
  }
  const extension = extensionOf(file.name);
  if (extension && !ACCEPTED_EXTENSIONS.includes(`.${extension}`)) {
    return {
      message: `We can’t open “.${extension}” files yet.`,
      hint: 'CAD, 3D, PDF, Office and image formats are supported.',
    };
  }
  return null;
}

/* ------------------------------ dropped files ------------------------------ */

/** Paths of files that came out of dropped folders; a File does not keep its own. */
const located = new WeakMap<File, string>();

/**
 * Where a file was inside what was dropped or picked ("Project/v2/Part.SLDPRT"),
 * or just its name when it was dropped on its own.
 */
export function pathOf(file: File): string {
  return located.get(file) || file.webkitRelativePath || file.name;
}

/** Record where a file was found, for files that do not carry their own path. */
export function rememberPath(file: File, path: string): void {
  located.set(file, path);
}

/** Every file under dropped folders, however deep. */
export async function filesIn(entries: FileSystemEntry[]): Promise<File[]> {
  const files: File[] = [];
  const visit = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      located.set(file, entry.fullPath.replace(/^\/+/, ''));
      files.push(file);
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries hands the listing over in batches until it returns none.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) break;
      for (const child of batch) await visit(child);
    }
  };
  for (const entry of entries) await visit(entry);
  return files;
}

/**
 * The files of a drop, folders opened up. Must be called while the drop event
 * is being handled: the browser empties `dataTransfer` straight after.
 */
export function droppedFiles(data: DataTransfer | null): Promise<{ files: File[]; fromFolder: boolean }> {
  if (!data) return Promise.resolve({ files: [], fromFolder: false });
  const entries = Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null);
  if (entries.some((entry) => entry.isDirectory)) {
    return filesIn(entries).then((files) => ({ files, fromFolder: true }));
  }
  return Promise.resolve({ files: Array.from(data.files), fromFolder: false });
}

/* --------------------------------- report ---------------------------------- */

export interface AssemblyReport {
  name: string;
  sessionId: string;
  /** Components the assembly names. */
  total: number;
  /** Supplied by this drop. */
  attached: string[];
  /** Still not supplied by anyone. */
  missing: string[];
}

export interface OpenReport {
  assemblies: AssemblyReport[];
  /** Sub-assemblies whose parts are shown inside the assembly that uses them. */
  folded: { name: string; into: string }[];
  /** Files that were not opened, with the reason. */
  refused: string[];
  at: number;
}

let current: OpenReport | null = null;
const reportListeners = new Set<() => void>();

function publish(report: OpenReport | null): void {
  current = report;
  for (const listener of reportListeners) listener();
}

export function dismissOpenReport(): void {
  publish(null);
}

/** What the last drop did, for the banner in the viewer. */
export function useOpenReport(): OpenReport | null {
  return useSyncExternalStore(
    (listener) => {
      reportListeners.add(listener);
      return () => reportListeners.delete(listener);
    },
    () => current,
    () => null,
  );
}

/* --------------------------------- opening --------------------------------- */

export interface OpenOptions {
  /** Show this document. `replace` when the one on screen is going away. */
  navigate(sessionId: string, replace?: boolean): void;
  maxBytes?: number;
  /** Came from a folder: files we cannot open are skipped without comment. */
  fromFolder?: boolean;
}

export interface OpenOutcome {
  /** Documents opened in their own tabs, in order. */
  opened: string[];
  refused: { message: string; hint: string }[];
}

const componentsOf = (session: Session | null): AssemblyState['components'] =>
  session?.phase === 'ready' ? session.job?.assembly?.components ?? [] : [];

const metaString = (session: Session | null, key: string): string | null => {
  const value = session?.job?.result?.meta[key];
  return typeof value === 'string' && value ? value : null;
};

/** Where an assembly recorded a file, for telling copies of it apart. */
export function recordedLocation(
  recorded: string | null | undefined,
  assemblyRecorded: string | null,
  assemblyHere: string | null,
): RecordedLocation | null {
  return recorded ? { recorded, assemblyRecorded, assemblyHere } : null;
}

const locationIn = (assembly: Session, name: string, component?: AssemblyComponent): RecordedLocation | null => {
  const paths = assembly.job?.result?.meta.referencedPaths as Record<string, string> | undefined;
  return recordedLocation(
    component?.originalPath ?? paths?.[name.toLowerCase()],
    metaString(assembly, 'originalPath'),
    assembly.sourcePath,
  );
};

const namesIn = (session: Session | null, key: string): Set<string> => {
  const value = session?.job?.result?.meta[key];
  return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase()) : []);
};

/** The candidate whose recorded place for `path` fits best; the first when none says. */
function bestOf<T>(candidates: T[], where: (candidate: T) => RecordedLocation | null, path: string): T | undefined {
  let best: T | undefined;
  let bestScore = -1;
  for (const candidate of candidates) {
    const location = where(candidate);
    const score = location ? locationScore(path, location) : 0;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** At most this many components are sent at once, across all assemblies. */
const PARALLEL_COMPONENTS = 3;

export async function openFiles(input: File[], options: OpenOptions): Promise<OpenOutcome> {
  const maxBytes = options.maxBytes ?? FALLBACK_MAX_BYTES;
  const refused: { message: string; hint: string }[] = [];
  const files: File[] = [];
  const seen = new Set<string>();
  for (const file of input) {
    // SolidWorks' lock files sit beside every open document.
    if (file.name.startsWith('~$')) continue;
    const why = refusal(file, maxBytes);
    if (why) {
      refused.push(why);
      continue;
    }
    // The same name in two folders is kept: two versions of a project, or a
    // library copy. Which one an assembly means is decided by where it is.
    const key = pathOf(file).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(file);
  }
  // Unsupported files in a folder are expected (drawings, notes); say nothing.
  const shownRefusals = options.fromFolder ? refused.filter((r) => !r.message.startsWith('We can’t open')) : refused;
  if (files.length === 0) return { opened: [], refused: shownRefusals };

  const assemblies = files.filter((file) => isAssemblyFile(file.name));
  const others = files.filter((file) => !isAssemblyFile(file.name));
  const opened: string[] = [];

  /* 1. Assemblies first: what they are made of decides where the rest goes. */
  const fresh = assemblies.map((file) => ({ file, id: startUpload(file, undefined, pathOf(file)) }));
  opened.push(...fresh.map((entry) => entry.id));
  if (fresh.length > 0) options.navigate(fresh[0].id);
  await Promise.all(fresh.map((entry) => whenSettled(entry.id)));

  /* 2. A sub-assembly another assembly already lays out is shown inside it. */
  // Assemblies opened earlier may have been given parts since their job was
  // last read; ask again, or those parts would be sent twice.
  const freshIds = new Set(fresh.map((entry) => entry.id));
  const open = allSessions().filter((session) => session.phase === 'ready' && session.job?.assembly);
  await Promise.all(open.filter((session) => !freshIds.has(session.id)).map((session) => refreshSession(session.id)));
  const candidates = open.map((session) => getSession(session.id)).filter((session): session is Session => session !== null);
  const parentOf = new Map<string, string>();
  for (const sub of fresh) {
    const name = sub.file.name.toLowerCase();
    const parents = candidates.filter(
      (session) =>
        session.id !== sub.id &&
        namesIn(session, 'referencedFiles').has(name) &&
        !namesIn(session, 'unexpandedAssemblies').has(name) &&
        // Never fold two assemblies into each other.
        namesIn(getSession(sub.id), 'referencedFiles').has(session.fileName.toLowerCase()) === false,
    );
    // Two versions of a project both name this sub-assembly: it belongs to
    // the one whose recorded place for it is where it actually is.
    const parent = bestOf(parents, (session) => locationIn(session, name), pathOf(sub.file));
    // A sub-assembly dropped on its own is opened on its own: that is how one
    // looks at just that unit.
    if (parent && files.length > 1 && getSession(sub.id)?.phase === 'ready') parentOf.set(sub.id, parent.id);
  }
  const topOf = (id: string): string => {
    let at = id;
    for (let guard = 0; parentOf.has(at) && guard < 32; guard += 1) at = parentOf.get(at)!;
    return at;
  };
  const folded = [...parentOf.keys()].map((id) => ({
    name: getSession(id)?.fileName ?? '',
    into: getSession(topOf(id))?.fileName ?? '',
  }));
  const targets = candidates.filter((session) => !parentOf.has(session.id));

  /* 3. Parts go to every assembly that asks for them — the right copy each. */
  const attach: { target: Session; file: File }[] = [];
  const byName = new Map<string, File[]>();
  for (const file of others) byName.set(file.name.toLowerCase(), [...(byName.get(file.name.toLowerCase()) ?? []), file]);
  const related = new Set<string>();
  for (const target of targets) {
    for (const component of componentsOf(target)) {
      const key = component.name.toLowerCase();
      const copies = byName.get(key);
      if (!copies) continue;
      related.add(key);
      if (component.status !== 'missing' && component.status !== 'failed') continue;
      const where = locationIn(target, key, component);
      const file = where ? bestLocated(copies, pathOf, where) : copies[0];
      if (file) attach.push({ target, file });
    }
  }
  // One part dropped on its own is opened even if an assembly already has
  // it: that is how one looks at a single part. From a batch, a part an
  // assembly names is not opened a second time.
  const alone = others.length === 1 && assemblies.length === 0;
  const leftovers = others.filter(
    (file) => !related.has(file.name.toLowerCase()) || (alone && !attach.some((entry) => entry.file === file)),
  );

  /* 4. The rest open on their own, one after another. */
  for (const file of leftovers) opened.push(startUpload(file, undefined, pathOf(file)));

  // Put the right thing on screen before the folded tabs close.
  const firstFresh = fresh[0]?.id;
  if (firstFresh && parentOf.has(firstFresh)) options.navigate(topOf(firstFresh), true);
  else if (!firstFresh && leftovers.length > 0) options.navigate(opened[0]);
  else if (!firstFresh && attach.length > 0) options.navigate(attach[0].target.id);
  for (const id of parentOf.keys()) forgetSession(id);
  const openedTabs = opened.filter((id) => !parentOf.has(id));

  /* 5. Say what comes together and what does not, straight away. */
  const reported = new Map<string, AssemblyReport>();
  const involved = [
    ...targets.filter((session) => freshIds.has(session.id)),
    ...attach.map((entry) => entry.target),
  ];
  for (const target of involved) {
    if (reported.has(target.id)) continue;
    const session = getSession(target.id);
    const components = componentsOf(session);
    const coming = new Set(attach.filter((entry) => entry.target.id === target.id).map((entry) => entry.file.name.toLowerCase()));
    reported.set(target.id, {
      name: session?.fileName ?? target.fileName,
      sessionId: target.id,
      total: components.length,
      attached: attach.filter((entry) => entry.target.id === target.id).map((entry) => entry.file.name),
      // Known now, before a single part is sent: what nobody supplied.
      missing: components.filter((c) => c.status === 'missing' && !coming.has(c.name.toLowerCase())).map((c) => c.name),
    });
  }
  const assemblyReports = [...reported.values()];
  const report: OpenReport = {
    assemblies: assemblyReports,
    folded,
    refused: shownRefusals.map((r) => r.message),
    at: Date.now(),
  };
  if (assemblyReports.length > 0 || folded.length > 0 || (report.refused.length > 0 && openedTabs.length > 0)) {
    publish(report);
  }

  /* 6. Then hand each assembly its parts; each one appears as it is ready. */
  const queue = [...attach];
  const worker = async (): Promise<void> => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const parentJobId = job.target.jobId;
      if (!parentJobId) continue;
      try {
        await uploadComponent(parentJobId, job.file).promise;
      } catch {
        /* Shown as missing in the assembly's own list, which says why. */
      }
      await refreshSession(job.target.id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_COMPONENTS, queue.length) }, worker));

  return { opened: openedTabs, refused: shownRefusals };
}
