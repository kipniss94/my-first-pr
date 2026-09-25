'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssemblyState, NativeCadDocument } from '@docuview/shared';
import { apiUrl, fetchApi } from '@/lib/api';
import { useAssembly, type ComponentView } from '@/lib/assembly';
import { filesIn } from '@/lib/open';
import { ErrorPanel } from '@/components/viewer/ErrorPanel';

const CadViewer = dynamic(() => import('./CadViewer').then((m) => m.CadViewer), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-mist-400">Loading viewer…</div>
  ),
});

interface NativeCadViewerProps {
  /** URL of the `native.json` the processor wrote. */
  source: string;
  fileName: string;
  /** Parent job, needed to send components back to the right assembly. */
  jobId: string | null;
  assembly: AssemblyState | null;
  onProgress(percent: number): void;
  onReady(): void;
  /** Receives the stored preview, which is this document's workspace card. */
  onThumbnail?(source: string): void;
}

const LAYOUT_NOTE =
  'Component positions are not in this file — they live in the assembly’s own closed geometry. Parts are laid out side by side so each one can be inspected.';

/**
 * A native CAD document opened without its vendor kernel.
 *
 * The document always opens: either as the preview the CAD system stored inside
 * it, or — for an assembly — as real 3D built from the component files as the
 * user supplies them. The panel on the right is explicit about which of the two
 * is on screen, because a picture and a solid are not the same thing.
 */
export function NativeCadViewer({
  source,
  fileName,
  jobId,
  assembly,
  onProgress,
  onReady,
  onThumbnail,
}: NativeCadViewerProps) {
  const [document, setDocument] = useState<NativeCadDocument | null>(null);
  const [failed, setFailed] = useState(false);
  const { components, renderable, counts, add, rejected, dismissRejected } = useAssembly(jobId, assembly);

  useEffect(() => {
    let cancelled = false;
    onProgress(40);
    fetchApi(source)
      .then((response) => {
        if (!response.ok) throw new Error('native document unavailable');
        return response.json() as Promise<NativeCadDocument>;
      })
      .then((value) => {
        if (cancelled) return;
        setDocument(value);
        onProgress(100);
        onReady();
        if (value.preview) onThumbnail?.(apiUrl(value.preview.url));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [onProgress, onReady, onThumbnail, source]);

  if (failed) {
    return (
      <ErrorPanel
        error={{
          code: 'native_unavailable',
          message: "We couldn't read this document's details.",
          hint: 'The prepared data may have expired. Upload the file again.',
          retryable: true,
        }}
      />
    );
  }

  if (!document) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-3 text-sm text-mist-400">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-600 border-t-accent" />
        Reading the document…
      </div>
    );
  }

  const isAssembly = document.role === 'assembly' || components.length > 0;
  const placed = Boolean(document.placements?.length);
  // Every occurrence the assembly places, and how many stand in the scene now:
  // one per placement of a part whose file is open.
  const occurrences = new Map<string, number>();
  for (const placement of document.placements ?? []) {
    const key = placement.component.toLowerCase();
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  }
  const inScene = new Set(renderable.map((component) => component.name.toLowerCase()));
  const placedCount = (document.placements ?? []).filter((p) => inScene.has(p.component.toLowerCase())).length;
  const showGeometry = renderable.length > 0 || Boolean(document.geometry3d);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col bg-[#0e131b]">
        {showGeometry ? (
          <CadViewer
            source={document.geometry3d ?? null}
            meta={{}}
            mode="nmg"
            fileName={fileName}
            components={renderable}
            placements={placed || document.geometry3d ? (document.placements ?? []) : undefined}
            layoutNote={placed || document.geometry3d ? undefined : LAYOUT_NOTE}
            onProgress={() => undefined}
            onReady={() => undefined}
          />
        ) : (
          <PreviewStage document={document} fileName={fileName} />
        )}
      </div>

      <aside className="hidden w-80 shrink-0 flex-col overflow-y-auto border-l border-line bg-ink-850 lg:flex">
        <GeometryNotice document={document} showingGeometry={showGeometry} placed={placed} />
        {document.measured && <MeasuredSize measured={document.measured} />}
        {isAssembly && (
          <ComponentsPanel
            components={components}
            counts={counts}
            occurrences={occurrences}
            placed={placedCount}
            placementsTotal={document.placements?.length ?? 0}
            onAdd={add}
            rejected={rejected}
            onDismissRejected={dismissRejected}
            disabled={!jobId}
          />
        )}
        {document.properties.length > 0 && <PropertiesList document={document} />}
      </aside>
    </div>
  );
}

/* ------------------------------ preview stage ------------------------------ */

function PreviewStage({ document, fileName }: { document: NativeCadDocument; fileName: string }) {
  const [zoomed, setZoomed] = useState(false);

  if (!document.preview) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
        <svg viewBox="0 0 24 24" className="h-10 w-10 text-mist-600" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <path d="M4 5.5 12 2l8 3.5v13L12 22l-8-3.5z" strokeLinejoin="round" />
          <path d="m4 5.5 8 3.5 8-3.5M12 9v13" strokeLinejoin="round" />
        </svg>
        <p className="mt-4 max-w-md text-[15px] font-medium text-mist-200">
          This {document.application} document has no preview saved inside it.
        </p>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-mist-400">
          Its properties are listed on the right. To see the model itself, add a STEP export or ask your
          administrator to configure a CAD converter on the server.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
      {/* The preview is a bitmap the CAD system rendered; `img` is the honest
          way to show it, and keeping it unstyled avoids implying interactivity
          the picture does not have. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={apiUrl(document.preview.url)}
        alt={`Preview of ${fileName} as saved by ${document.application}`}
        width={document.preview.width}
        height={document.preview.height}
        data-testid="native-preview"
        onClick={() => setZoomed((current) => !current)}
        className={`rounded-lg border border-line bg-ink-900 shadow-lg ${
          zoomed ? 'max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in object-contain'
        }`}
      />
    </div>
  );
}

/* ------------------------------ side panels -------------------------------- */

function GeometryNotice({
  document,
  showingGeometry,
  placed,
}: {
  document: NativeCadDocument;
  showingGeometry: boolean;
  placed: boolean;
}) {
  return (
    <section className="border-b border-line p-4">
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${
            showingGeometry ? 'border-ok/40 bg-ok/10 text-ok' : 'border-accent/40 bg-accent/10 text-accent-bright'
          }`}
        >
          {showingGeometry ? 'Geometry' : 'Preview'}
        </span>
        <span className="text-[13px] font-medium text-mist-200">
          {document.application}
          {document.version && document.version !== document.application ? ` · ${document.version}` : ''}
        </span>
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-mist-400">
        {showingGeometry
          ? placed
            ? `Every part stands where the assembly puts it. ${document.note}`
            : document.geometry3d
              ? document.note
              : 'Built from the component files you added. These are real solids: rotate, section and measure them like any other model.'
          : document.note}
      </p>
    </section>
  );
}

/**
 * The one hard number this file has yielded so far.
 *
 * It is read from the model's own vertices, not from anything SolidWorks
 * wrote down about itself, so it is labelled as measured and says what it was
 * measured from. A part with curved faces and no corners has no vertices to
 * read and this panel simply does not appear.
 */
function MeasuredSize({ measured }: { measured: NonNullable<NativeCadDocument['measured']> }) {
  const axes: [string, number][] = [
    ['X', measured.sizeMm.x],
    ['Y', measured.sizeMm.y],
    ['Z', measured.sizeMm.z],
  ];
  return (
    <section className="border-b border-line p-4" data-testid="native-measured">
      <h2 className="field-label">Measured size</h2>
      <div className="mt-3 flex items-baseline gap-3">
        {axes.map(([axis, mm]) => (
          <div key={axis}>
            <span className="text-[10px] uppercase tracking-wide text-mist-500">{axis}</span>
            <p className="text-[15px] tabular-nums text-mist-100">{mm.toFixed(1)}</p>
          </div>
        ))}
        <span className="text-[12px] text-mist-500">mm</span>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-mist-500">
        Extent of the {measured.vertices} vertices read from the solid inside this file. Curved faces can
        reach past their corners, so treat this as the vertex extent rather than a certified bounding box.
      </p>
    </section>
  );
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

function ComponentsPanel({
  components,
  counts,
  occurrences,
  placed,
  placementsTotal,
  onAdd,
  rejected,
  onDismissRejected,
  disabled,
}: {
  components: ComponentView[];
  counts: { missing: number; pending: number; ready: number; failed: number };
  /** How many times the assembly places each part, by lower-case file name. */
  occurrences: Map<string, number>;
  /** Occurrences of parts in their own files now standing in the scene. */
  placed: number;
  placementsTotal: number;
  onAdd(files: File[]): void;
  rejected: { name: string; message: string } | null;
  onDismissRejected(): void;
  disabled: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const locateRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  /** The component a "Locate…" dialog is open for. */
  const [locating, setLocating] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchRoot, setSearchRoot] = useState('C:\\');
  const [editingRoot, setEditingRoot] = useState(false);

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
          ? `“${name}” is copied. In the window that opens, paste it (Ctrl+V) into the search box at the top right, or into “File name”.`
          : `Look for “${name}” in the window that opens.`,
      );
      const input = locateRef.current;
      if (input) {
        const extension = /\.[^.]+$/.exec(name)?.[0];
        input.accept = extension ?? '';
        input.click();
      }
    },
    [say],
  );

  const copyName = useCallback(
    async (name: string) => {
      if (await copyText(name)) say(`Copied “${name}”.`);
    },
    [say],
  );

  const missingNames = components.filter((c) => c.status === 'missing' || c.status === 'failed').map((c) => c.name);
  const total = components.length;
  const resolved = counts.ready;

  return (
    <section className="border-b border-line p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="field-label">Components</h2>
        <span className="font-mono text-[11px] text-mist-500" data-testid="component-count">
          {resolved}/{total}
        </span>
      </div>
      {placementsTotal > 0 && (
        <p className="mt-1 text-[11px] text-mist-500" data-testid="placed-count">
          {placed === placementsTotal
            ? `All ${placementsTotal} occurrences stand where the assembly puts them.`
            : `${placed} of ${placementsTotal} occurrences placed.`}
        </p>
      )}

      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label="Add assembly components"
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
          const entries = items.map((item) => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => Boolean(entry));
          if (entries.some((entry) => entry.isDirectory)) {
            void filesIn(entries).then((files) => files.length > 0 && onAdd(files));
          } else {
            accept(event.dataTransfer?.files ?? null);
          }
        }}
        className={`mt-3 rounded-xl border-2 border-dashed px-3 py-4 text-center text-[12px] transition-colors ${
          disabled
            ? 'cursor-not-allowed border-line bg-ink-900/50 text-mist-600'
            : dragging
              ? 'cursor-pointer border-accent bg-accent/10 text-accent-bright'
              : 'cursor-pointer border-line-strong bg-ink-900/60 text-mist-400 hover:border-accent/60'
        }`}
      >
        {disabled
          ? 'This session has expired, so components can no longer be added.'
          : 'Drop the component files — or the whole folder — here. Each part appears in place as soon as it is ready.'}
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
      {!disabled && (
        <button
          type="button"
          className="mt-2 w-full rounded-lg border border-line px-3 py-1.5 text-[12px] text-mist-300 hover:border-accent/60"
          onClick={() => folderRef.current?.click()}
        >
          Choose the folder with the parts…
        </button>
      )}
      <input
        ref={folderRef}
        type="file"
        multiple
        className="sr-only"
        data-testid="component-folder-input"
        {...{ webkitdirectory: '', directory: '' }}
        onChange={(event) => {
          accept(event.target.files);
          event.target.value = '';
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
          const sameType = /\.[^.]+$/.exec(file.name)?.[0].toLowerCase() === /\.[^.]+$/.exec(target)?.[0].toLowerCase();
          onAdd([sameType && file.name !== target ? new File([file], target, { type: file.type }) : file]);
        }}
      />

      {rejected && (
        <div role="alert" className="mt-3 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2">
          <p className="text-[12px] text-mist-100">
            {rejected.name}: {rejected.message}
          </p>
          <button type="button" onClick={onDismissRejected} className="mt-1 text-[11px] text-mist-400 underline">
            Dismiss
          </button>
        </div>
      )}

      {missingNames.length > 0 && !disabled && (
        <div className="mt-3 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2" data-testid="component-missing">
          <p className="text-[12px] text-mist-200">
            {missingNames.length} file{missingNames.length === 1 ? '' : 's'} still missing.
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <button
              type="button"
              className="text-accent underline underline-offset-2"
              onClick={() =>
                void copyText(missingNames.join('\n')).then((ok) => ok && say('The list of missing files is copied.'))
              }
            >
              Copy the list
            </button>
            <span className="text-mist-500">
              Explorer searches in{' '}
              {editingRoot ? (
                <input
                  autoFocus
                  defaultValue={searchRoot}
                  aria-label="Folder Explorer searches in"
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
                  title="Change the folder Explorer searches in"
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
        <p role="status" className="mt-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-[11px] leading-relaxed text-mist-200">
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
            <li
              key={component.name}
              className="rounded-lg border border-line bg-ink-900/50 px-2.5 py-1.5"
              data-testid="component-row"
            >
              <div className="flex items-center gap-2">
                <StatusDot status={component.status} />
                <span className="min-w-0 flex-1 truncate text-[12px] text-mist-200" title={component.name}>
                  {component.name}
                </span>
                {count > 1 && (
                  <span className="shrink-0 font-mono text-[11px] text-mist-500" title={`Placed ${count} times`}>
                    ×{count}
                  </span>
                )}
                <span className="shrink-0 text-[11px] text-mist-500">
                  {component.status === 'pending' && component.uploaded < 100
                    ? `${component.uploaded}%`
                    : STATUS_LABEL[component.status]}
                </span>
              </div>
              {needed && !disabled && (
                <div className="mt-1 flex items-center gap-1 pl-3.5">
                  <RowAction
                    label="Locate…"
                    title="Copy the name and choose the file on disk — paste the name into the dialog's search box"
                    onClick={() => void locate(component.name)}
                    testId="component-locate"
                  >
                    <path d="M2.5 5.5v6A1.5 1.5 0 0 0 4 13h8a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 12 5H8L6.5 3.5H4A1.5 1.5 0 0 0 2.5 5v.5" strokeLinejoin="round" />
                  </RowAction>
                  <RowAction
                    label="Search"
                    title={`Search for it with Windows Explorer, in ${searchRoot}`}
                    href={explorerSearch(component.name, searchRoot)}
                    onClick={() => void copyText(component.name)}
                    testId="component-explorer"
                  >
                    <circle cx="7" cy="7" r="3.8" />
                    <path d="m10 10 3.2 3.2" strokeLinecap="round" />
                  </RowAction>
                  <RowAction
                    label="Copy name"
                    title="Copy the file name"
                    onClick={() => void copyName(component.name)}
                    testId="component-copy"
                  >
                    <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.3" />
                    <path d="M3 10.5V4a1 1 0 0 1 1-1h6.5" strokeLinecap="round" />
                  </RowAction>
                </div>
              )}
              {component.status === 'failed' && component.error && (
                <p className="mt-1 pl-3.5 text-[11px] leading-snug text-danger">{component.error.message}</p>
              )}
              {notKept.length > 0 && (
                <p className="mt-1 pl-3.5 text-[11px] leading-snug text-warn">
                  Configuration {notKept.join(', ')} is not saved in this file; shown as saved.
                </p>
              )}
            </li>
          );
        })}
        {components.length === 0 && (
          <li className="px-1 py-2 text-[12px] text-mist-500">
            No component names could be read from this assembly. Drop the parts above and they will be added anyway.
          </li>
        )}
      </ul>
    </section>
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
    'inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[11px] text-mist-300 transition-colors hover:border-accent/60 hover:text-mist-100';
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

function PropertiesList({ document }: { document: NativeCadDocument }) {
  return (
    <section className="p-4">
      <h2 className="field-label">Document properties</h2>
      <dl className="mt-3 space-y-2" data-testid="native-properties">
        {document.properties.map((property) => (
          <div key={property.name} className="grid grid-cols-[7.5rem_1fr] gap-2">
            <dt className="truncate text-[12px] text-mist-500" title={property.name}>
              {property.name}
            </dt>
            <dd className="break-words text-[12px] text-mist-200">{property.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
