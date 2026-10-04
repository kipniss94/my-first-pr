'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { commonFolder, pathSegments } from '@docuview/shared';
import type { ComponentView } from '@/lib/assembly';
import {
  canWalkFolders,
  pickAndScan,
  ScanCancelled,
  scanFileList,
  suggestedCopy,
  type FoundCopy,
  type ScanProgress,
  type ScanResult,
} from '@/lib/folder-scan';
import { formatBytes, formatCount } from '@/lib/format';
import { filesIn } from '@/lib/open';
import { useT } from '@/lib/prefs';

/** The folder that held the assembly and all its parts, as SolidWorks recorded them. */
export interface Storage {
  name: string;
  /** Folders between it and the assembly's own folder. */
  levelsUp: number;
  /** Its depth in the recorded paths, to show each part's place below it. */
  depth: number;
  path: string[];
}

/** Where a part was kept: below the common folder when it was there, else its whole folder. */
function keptIn(originalPath: string, storage: Storage): string {
  const folder = pathSegments(originalPath).slice(0, -1);
  const inside = commonFolder([storage.path.join('/') + '/x', originalPath]).length === storage.depth;
  return (inside ? [storage.name, ...folder.slice(storage.depth)] : folder).join('\\');
}

/** Puts text on the clipboard, with the old route for browsers that refuse the new one. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = window.document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    window.document.body.appendChild(area);
    area.select();
    const done = window.document.execCommand('copy');
    area.remove();
    return done;
  }
}

const SEARCH_ROOT_KEY = 'docuview.searchRoot';

function readSearchRoot(): string {
  try {
    return window.localStorage.getItem(SEARCH_ROOT_KEY) || 'C:\\';
  } catch {
    return 'C:\\';
  }
}

/**
 * Windows Explorer's own search, opened on a file name. The browser asks
 * before handing the link to Windows; Explorer then shows every file of that
 * name under the folder, ready to be dragged back onto this page.
 */
function explorerSearch(name: string, root: string): string {
  return `search-ms:query=${encodeURIComponent(name)}&crumb=location:${encodeURIComponent(root)}&displayname=${encodeURIComponent(`DocuView: ${name}`)}`;
}

interface VersionGroup {
  /** The file name the assembly asks for. */
  name: string;
  /** Copies found, newest first. */
  copies: FoundCopy[];
  selected: number;
  /** The copy in the folder the assembly recorded, when one clearly is. */
  byPlace: number | null;
}

/**
 * The parts of an assembly: which are here, which are missing, and the ways
 * to bring the missing ones in — a folder searched with all its subfolders,
 * a drop, or one file at a time.
 */
export function ComponentsPanel({
  components,
  counts,
  occurrences,
  placed,
  placementsTotal,
  stored = 0,
  onAdd,
  rejected,
  onDismissRejected,
  disabled,
  storage,
}: {
  components: ComponentView[];
  counts: { missing: number; pending: number; ready: number; failed: number };
  /** How many times the assembly places each part, by lower-case file name. */
  occurrences: Map<string, number>;
  /** Occurrences of parts in their own files now standing in the scene. */
  placed: number;
  placementsTotal: number;
  /** Occurrences drawn from the graphics kept in the assembly, their files not added. */
  stored?: number;
  onAdd(files: File[]): void;
  rejected: { name: string; message: string } | null;
  onDismissRejected(): void;
  disabled: boolean;
  storage: Storage | null;
}) {
  const { t, tp, tx } = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const locateRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  /** The component a "Locate…" dialog is open for. */
  const [locating, setLocating] = useState<string | null>(null);
  /** Parts shown from a file of another name, which the user chose on purpose. */
  const [substitutes, setSubstitutes] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [searchRoot, setSearchRoot] = useState('C:\\');
  const [editingRoot, setEditingRoot] = useState(false);
  /** A folder being searched for the missing files. */
  const [scanning, setScanning] = useState<ScanProgress | null>(null);
  const scanAbort = useRef<AbortController | null>(null);
  /** What the last folder search found. */
  const [scanOutcome, setScanOutcome] = useState<{
    found: number;
    wanted: number;
    notFound: string[];
    folders: number;
  } | null>(null);
  /** Files found more than once, waiting for the user to pick a version. */
  const [choosing, setChoosing] = useState<{ groups: VersionGroup[]; ready: File[] } | null>(null);

  useEffect(() => setSearchRoot(readSearchRoot()), []);

  const say = useCallback((text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((current) => (current === text ? null : current)), 6000);
  }, []);

  const accept = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return;
      onAdd(Array.from(list));
    },
    [onAdd],
  );

  /** Copy the name, then open the file dialog: paste it into the dialog's search box. */
  const locate = useCallback(
    async (name: string) => {
      const copied = await copyText(name);
      setLocating(name);
      say(
        copied
          ? t(
              '“{name}” is copied. In the window that opens, paste it (Ctrl+V) into the search box at the top right, or into “File name”.',
              { name },
            )
          : t('Look for “{name}” in the window that opens.', { name }),
      );
      const input = locateRef.current;
      if (input) {
        const extension = /\.[^.]+$/.exec(name)?.[0];
        input.accept = extension ?? '';
        input.click();
      }
    },
    [say, t],
  );

  const copyName = useCallback(
    async (name: string) => {
      if (await copyText(name)) say(t('Copied “{name}”.', { name }));
    },
    [say, t],
  );

  const missingNames = components.filter((c) => c.status === 'missing' || c.status === 'failed').map((c) => c.name);
  const total = components.length;
  const resolved = counts.ready;

  /** Sort out what a folder search found: one copy goes straight in, several wait for a choice. */
  const resolveScan = useCallback(
    (result: ScanResult) => {
      const groups: VersionGroup[] = [];
      const ready: File[] = [];
      const notFound: string[] = [];
      for (const name of missingNames) {
        const found = result.copies.get(name.toLowerCase()) ?? [];
        if (found.length === 0) notFound.push(name);
        else if (found.length === 1) ready.push(found[0].file);
        else {
          const copies = [...found].sort((a, b) => b.modified - a.modified);
          const recorded = components.find((c) => c.name === name)?.originalPath ?? null;
          const { index, byPlace } = suggestedCopy(copies, recorded);
          groups.push({ name, copies, selected: index, byPlace });
        }
      }
      setScanOutcome({
        found: missingNames.length - notFound.length,
        wanted: missingNames.length,
        notFound,
        folders: result.folders,
      });
      if (groups.length > 0) setChoosing({ groups, ready });
      else if (ready.length > 0) onAdd(ready);
    },
    [components, missingNames, onAdd],
  );

  /** Ask for a folder and search all of it, subfolders included, for the missing files. */
  const findInFolder = useCallback(async () => {
    if (missingNames.length === 0) {
      say(t('Every component already has its file.'));
      return;
    }
    setScanOutcome(null);
    if (!canWalkFolders()) {
      // This browser can only hand over a whole folder; the matching is the same.
      folderRef.current?.click();
      return;
    }
    const controller = new AbortController();
    scanAbort.current = controller;
    setScanning({ folders: 0, files: 0, found: 0 });
    try {
      const wanted = new Set(missingNames.map((name) => name.toLowerCase()));
      const result = await pickAndScan(wanted, setScanning, controller.signal);
      if (result) resolveScan(result);
    } catch (err) {
      say(err instanceof ScanCancelled ? t('The search was stopped.') : t('The folder could not be read.'));
    } finally {
      scanAbort.current = null;
      setScanning(null);
    }
  }, [missingNames, resolveScan, say, t]);

  return (
    <section className="border-b border-line p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="field-label">{t('Components')}</h2>
        <span className="font-mono text-[11px] text-mist-500" data-testid="component-count">
          {resolved}/{total}
        </span>
      </div>
      {placementsTotal > 0 && (
        <p className="mt-1 text-[11px] text-mist-500" data-testid="placed-count">
          {placed === placementsTotal
            ? tp(
                placementsTotal,
                ['The one occurrence stands where the assembly puts it.', 'All {n} occurrences stand where the assembly puts them.'],
                [
                  'Все {n} вхождение стоят там, где их ставит сборка.',
                  'Все {n} вхождения стоят там, где их ставит сборка.',
                  'Все {n} вхождений стоят там, где их ставит сборка.',
                ],
              )
            : tp(
                placementsTotal,
                ['{placed} of {n} occurrence placed.', '{placed} of {n} occurrences placed.'],
                ['Расставлено {placed} из {n} вхождения.', 'Расставлено {placed} из {n} вхождений.', 'Расставлено {placed} из {n} вхождений.'],
                { placed },
              )}
        </p>
      )}
      {stored > 0 && (
        <p className="mt-1 text-[11px] text-mist-500" data-testid="stored-count">
          {tp(
            stored,
            [
              'The other one is drawn from the graphics saved in the assembly until its file is added.',
              '{n} more are drawn from the graphics saved in the assembly until their files are added.',
            ],
            [
              'Ещё {n} нарисовано по графике, сохранённой в сборке, — пока не добавлен файл.',
              'Ещё {n} нарисованы по графике, сохранённой в сборке, — пока не добавлены файлы.',
              'Ещё {n} нарисованы по графике, сохранённой в сборке, — пока не добавлены файлы.',
            ],
          )}
        </p>
      )}

      {!disabled && missingNames.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            className="btn btn-primary w-full"
            onClick={() => void findInFolder()}
            disabled={scanning !== null}
            data-testid="component-find-folder"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path
                d="M1.5 4.5v7A1.5 1.5 0 0 0 3 13h4.5M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 6v1"
                strokeLinejoin="round"
              />
              <circle cx="11.2" cy="11.2" r="2.4" />
              <path d="m13 13 1.8 1.8" strokeLinecap="round" />
            </svg>
            {t('Find the parts in a folder…')}
          </button>
          <p className="mt-1.5 text-[11px] leading-relaxed text-mist-500">
            {t(
              'Point at a folder: it is searched with all its subfolders for the missing files. When a file is found more than once, you choose the version.',
            )}
          </p>
        </div>
      )}

      {scanning && (
        <div
          role="status"
          className="mt-2 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2"
          data-testid="component-scan-progress"
        >
          <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-ink-600 border-t-accent" />
          <span className="min-w-0 flex-1 text-[11px] text-mist-200">
            {t('Searching: {folders} folders and {files} files looked at, {found} of {wanted} found', {
              folders: formatCount(scanning.folders),
              files: formatCount(scanning.files),
              found: scanning.found,
              wanted: missingNames.length,
            })}
          </span>
          <button type="button" className="text-[11px] text-mist-300 underline" onClick={() => scanAbort.current?.abort()}>
            {t('Stop')}
          </button>
        </div>
      )}

      {scanOutcome && !scanning && (
        <div
          role="status"
          className={`mt-2 rounded-lg border px-3 py-2 text-[11px] leading-relaxed text-mist-200 ${
            scanOutcome.notFound.length === 0 ? 'border-ok/30 bg-ok/5' : 'border-warn/30 bg-warn/5'
          }`}
          data-testid="component-scan-outcome"
        >
          <p>
            {t('Found {found} of {wanted} missing files in {folders} folders.', {
              found: scanOutcome.found,
              wanted: scanOutcome.wanted,
              folders: formatCount(scanOutcome.folders),
            })}
          </p>
          {scanOutcome.notFound.length > 0 && (
            <p className="mt-1 break-words text-mist-400">{t('Not found: {list}', { list: scanOutcome.notFound.join(', ') })}</p>
          )}
          <button type="button" className="mt-1 text-mist-500 underline" onClick={() => setScanOutcome(null)}>
            {t('Dismiss')}
          </button>
        </div>
      )}

      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={t('Add assembly components')}
        aria-disabled={disabled}
        data-testid="component-dropzone"
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (disabled) return;
          const items = Array.from(event.dataTransfer?.items ?? []);
          const entries = items
            .map((item) => item.webkitGetAsEntry?.())
            .filter((entry): entry is FileSystemEntry => Boolean(entry));
          if (entries.some((entry) => entry.isDirectory)) {
            void filesIn(entries).then((files) => files.length > 0 && onAdd(files));
          } else {
            accept(event.dataTransfer?.files ?? null);
          }
        }}
        className={`mt-3 rounded-xl border-2 border-dashed px-3 py-4 text-center text-[12px] transition-colors ${
          disabled
            ? 'cursor-not-allowed border-line bg-ink-900/50 text-mist-500'
            : dragging
              ? 'cursor-pointer border-accent bg-accent/10 text-accent-bright'
              : 'cursor-pointer border-line-strong bg-ink-900/60 text-mist-400 hover:border-accent/60'
        }`}
      >
        {disabled
          ? t('This session has expired, so components can no longer be added.')
          : t('Drop the component files — or the whole folder — here. Each part appears in place as soon as it is ready.')}
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          data-testid="component-input"
          onChange={(event) => {
            accept(event.target.files);
            event.target.value = '';
          }}
        />
      </div>
      {/* Browsers that cannot walk a folder themselves hand over all of it here. */}
      <input
        ref={folderRef}
        type="file"
        multiple
        className="sr-only"
        data-testid="component-folder-input"
        {...{ webkitdirectory: '', directory: '' }}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length === 0) return;
          resolveScan(scanFileList(files, new Set(missingNames.map((name) => name.toLowerCase()))));
        }}
      />
      {/* One file, for the row whose "Locate…" was pressed. Whatever it is
          called on disk, it is sent under the name the assembly asked for. */}
      <input
        ref={locateRef}
        type="file"
        className="sr-only"
        data-testid="component-locate-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          const target = locating;
          setLocating(null);
          if (!file || !target) return;
          // Another name is allowed — files get renamed — but never taken
          // silently: a wrong part would stand in the right one's place.
          if (
            file.name.toLowerCase() !== target.toLowerCase() &&
            !window.confirm(
              t('The assembly asks for “{target}”.\nThe chosen file is “{chosen}”.\n\nPut it in that part’s place anyway?', {
                target,
                chosen: file.name,
              }),
            )
          ) {
            return;
          }
          const sameType = /\.[^.]+$/.exec(file.name)?.[0].toLowerCase() === /\.[^.]+$/.exec(target)?.[0].toLowerCase();
          const renamed = sameType && file.name.toLowerCase() !== target.toLowerCase();
          setSubstitutes((current) => {
            const next = { ...current };
            if (renamed) next[target] = file.name;
            else delete next[target];
            return next;
          });
          onAdd([renamed ? new File([file], target, { type: file.type }) : file]);
        }}
      />

      {rejected && (
        <div role="alert" className="mt-3 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2">
          <p className="text-[12px] text-mist-100">
            {rejected.name}: {t(rejected.message)}
          </p>
          <button type="button" onClick={onDismissRejected} className="mt-1 text-[11px] text-mist-400 underline">
            {t('Dismiss')}
          </button>
        </div>
      )}

      {missingNames.length > 0 && !disabled && (
        <div className="mt-3 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2" data-testid="component-missing">
          <p className="text-[12px] text-mist-200">
            {tp(
              missingNames.length,
              ['{n} file still missing.', '{n} files still missing.'],
              ['Не хватает {n} файла.', 'Не хватает {n} файлов.', 'Не хватает {n} файлов.'],
            )}
          </p>
          {storage && (
            <p className="mt-1 text-[11px] leading-relaxed text-mist-400" data-testid="component-storage">
              {storage.levelsUp <= 0
                ? tx('They were kept beside the assembly, in {folder}.', {
                    folder: <span className="text-mist-200">“{storage.name}”</span>,
                  })
                : tx(
                    'They were kept under {folder}, {levels} above the assembly’s own. Point at that folder with “Find the parts in a folder…”: each part is found by name, and the right copy by its place.',
                    {
                      folder: <span className="text-mist-200">“{storage.name}”</span>,
                      levels: tp(storage.levelsUp, ['{n} folder', '{n} folders'], ['на {n} папку', 'на {n} папки', 'на {n} папок']),
                    },
                  )}
            </p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <button
              type="button"
              className="text-accent underline underline-offset-2"
              onClick={() =>
                void copyText(missingNames.join('\n')).then((ok) => ok && say(t('The list of missing files is copied.')))
              }
            >
              {t('Copy the list')}
            </button>
            <span className="text-mist-500">
              {t('Explorer searches in')}{' '}
              {editingRoot ? (
                <input
                  autoFocus
                  defaultValue={searchRoot}
                  aria-label={t('Folder Explorer searches in')}
                  className="w-28 rounded border border-line bg-ink-900 px-1 font-mono text-[11px] text-mist-100"
                  onBlur={(event) => {
                    const value = event.target.value.trim() || 'C:\\';
                    setSearchRoot(value);
                    setEditingRoot(false);
                    try {
                      window.localStorage.setItem(SEARCH_ROOT_KEY, value);
                    } catch {
                      /* private window: kept for this page only */
                    }
                  }}
                  onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
                />
              ) : (
                <button
                  type="button"
                  className="font-mono text-mist-300 underline decoration-dotted underline-offset-2"
                  title={t('Change the folder Explorer searches in')}
                  onClick={() => setEditingRoot(true)}
                >
                  {searchRoot}
                </button>
              )}
            </span>
          </div>
        </div>
      )}

      {notice && (
        <p
          role="status"
          className="mt-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-[11px] leading-relaxed text-mist-200"
        >
          {notice}
        </p>
      )}

      <ul className="mt-3 space-y-1" data-testid="component-list">
        {components.map((component) => {
          const count = occurrences.get(component.name.toLowerCase()) ?? 0;
          const needed = component.status === 'missing' || component.status === 'failed';
          const unavailable = component.result?.meta.unavailableConfigurations;
          const notKept = Array.isArray(unavailable) ? unavailable.filter((v): v is string => typeof v === 'string') : [];
          return (
            <li key={component.name} className="rounded-lg border border-line bg-ink-900/50 px-2.5 py-1.5" data-testid="component-row">
              <div className="flex items-center gap-2">
                <StatusDot status={component.status} />
                <span className="min-w-0 flex-1 truncate text-[12px] text-mist-200" title={component.name}>
                  {component.name}
                </span>
                {count > 1 && (
                  <span className="shrink-0 font-mono text-[11px] text-mist-500" title={t('Placed {n} times', { n: count })}>
                    ×{count}
                  </span>
                )}
                <span className="shrink-0 text-[11px] text-mist-500">
                  {component.status === 'pending' && component.uploaded < 100
                    ? `${component.uploaded}%`
                    : t(STATUS_LABEL[component.status])}
                </span>
              </div>
              {needed && !disabled && (
                <div className="mt-1 flex flex-wrap items-center gap-1 pl-3.5">
                  <RowAction
                    label={t('Locate…')}
                    title={t('Copy the name and choose the file on disk — paste the name into the dialog’s search box')}
                    onClick={() => void locate(component.name)}
                    testId="component-locate"
                  >
                    <path
                      d="M2.5 5.5v6A1.5 1.5 0 0 0 4 13h8a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 12 5H8L6.5 3.5H4A1.5 1.5 0 0 0 2.5 5v.5"
                      strokeLinejoin="round"
                    />
                  </RowAction>
                  <RowAction
                    label={t('Search')}
                    title={t('Search for it with Windows Explorer, in {root}', { root: searchRoot })}
                    href={explorerSearch(component.name, searchRoot)}
                    onClick={() => void copyText(component.name)}
                    testId="component-explorer"
                  >
                    <circle cx="7" cy="7" r="3.8" />
                    <path d="m10 10 3.2 3.2" strokeLinecap="round" />
                  </RowAction>
                  <RowAction
                    label={t('Copy name')}
                    title={t('Copy the file name')}
                    onClick={() => void copyName(component.name)}
                    testId="component-copy"
                  >
                    <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.3" />
                    <path d="M3 10.5V4a1 1 0 0 1 1-1h6.5" strokeLinecap="round" />
                  </RowAction>
                </div>
              )}
              {needed && storage && component.originalPath && (
                <p className="mt-1 truncate pl-3.5 font-mono text-[10px] text-mist-500" title={component.originalPath} data-testid="component-where">
                  {t('in {folder}', { folder: keptIn(component.originalPath, storage) })}
                </p>
              )}
              {component.status === 'failed' && component.error && (
                <p className="mt-1 pl-3.5 text-[11px] leading-snug text-danger">{t(component.error.message)}</p>
              )}
              {substitutes[component.name] && (
                <p className="mt-1 pl-3.5 text-[11px] leading-snug text-warn" data-testid="component-substitute">
                  {t('Shown from “{file}”, chosen in its place.', { file: substitutes[component.name] })}
                </p>
              )}
              {notKept.length > 0 && (
                <p className="mt-1 pl-3.5 text-[11px] leading-snug text-warn">
                  {t('Configuration {names} is not saved in this file; shown as saved.', { names: notKept.join(', ') })}
                </p>
              )}
            </li>
          );
        })}
        {components.length === 0 && (
          <li className="px-1 py-2 text-[12px] text-mist-500">
            {t('No component names could be read from this assembly. Drop the parts above and they will be added anyway.')}
          </li>
        )}
      </ul>

      {choosing && (
        <VersionChooser
          groups={choosing.groups}
          alsoReady={choosing.ready.length}
          onCancel={() => setChoosing(null)}
          onChoose={(groups) => {
            setChoosing(null);
            onAdd([...choosing.ready, ...groups.map((group) => group.copies[group.selected].file)]);
          }}
        />
      )}
    </section>
  );
}

/**
 * Several files of one name under the chosen folder: which version opens is
 * the user's call. Each copy shows when it was last saved, its size and where
 * it lies; the newest is marked, and so is the one in the folder the assembly
 * itself recorded, which is what is chosen to begin with.
 */
function VersionChooser({
  groups: initial,
  alsoReady,
  onChoose,
  onCancel,
}: {
  groups: VersionGroup[];
  alsoReady: number;
  onChoose(groups: VersionGroup[]): void;
  onCancel(): void;
}) {
  const { t, tp, lang } = useT();
  const [groups, setGroups] = useState(initial);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const when = (ms: number) =>
    new Date(ms).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-GB', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink-950/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="version-chooser-title"
      data-testid="version-chooser"
    >
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl border border-line bg-ink-850 shadow-2xl">
        <div className="border-b border-line px-5 py-4">
          <h2 id="version-chooser-title" className="text-[15px] font-semibold text-mist-100">
            {t('Several versions found')}
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-mist-400">
            {t('These files occur more than once in the folder. Choose which version each part opens from.')}
            {alsoReady > 0 &&
              ` ${tp(
                alsoReady,
                ['One more file was found once and opens as it is.', '{n} more files were found once and open as they are.'],
                [
                  'Ещё {n} файл найден в одном экземпляре и откроется как есть.',
                  'Ещё {n} файла найдены в одном экземпляре и откроются как есть.',
                  'Ещё {n} файлов найдены в одном экземпляре и откроются как есть.',
                ],
              )}`}
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {groups.map((group, groupIndex) => (
            <fieldset key={group.name} data-testid="version-group">
              <legend className="mb-1.5 flex items-baseline gap-2">
                <span className="text-[13px] font-medium text-mist-100">{group.name}</span>
                <span className="text-[11px] text-mist-500">
                  {tp(group.copies.length, ['{n} copy', '{n} copies'], ['{n} экземпляр', '{n} экземпляра', '{n} экземпляров'])}
                </span>
              </legend>
              <div className="space-y-1">
                {group.copies.map((copy, copyIndex) => {
                  const chosen = group.selected === copyIndex;
                  return (
                    <label
                      key={copy.path}
                      className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${
                        chosen ? 'border-accent/60 bg-accent/10' : 'border-line bg-ink-900/40 hover:border-line-strong'
                      }`}
                    >
                      <input
                        type="radio"
                        name={`version-${groupIndex}`}
                        checked={chosen}
                        onChange={() =>
                          setGroups((current) =>
                            current.map((entry, k) => (k === groupIndex ? { ...entry, selected: copyIndex } : entry)),
                          )
                        }
                        className="accent-accent"
                        data-testid="version-option"
                      />
                      <span className="w-32 shrink-0 font-mono text-[12px] tabular-nums text-mist-100">{when(copy.modified)}</span>
                      <span className="w-16 shrink-0 text-right font-mono text-[11px] text-mist-400">{formatBytes(copy.size)}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-mist-300" title={copy.path}>
                        {copy.path}
                      </span>
                      <span className="flex shrink-0 gap-1">
                        {copyIndex === 0 && (
                          <span className="rounded border border-ok/40 bg-ok/10 px-1.5 py-px text-[10px] text-ok">{t('newest')}</span>
                        )}
                        {group.byPlace === copyIndex && (
                          <span
                            className="rounded border border-accent/40 bg-accent/10 px-1.5 py-px text-[10px] text-accent-bright"
                            title={t('In the folder the assembly recorded for this part')}
                          >
                            {t('assembly’s folder')}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setGroups((current) => current.map((group) => ({ ...group, selected: 0 })))}
            data-testid="version-newest"
          >
            {t('Newest everywhere')}
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              {t('Cancel')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => onChoose(groups)} data-testid="version-open">
              {t('Open the chosen versions')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RowAction({
  label,
  title,
  onClick,
  href,
  testId,
  children,
}: {
  label: string;
  title: string;
  onClick(): void;
  href?: string;
  testId: string;
  children: React.ReactNode;
}) {
  const className =
    'inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-line px-1.5 py-0.5 text-[11px] text-mist-300 transition-colors hover:border-accent/60 hover:text-mist-100';
  const icon = (
    <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      {children}
    </svg>
  );
  return href ? (
    <a href={href} title={title} onClick={onClick} className={className} data-testid={testId}>
      {icon}
      {label}
    </a>
  ) : (
    <button type="button" title={title} onClick={onClick} className={className} data-testid={testId}>
      {icon}
      {label}
    </button>
  );
}

const STATUS_LABEL: Record<ComponentView['status'], string> = {
  missing: 'Missing',
  pending: 'Opening',
  ready: 'Ready',
  failed: 'Failed',
};

function StatusDot({ status }: { status: ComponentView['status'] }) {
  const className =
    status === 'ready'
      ? 'bg-ok'
      : status === 'failed'
        ? 'bg-danger'
        : status === 'pending'
          ? 'bg-accent animate-pulse'
          : 'bg-ink-600';
  return <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${className}`} />;
}
