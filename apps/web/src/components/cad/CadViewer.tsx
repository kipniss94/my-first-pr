'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { computeSurfaceArea, computeVolume } from '@/lib/cad/geometry';
import { loadMeshFile, loadNmg, mergeModels, type MergeSource } from '@/lib/cad/loaders';
import { CadScene, disposeObject, type SelectionInfo } from '@/lib/cad/scene';
import type { RenderableComponent } from '@/lib/assembly';
import { THUMBNAIL_EDGE } from '@/lib/thumbnail';
import type {
  CadModel,
  DisplayMode,
  MeasurementRecord,
  PartProperties,
  SectionState,
  StandardView,
  ToolMode,
} from '@/lib/cad/types';
import { ErrorPanel } from '@/components/viewer/ErrorPanel';
import { ViewerAdRail } from '@/components/site/AdSlot';
import { AnalysisPanel } from './AnalysisPanel';
import { ModelTree } from './ModelTree';
import { PropertiesPanel } from './PropertiesPanel';
import { ViewerToolbar } from './ViewerToolbar';

interface CadViewerProps {
  /** Primary geometry. Null for an assembly that only has components so far. */
  source: string | null;
  meta: Record<string, unknown>;
  mode: 'nmg' | 'mesh';
  /** Shown as the root of the model tree for formats with no internal name. */
  fileName: string;
  /**
   * Assembly components to merge into the same scene. The list grows as parts
   * are supplied, and each new entry is loaded and added without refetching the
   * ones already on screen.
   */
  components?: RenderableComponent[];
  /** Sentence shown under the tree when component placement is approximate. */
  layoutNote?: string;
  onProgress(percent: number): void;
  onReady(): void;
  /** Receives a PNG data URL of the framed model, for the workspace card. */
  onThumbnail?(dataUrl: string): void;
}

/** Above this, computing volume and area is opt-in rather than automatic. */
const AUTO_MASS_PROPERTIES_LIMIT = 200_000;

const DEFAULT_SECTION: SectionState = {
  enabled: false,
  axis: 'z',
  position: 0.5,
  flipped: false,
  showCap: true,
  hatch: true,
};

export function CadViewer({
  source,
  meta,
  mode,
  fileName,
  components,
  layoutNote,
  onProgress,
  onReady,
  onThumbnail,
}: CadViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<CadScene | null>(null);

  const [model, setModel] = useState<CadModel | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; hint?: string } | null>(null);
  const [percent, setPercent] = useState(0);

  const [selection, setSelection] = useState<SelectionInfo>({ partId: null, faceIndex: null, faceCount: null });
  const [measurements, setMeasurements] = useState<MeasurementRecord[]>([]);
  const [pendingPoints, setPendingPoints] = useState(0);
  const [fps, setFps] = useState<number | null>(null);
  const [hiddenVersion, setHiddenVersion] = useState(0);

  const [tool, setTool] = useState<ToolMode>('select');
  const [displayMode, setDisplayMode] = useState<DisplayMode>('shaded');
  const [opacity, setOpacity] = useState(1);
  const [gridVisible, setGridVisible] = useState(false);
  const [section, setSection] = useState<SectionState>(DEFAULT_SECTION);
  const [sectionCoordinate, setSectionCoordinate] = useState(0);
  const [boundingBoxVisible, setBoundingBoxVisible] = useState(false);
  const [boundingBoxScope, setBoundingBoxScope] = useState<'model' | 'selection'>('model');
  const [forceMassProperties, setForceMassProperties] = useState(false);

  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [rightTab, setRightTab] = useState<'properties' | 'analysis'>('properties');

  /* ------------------------------ scene setup ----------------------------- */

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let scene: CadScene;
    try {
      scene = new CadScene(container, {
        onSelectionChange: setSelection,
        onMeasurementsChange: setMeasurements,
        onPendingPointsChange: setPendingPoints,
        onFps: setFps,
      });
    } catch {
      setLoadError({
        message: "Your browser couldn't start the 3D viewer.",
        hint: 'WebGL 2 is required. Try a recent Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is on.',
      });
      return;
    }
    sceneRef.current = scene;

    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  /* -------------------------------- loading ------------------------------- */

  /*
   * Loaded pieces are kept here so an assembly can grow without refetching what
   * is already on screen. The scene is told not to dispose them on each swap;
   * this component owns them and clears them when the document closes.
   */
  const loadedRef = useRef(new Map<string, CadModel>());
  const componentKey = (components ?? []).map((component) => component.id).join('|');

  useEffect(() => {
    const cache = loadedRef.current;
    return () => {
      for (const model of cache.values()) disposeObject(model.root);
      cache.clear();
    };
  }, []);

  // A different document invalidates everything held for the previous one.
  useEffect(() => {
    const cache = loadedRef.current;
    for (const model of cache.values()) disposeObject(model.root);
    cache.clear();
  }, [fileName, mode, source]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    const report = (value: number) => {
      if (cancelled) return;
      setPercent(value);
      onProgress(value);
    };

    const formatId = typeof meta.formatId === 'string' ? meta.formatId : 'stl';
    const wanted: { key: string; name: string; load: () => Promise<CadModel> }[] = [];

    if (source) {
      wanted.push({
        key: `primary:${source}`,
        name: fileName,
        load: () =>
          mode === 'nmg'
            ? loadNmg(source, report, controller.signal)
            : loadMeshFile(source, formatId, fileName, report, controller.signal),
      });
    }
    for (const component of components ?? []) {
      wanted.push({
        key: `component:${component.id}`,
        name: component.name,
        load: () =>
          component.mode === 'nmg'
            ? loadNmg(component.source, undefined, controller.signal)
            : loadMeshFile(component.source, component.formatId, component.name, undefined, controller.signal),
      });
    }

    if (wanted.length === 0) {
      setModel(null);
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    const run = async (): Promise<void> => {
      const cache = loadedRef.current;
      const sources: MergeSource[] = [];
      let loadedAny = false;

      for (const entry of wanted) {
        let model = cache.get(entry.key);
        if (!model) {
          model = await entry.load();
          if (cancelled) return;
          cache.set(entry.key, model);
          loadedAny = true;
        }
        sources.push({ name: entry.name, model });
      }

      // Drop anything that is no longer part of the document.
      const keep = new Set(wanted.map((entry) => entry.key));
      for (const [key, model] of cache) {
        if (!keep.has(key)) {
          disposeObject(model.root);
          cache.delete(key);
        }
      }

      const merged = sources.length === 1 && !components?.length ? sources[0].model : mergeModels(sources, fileName);
      if (cancelled) return;

      if (merged.parts.length === 0) {
        setLoadError({
          message: 'This model opened but contains no visible geometry.',
          hint: 'The file may only hold curves, annotations or metadata.',
        });
        return;
      }

      setLoadError(null);
      setModel(merged);
      // The component models stay alive across this swap: we own them.
      sceneRef.current?.setModel(merged, false);
      setSectionCoordinate(sceneRef.current?.section.coordinate ?? 0);
      if (loadedAny) report(100);
      onReady();

      // One frame for the fit to settle, another so the framebuffer holds the
      // finished image rather than a half-drawn one.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (cancelled || !onThumbnail) return;
          const shot = sceneRef.current?.snapshot(THUMBNAIL_EDGE);
          if (shot) onThumbnail(shot);
        });
      });
    };

    run().catch((err: unknown) => {
      if (cancelled || controller.signal.aborted) return;
      setLoadError({
        message: "We couldn't open this model in the viewer.",
        hint:
          err instanceof Error && /WebGL|context/i.test(err.message)
            ? 'The browser lost the 3D context. Reloading the page usually fixes it.'
            : 'The prepared geometry may have expired. Try uploading the file again.',
      });
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [componentKey, components, fileName, meta, mode, onProgress, onReady, onThumbnail, source]);

  /* ----------------------------- state → scene ---------------------------- */

  useEffect(() => {
    sceneRef.current?.setTool(tool);
  }, [tool]);

  useEffect(() => {
    sceneRef.current?.setDisplayMode(displayMode);
  }, [displayMode, model]);

  useEffect(() => {
    sceneRef.current?.setOpacity(opacity);
  }, [opacity]);

  useEffect(() => {
    sceneRef.current?.setGridVisible(gridVisible);
  }, [gridVisible]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !model) return;
    scene.section.setAxis(section.axis);
    scene.section.setPosition(section.position);
    scene.section.setFlipped(section.flipped);
    scene.section.setShowCap(section.showCap);
    scene.section.setHatch(section.hatch);
    scene.section.setEnabled(section.enabled);
    setSectionCoordinate(scene.section.coordinate);
    scene.requestRender();
  }, [model, section]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !model) return;
    scene.setBoundingBoxVisible(
      boundingBoxVisible,
      boundingBoxScope === 'selection' ? selection.partId : null,
    );
  }, [boundingBoxScope, boundingBoxVisible, model, selection.partId]);

  useEffect(() => {
    setForceMassProperties(false);
  }, [selection.partId]);

  /* ------------------------------ properties ------------------------------ */

  const properties = useMemo<PartProperties | null>(() => {
    if (!model || !selection.partId) return null;
    const part = model.parts.find((candidate) => candidate.id === selection.partId);
    if (!part) return null;

    const box = new THREE.Box3().setFromObject(part.mesh);
    const size = box.getSize(new THREE.Vector3());
    const material = Array.isArray(part.mesh.material) ? part.mesh.material[0] : part.mesh.material;
    const color =
      material && 'color' in material ? `#${(material as THREE.MeshStandardMaterial).color.getHexString()}` : '#b4bcc8';

    const heavy = part.triangles > AUTO_MASS_PROPERTIES_LIMIT && !forceMassProperties;
    const mass = heavy
      ? { volume: null as number | null, approximate: false, area: 0 }
      : (() => {
          const volume = computeVolume(part.mesh.geometry);
          return { volume: volume.volume, approximate: volume.approximate, area: computeSurfaceArea(part.mesh.geometry) };
        })();

    return {
      name: part.name,
      type: part.faceRanges ? 'Solid (B-Rep)' : 'Mesh',
      size: { x: size.x, y: size.y, z: size.z },
      min: { x: box.min.x, y: box.min.y, z: box.min.z },
      max: { x: box.max.x, y: box.max.y, z: box.max.z },
      volume: mass.volume,
      volumeApproximate: mass.approximate,
      surfaceArea: mass.area,
      triangles: part.triangles,
      vertices: part.vertices,
      brepFaces: part.faceRanges ? part.faceRanges.length / 2 : null,
      // Neither STEP nor mesh formats carry a material we can trust, so this is
      // honest rather than invented.
      material: null,
      color,
    };
  }, [forceMassProperties, model, selection.partId]);

  const needsCompute = Boolean(
    properties && properties.volume === null && properties.triangles > AUTO_MASS_PROPERTIES_LIMIT,
  );

  const boundsInfo = useMemo(() => {
    const scene = sceneRef.current;
    const source =
      boundingBoxScope === 'selection' && selection.partId && model
        ? (() => {
            const part = model.parts.find((candidate) => candidate.id === selection.partId);
            return part ? new THREE.Box3().setFromObject(part.mesh) : scene?.modelBounds;
          })()
        : scene?.modelBounds;
    const box = source ?? new THREE.Box3();
    const size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3());
    return { size: { x: size.x, y: size.y, z: size.z }, diagonal: size.length() };
  }, [boundingBoxScope, model, selection.partId]);

  /* ------------------------------- handlers ------------------------------- */

  const onSelectPart = useCallback((partId: string | null) => {
    sceneRef.current?.select(partId);
  }, []);

  const onToggleVisibility = useCallback((partIds: string[], visible: boolean) => {
    const scene = sceneRef.current;
    if (!scene) return;
    for (const partId of partIds) scene.setPartVisible(partId, visible);
    setHiddenVersion((version) => version + 1);
  }, []);

  const onIsolate = useCallback((partIds: string[]) => {
    sceneRef.current?.isolate(partIds.length > 0 ? partIds : null);
    setHiddenVersion((version) => version + 1);
  }, []);

  const onSnapshot = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const link = document.createElement('a');
    link.href = scene.snapshot();
    link.download = 'docuview-snapshot.png';
    link.click();
  }, []);

  const hiddenParts = useMemo(() => {
    void hiddenVersion; // recompute whenever visibility changed
    return sceneRef.current?.hidden ?? new Set<string>();
  }, [hiddenVersion, model]);

  /* Keyboard shortcuts mirror what CAD users already have in their fingers. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const scene = sceneRef.current;
      if (!scene) return;
      const views: Record<string, StandardView> = { '1': 'front', '2': 'back', '3': 'left', '4': 'right', '5': 'top', '6': 'bottom', '7': 'iso' };
      if (views[event.key]) {
        scene.setStandardView(views[event.key]);
        return;
      }
      switch (event.key.toLowerCase()) {
        case 'f':
          scene.fit();
          break;
        case 'escape':
          setTool('select');
          scene.clearSelection();
          break;
        case 'w':
          setDisplayMode((current) => (current === 'wireframe' ? 'shaded' : 'wireframe'));
          break;
        case 'e':
          setDisplayMode((current) => (current === 'shaded-edges' ? 'shaded' : 'shaded-edges'));
          break;
        case 'm':
          setTool('measure-distance');
          break;
        case 'x':
          setSection((current) => ({ ...current, enabled: !current.enabled }));
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (loadError) {
    return <ErrorPanel error={{ code: 'viewer_failed', ...loadError, retryable: false }} />;
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          {/* Left: model tree */}
          <aside
            className={`relative shrink-0 border-r border-line bg-ink-850 transition-[width] duration-200 ${
              leftOpen ? 'w-64' : 'w-0'
            }`}
          >
            {leftOpen && model && (
              <div className="flex h-full min-h-0 flex-col">
                <div className="min-h-0 flex-1">
                  <ModelTree
                    model={model}
                    selectedPartId={selection.partId}
                    hiddenParts={hiddenParts}
                    onSelect={onSelectPart}
                    onToggleVisibility={onToggleVisibility}
                    onIsolate={onIsolate}
                  />
                </div>
                {layoutNote && (
                  <p className="shrink-0 border-t border-line px-3 py-2.5 text-[11px] leading-relaxed text-mist-500">
                    {layoutNote}
                  </p>
                )}
              </div>
            )}
            <PanelHandle side="left" open={leftOpen} onClick={() => setLeftOpen((open) => !open)} />
          </aside>

          {/* Centre: the 3D view */}
          <div className="relative min-w-0 flex-1 bg-[#0e131b]">
            <div ref={containerRef} className="absolute inset-0" data-testid="cad-canvas" />
            {!model && !loadError && <LoadingOverlay percent={percent} />}
            {model && tool !== 'select' && (
              <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-lg border border-measure/40 bg-ink-900/90 px-3 py-1.5 text-[12px] text-measure backdrop-blur">
                {tool === 'measure-distance' && `Click two points · ${pendingPoints}/2`}
                {tool === 'measure-angle' && `Click three points · ${pendingPoints}/3`}
                {tool === 'measure-length' && 'Click a model edge'}
              </div>
            )}
            {model && section.enabled && (
              <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg border border-line bg-ink-900/90 px-2.5 py-1.5 font-mono text-[11px] text-mist-300 backdrop-blur">
                Section {section.axis.toUpperCase()} @ {sectionCoordinate.toFixed(2)} {model.units}
              </div>
            )}
          </div>

          {/* Right: properties / analysis */}
          <aside
            className={`relative flex shrink-0 flex-col border-l border-line bg-ink-850 transition-[width] duration-200 ${
              rightOpen ? 'w-72' : 'w-0'
            }`}
          >
            {rightOpen && model && (
              <>
                <div className="flex shrink-0 border-b border-line">
                  <TabButton active={rightTab === 'properties'} onClick={() => setRightTab('properties')}>
                    Properties
                  </TabButton>
                  <TabButton active={rightTab === 'analysis'} onClick={() => setRightTab('analysis')}>
                    Analysis
                  </TabButton>
                </div>
                {rightTab === 'properties' ? (
                  <PropertiesPanel
                    model={model}
                    properties={properties}
                    faceIndex={selection.faceIndex}
                    faceCount={selection.faceCount}
                    needsCompute={needsCompute}
                    onCompute={() => setForceMassProperties(true)}
                  />
                ) : (
                  <AnalysisPanel
                    model={model}
                    tool={tool}
                    pendingPoints={pendingPoints}
                    measurements={measurements}
                    section={section}
                    sectionCoordinate={sectionCoordinate}
                    boundingBoxVisible={boundingBoxVisible}
                    boundingBoxScope={boundingBoxScope}
                    bounds={boundsInfo}
                    hasSelection={Boolean(selection.partId)}
                    onToolChange={setTool}
                    onSectionChange={(patch) => setSection((current) => ({ ...current, ...patch }))}
                    onBoundingBoxToggle={setBoundingBoxVisible}
                    onBoundingBoxScope={setBoundingBoxScope}
                    onRemoveMeasurement={(id) => sceneRef.current?.removeMeasurement(id)}
                    onClearMeasurements={() => sceneRef.current?.clearMeasurements()}
                  />
                )}
              </>
            )}
            <PanelHandle side="right" open={rightOpen} onClick={() => setRightOpen((open) => !open)} />
          </aside>
        </div>

        <ViewerToolbar
          tool={tool}
          displayMode={displayMode}
          opacity={opacity}
          gridVisible={gridVisible}
          sectionEnabled={section.enabled}
          edgesUnavailable={sceneRef.current?.edgesUnavailable ?? false}
          fps={fps}
          onToolChange={(next) => {
            setTool(next);
            if (next !== 'select') setRightTab('analysis');
          }}
          onDisplayModeChange={setDisplayMode}
          onOpacityChange={setOpacity}
          onGridToggle={setGridVisible}
          onSectionToggle={(enabled) => {
            setSection((current) => ({ ...current, enabled }));
            if (enabled) setRightTab('analysis');
          }}
          onStandardView={(view) => sceneRef.current?.setStandardView(view)}
          onFit={() => sceneRef.current?.fit()}
          onReset={() => sceneRef.current?.resetCamera()}
          onSnapshot={onSnapshot}
        />
      </div>

      <ViewerAdRail />
    </div>
  );
}

function LoadingOverlay({ percent }: { percent: number }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-ink-900/70 backdrop-blur-sm">
      <div className="w-56 text-center">
        <p className="text-[13px] text-mist-300">Loading geometry</p>
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-ink-700">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-200"
            style={{ width: `${Math.max(4, percent)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors ${
        active ? 'border-accent text-mist-100' : 'border-transparent text-mist-400 hover:text-mist-200'
      }`}
    >
      {children}
    </button>
  );
}

/** The little tab that collapses a side panel. */
function PanelHandle({ side, open, onClick }: { side: 'left' | 'right'; open: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${open ? 'Collapse' : 'Expand'} ${side} panel`}
      className={`absolute top-1/2 z-10 grid h-12 w-4 -translate-y-1/2 place-items-center rounded-md border border-line bg-ink-800 text-mist-400 transition-colors hover:bg-ink-700 hover:text-mist-100 ${
        side === 'left' ? '-right-2' : '-left-2'
      }`}
    >
      <svg
        viewBox="0 0 12 12"
        className={`h-3 w-3 ${(side === 'left') === open ? 'rotate-180' : ''}`}
        aria-hidden="true"
      >
        <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
