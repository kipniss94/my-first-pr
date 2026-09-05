'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssemblyState, NativeCadDocument } from '@docuview/shared';
import { apiUrl } from '@/lib/api';
import { useAssembly, type ComponentView } from '@/lib/assembly';
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
    fetch(apiUrl(source))
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
  const showGeometry = renderable.length > 0;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col bg-[#0e131b]">
        {showGeometry ? (
          <CadViewer
            source={null}
            meta={{}}
            mode="nmg"
            fileName={fileName}
            components={renderable}
            layoutNote={LAYOUT_NOTE}
            onProgress={() => undefined}
            onReady={() => undefined}
          />
        ) : (
          <PreviewStage document={document} fileName={fileName} />
        )}
      </div>

      <aside className="hidden w-80 shrink-0 flex-col overflow-y-auto border-l border-line bg-ink-850 lg:flex">
        <GeometryNotice document={document} showingGeometry={showGeometry} />
        {document.measured && <MeasuredSize measured={document.measured} />}
        {isAssembly && (
          <ComponentsPanel
            components={components}
            counts={counts}
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

function GeometryNotice({ document, showingGeometry }: { document: NativeCadDocument; showingGeometry: boolean }) {
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
          ? 'Built from the component files you added. These are real solids: rotate, section and measure them like any other model.'
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

function ComponentsPanel({
  components,
  counts,
  onAdd,
  rejected,
  onDismissRejected,
  disabled,
}: {
  components: ComponentView[];
  counts: { missing: number; pending: number; ready: number; failed: number };
  onAdd(files: File[]): void;
  rejected: { name: string; message: string } | null;
  onDismissRejected(): void;
  disabled: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const accept = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return;
      onAdd(Array.from(list));
    },
    [onAdd],
  );

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
          if (!disabled) accept(event.dataTransfer?.files ?? null);
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
          : 'Drop the component files here — they appear in the model as each one is ready.'}
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

      <ul className="mt-3 space-y-1" data-testid="component-list">
        {components.map((component) => (
          <li
            key={component.name}
            className="flex items-center gap-2 rounded-lg border border-line bg-ink-900/50 px-2.5 py-1.5"
          >
            <StatusDot status={component.status} />
            <span className="min-w-0 flex-1 truncate text-[12px] text-mist-200" title={component.name}>
              {component.name}
            </span>
            <span className="shrink-0 text-[11px] text-mist-500">
              {component.status === 'pending' && component.uploaded < 100
                ? `${component.uploaded}%`
                : STATUS_LABEL[component.status]}
            </span>
          </li>
        ))}
        {components.length === 0 && (
          <li className="px-1 py-2 text-[12px] text-mist-500">
            No component names could be read from this assembly. Drop the parts above and they will be added anyway.
          </li>
        )}
      </ul>
    </section>
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
