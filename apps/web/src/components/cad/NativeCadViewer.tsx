'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { commonFolder, pathSegments, type AssemblyState, type NativeCadDocument } from '@docuview/shared';
import { apiUrl, fetchApi } from '@/lib/api';
import { useAssembly } from '@/lib/assembly';
import { decimal, formatCount, unitLabel } from '@/lib/format';
import { useT } from '@/lib/prefs';
import { ErrorPanel } from '@/components/viewer/ErrorPanel';
import { ComponentsPanel, type Storage } from './ComponentsPanel';

const CadViewer = dynamic(() => import('./CadViewer').then((m) => m.CadViewer), {
  ssr: false,
  loading: () => <LoadingViewer />,
});

function LoadingViewer() {
  const { t } = useT();
  return <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-mist-400">{t('Loading viewer…')}</div>;
}

interface NativeCadViewerProps {
  /** URL of the `native.json` the processor wrote. */
  source: string;
  fileName: string;
  /** Parent job, needed to send components back to the right assembly. */
  jobId: string | null;
  assembly: AssemblyState | null;
  /** Where SolidWorks had this assembly when it was saved. */
  recordedPath?: string | null;
  /** Where it was inside what was dropped, when it came from a folder. */
  sourcePath?: string | null;
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
  recordedPath = null,
  sourcePath = null,
}: NativeCadViewerProps) {
  const [document, setDocument] = useState<NativeCadDocument | null>(null);
  const [failed, setFailed] = useState(false);
  const { t } = useT();
  const { components, renderable, counts, add, rejected, dismissRejected } = useAssembly(jobId, assembly, {
    recorded: recordedPath,
    here: sourcePath,
  });

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
        {t('Reading the document…')}
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
  // Where the parts were kept when the assembly was saved: the one folder to
  // choose so that every one of them is found.
  // Library parts kept on another drive or root (Toolbox fasteners, say) are
  // left out, or the one folder would shrink to a drive letter.
  const recorded = recordedPath
    ? components
        .map((c) => c.originalPath)
        .filter((p): p is string => Boolean(p) && commonFolder([recordedPath, p as string]).length >= 2)
    : [];
  const root = recordedPath && recorded.length > 0 ? commonFolder([recordedPath, ...recorded]) : [];
  const storage: Storage | null =
    root.length >= 2 && recordedPath
      ? {
          name: root[root.length - 1],
          levelsUp: pathSegments(recordedPath).length - 1 - root.length,
          depth: root.length,
          path: root,
        }
      : null;
  const showGeometry = renderable.length > 0 || Boolean(document.geometry3d) || Boolean(document.storedGeometry);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col bg-[var(--viewport-bg)]">
        {showGeometry ? (
          <CadViewer
            source={document.geometry3d ?? null}
            meta={{}}
            mode="nmg"
            fileName={fileName}
            components={renderable}
            placements={placed || document.geometry3d || document.storedGeometry ? (document.placements ?? []) : undefined}
            storedSource={document.storedGeometry ?? null}
            layoutNote={placed || document.geometry3d || document.storedGeometry ? undefined : LAYOUT_NOTE}
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
            storage={storage}
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
  const { t } = useT();

  if (!document.preview) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
        <svg viewBox="0 0 24 24" className="h-10 w-10 text-mist-600" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <path d="M4 5.5 12 2l8 3.5v13L12 22l-8-3.5z" strokeLinejoin="round" />
          <path d="m4 5.5 8 3.5 8-3.5M12 9v13" strokeLinejoin="round" />
        </svg>
        <p className="mt-4 max-w-md text-[15px] font-medium text-mist-200">
          {t('This {application} document has no preview saved inside it.', { application: document.application })}
        </p>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-mist-400">
          {t(
            'Its properties are listed on the right. To see the model itself, add a STEP export or ask your administrator to configure a CAD converter on the server.',
          )}
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
        alt={t('Preview of {name} as saved by {application}', { name: fileName, application: document.application })}
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
  const { t } = useT();
  return (
    <section className="border-b border-line p-4">
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${
            showingGeometry ? 'border-ok/40 bg-ok/10 text-ok' : 'border-accent/40 bg-accent/10 text-accent-bright'
          }`}
        >
          {showingGeometry ? t('Geometry') : t('Preview')}
        </span>
        <span className="text-[13px] font-medium text-mist-200">
          {document.application}
          {document.version && document.version !== document.application ? ` · ${document.version}` : ''}
        </span>
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-mist-400">
        {showingGeometry
          ? placed
            ? `${t('Every part stands where the assembly puts it.')} ${t(document.note)}`
            : document.geometry3d
              ? t(document.note)
              : t(
                  'Built from the component files you added. These are real solids: rotate, section and measure them like any other model.',
                )
          : t(document.note)}
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
  const { t } = useT();
  return (
    <section className="border-b border-line p-4" data-testid="native-measured">
      <h2 className="field-label">{t('Measured size')}</h2>
      <div className="mt-3 flex items-baseline gap-3">
        {axes.map(([axis, mm]) => (
          <div key={axis}>
            <span className="text-[10px] uppercase tracking-wide text-mist-500">{axis}</span>
            <p className="text-[15px] tabular-nums text-mist-100">{decimal(mm.toFixed(1))}</p>
          </div>
        ))}
        <span className="text-[12px] text-mist-500">{unitLabel('mm')}</span>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-mist-500">
        {t(
          'Extent of the {count} vertices read from the solid inside this file. Curved faces can reach past their corners, so treat this as the vertex extent rather than a certified bounding box.',
          { count: formatCount(measured.vertices) },
        )}
      </p>
    </section>
  );
}

function PropertiesList({ document }: { document: NativeCadDocument }) {
  const { t } = useT();
  return (
    <section className="p-4">
      <h2 className="field-label">{t('Document properties')}</h2>
      <dl className="mt-3 space-y-2" data-testid="native-properties">
        {document.properties.map((property) => (
          <div key={property.name} className="grid grid-cols-[7.5rem_1fr] gap-2">
            <dt className="truncate text-[12px] text-mist-500" title={property.name}>
              {t(property.name)}
            </dt>
            <dd className="break-words text-[12px] text-mist-200">{property.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
