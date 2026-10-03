import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { decimal, formatAngle, formatArea, formatLength } from '@/lib/format';
import { currentThemeName, onThemeChange, translate, type Theme } from '@/lib/prefs';
import { captureCanvas } from '@/lib/thumbnail';
import { faceIndexForTriangle, snapToVertex } from './geometry';
import {
  describe,
  edgeLocalPoints,
  entityAt,
  faceTriangleList,
  measureOptions,
  sameEntity,
  type Entity,
  type MeasureOption,
  type OptionKind,
} from './measure';
import { SectionController } from './section';
import type { CadModel, CadPart, DisplayMode, MeasurementRecord, StandardView, ToolMode } from './types';

/** What the smart measuring tool has picked and offers, for the panel above the view. */
export interface LiveMeasure {
  selection: ReturnType<typeof describe>[];
  options: { key: string; label: string; kind: OptionKind; value: number; text: string }[];
  index: number;
}

export interface SelectionInfo {
  partId: string | null;
  /** Index of the picked B-Rep face, when the format carries that structure. */
  faceIndex: number | null;
  faceCount: number | null;
}

export interface SceneCallbacks {
  onSelectionChange?(selection: SelectionInfo): void;
  onMeasurementsChange?(measurements: MeasurementRecord[]): void;
  onPendingPointsChange?(count: number): void;
  onLiveMeasureChange?(live: LiveMeasure | null): void;
  onFps?(fps: number): void;
}

const HOVER_COLOR = 0x3fb6ff;
const PICKED_COLOR = 0xff8a3d;

const SELECT_COLOR = new THREE.Color(0xff8a3d);
const EDGE_COLOR = new THREE.Color(0x2a3444);
const MEASURE_COLOR = 0xf5a524;
/** Background and ground grid, per interface theme. */
const PALETTES: Record<Theme, { background: number; gridMajor: number; gridMinor: number }> = {
  dark: { background: 0x0e131b, gridMajor: 0x33405a, gridMinor: 0x1d2534 },
  light: { background: 0xe6eaf0, gridMajor: 0x98a4b6, gridMinor: 0xc4ccd7 },
};
/** Building edge geometry for a huge mesh freezes the tab; skip it instead. */
const EDGE_TRIANGLE_LIMIT = 400_000;

export class CadScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly section: SectionController;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly labelRenderer: CSS2DRenderer;
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly resizeObserver: ResizeObserver;

  private model: CadModel | null = null;
  private bounds = new THREE.Box3();
  private homeTarget = new THREE.Vector3();
  private homeDistance = 10;

  private readonly edgeLines = new Map<string, THREE.LineSegments>();
  private readonly originalColors = new Map<string, THREE.Color>();
  private readonly hiddenParts = new Set<string>();

  private selectedPartId: string | null = null;
  private faceHighlight: THREE.Mesh | null = null;
  private boxHelper: THREE.Box3Helper | null = null;
  private grid: THREE.GridHelper;
  private readonly annotations = new THREE.Group();

  private tool: ToolMode = 'select';
  private pendingPoints: THREE.Vector3[] = [];
  private pendingMarkers: THREE.Object3D[] = [];
  private measurements: MeasurementRecord[] = [];

  /* The smart tool: what is under the cursor, what is picked, and the dimension it offers. */
  private hoverEntity: Entity | null = null;
  private hoverObject: THREE.Object3D | null = null;
  private picked: Entity[] = [];
  private pickedObjects: THREE.Object3D[] = [];
  private liveOptions: MeasureOption[] = [];
  private liveIndex = 0;
  private liveGroup: THREE.Group | null = null;
  private hoverFrame = 0;
  private hoverEvent: PointerEvent | null = null;
  /** Fat-line materials, which need the canvas size to draw their width. */
  private readonly lineMaterials = new Set<LineMaterial>();

  private displayMode: DisplayMode = 'shaded';
  private opacity = 1;
  private colorOverride: string | null = null;

  private palette = PALETTES[currentThemeName()];
  private readonly stopThemeWatch: () => void;
  /** Where the ground grid sits and how big it is, to rebuild it in another colour. */
  private gridSpan = 10;
  private gridCentre = new THREE.Vector3();

  private dirty = true;
  private disposed = false;
  private frameHandle = 0;
  private frameCount = 0;
  private lastFpsAt = performance.now();

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: SceneCallbacks = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      // Section capping is a stencil technique, so the stencil buffer is not
      // optional here.
      stencil: true,
      // Keeps the last frame readable after it has been presented, which is
      // what makes the PNG snapshot correct rather than occasionally blank.
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(this.palette.background, 1);
    // Local clipping (not global) so the section cap can stay unclipped.
    this.renderer.localClippingEnabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.style.position = 'absolute';
    this.labelRenderer.domElement.style.inset = '0';
    this.labelRenderer.domElement.style.pointerEvents = 'none';
    this.labelRenderer.domElement.style.overflow = 'hidden';
    container.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10_000);
    this.camera.position.set(6, 5, 8);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.rotateSpeed = 0.85;
    this.controls.panSpeed = 0.9;
    this.controls.zoomSpeed = 0.9;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.requestRender());

    this.setupEnvironment();

    this.grid = new THREE.GridHelper(10, 10, this.palette.gridMajor, this.palette.gridMinor);
    this.grid.visible = false;
    this.scene.add(this.grid);
    this.stopThemeWatch = onThemeChange((theme) => this.setTheme(theme));

    this.annotations.name = 'annotations';
    this.scene.add(this.annotations);

    this.section = new SectionController(this.scene);

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);
    this.renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.addEventListener('pointerleave', this.onPointerLeave);
    // Captured before the orbit controls see it: Shift+wheel switches the dimension instead of zooming.
    container.addEventListener('wheel', this.onWheel, { capture: true, passive: false });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.loop();
  }

  /* ------------------------------ environment ----------------------------- */

  /** Repaint the background and the grid for the interface theme. */
  setTheme(theme: Theme): void {
    this.palette = PALETTES[theme];
    this.renderer.setClearColor(this.palette.background, 1);
    this.rebuildGrid();
    this.requestRender();
  }

  /** The CAD convention here is Z-up, so the grid is rotated into the XY plane. */
  private rebuildGrid(): void {
    const wasVisible = this.grid.visible;
    this.grid.removeFromParent();
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    const grid = new THREE.GridHelper(this.gridSpan, 20, this.palette.gridMajor, this.palette.gridMinor);
    grid.rotation.x = Math.PI / 2;
    grid.position.copy(this.gridCentre);
    const gridMaterial = grid.material as THREE.Material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.35;
    gridMaterial.depthWrite = false;
    grid.visible = wasVisible;
    this.scene.add(grid);
    this.grid = grid;
  }

  private setupEnvironment(): void {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));

    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(1, 1.4, 1);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xc7dbff, 0.9);
    fill.position.set(-1.2, 0.4, -0.8);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffffff, 0.6);
    rim.position.set(0.2, -1, -0.6);
    this.scene.add(rim);

    // A hemisphere light stops downward-facing surfaces going pure black, which
    // otherwise makes engineering parts hard to read from below.
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2a2f3a, 0.55));
  }

  /* -------------------------------- model --------------------------------- */

  /**
   * Show a model, replacing whatever was there.
   *
   * `disposePrevious` is false while an assembly is being built: the caller
   * still owns those component models and merges them again each time a new
   * part arrives, so their buffers must survive the swap. It disposes them
   * itself once the document is closed.
   */
  setModel(model: CadModel, disposePrevious = true): void {
    this.clearModel(disposePrevious);
    this.model = model;
    this.scene.add(model.root);

    model.root.updateMatrixWorld(true);
    this.bounds = new THREE.Box3().setFromObject(model.root);
    if (this.bounds.isEmpty()) this.bounds.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));

    for (const part of model.parts) {
      const material = primaryMaterial(part.mesh);
      if (material && 'color' in material) {
        this.originalColors.set(part.id, (material as THREE.MeshStandardMaterial).color.clone());
      }
    }

    const size = this.bounds.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z) || 1;
    this.camera.near = span / 1000;
    this.camera.far = span * 100;
    this.camera.updateProjectionMatrix();

    // Rebuild the ground grid at the model's scale and sit it under the part.
    this.gridSpan = span * 4;
    this.gridCentre.set(
      (this.bounds.min.x + this.bounds.max.x) / 2,
      (this.bounds.min.y + this.bounds.max.y) / 2,
      this.bounds.min.z,
    );
    this.rebuildGrid();

    this.section.setModel(model.parts, this.bounds);
    this.applyDisplayMode();
    this.fit();
    this.requestRender();
  }

  private clearModel(dispose = true): void {
    this.clearPicked();
    this.setHover(null);
    this.clearMeasurements();
    this.clearSelection();
    this.section.clear();

    for (const line of this.edgeLines.values()) {
      line.removeFromParent();
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.edgeLines.clear();
    this.originalColors.clear();
    this.hiddenParts.clear();

    if (this.model) {
      this.model.root.removeFromParent();
      if (dispose) disposeObject(this.model.root);
      this.model = null;
    }
    if (this.boxHelper) {
      this.boxHelper.removeFromParent();
      this.boxHelper = null;
    }
  }

  /* -------------------------------- camera -------------------------------- */

  fit(): void {
    if (this.bounds.isEmpty()) return;
    const centre = this.bounds.getCenter(new THREE.Vector3());
    const distance = this.fitDistance();

    const direction = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    if (direction.lengthSq() < 1e-8) direction.set(1, 0.8, 1);
    direction.normalize();

    this.controls.target.copy(centre);
    this.camera.position.copy(centre).addScaledVector(direction, distance);
    this.camera.updateProjectionMatrix();
    this.controls.update();

    this.homeTarget = centre.clone();
    this.homeDistance = distance;
    this.requestRender();
  }

  resetCamera(): void {
    this.setStandardView('iso');
  }

  /**
   * Distance at which the model's bounding *sphere* fits the frame.
   *
   * Using half the longest side instead is the classic mistake: a cube viewed
   * isometrically is as wide as its diagonal, so its corners get cropped.
   * Narrow viewports also need the horizontal field of view taken into account.
   */
  private fitDistance(): number {
    const size = this.bounds.getSize(new THREE.Vector3());
    const radius = size.length() * 0.5 || 1;
    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * this.camera.aspect);
    const limiting = Math.min(verticalFov, horizontalFov);
    return (radius / Math.sin(limiting / 2)) * 1.12;
  }

  setStandardView(view: StandardView): void {
    if (this.bounds.isEmpty()) return;
    const centre = this.bounds.getCenter(new THREE.Vector3());
    const distance = this.fitDistance();

    // Z-up is the CAD convention, so "front" looks along +Y.
    const directions: Record<StandardView, THREE.Vector3> = {
      front: new THREE.Vector3(0, -1, 0),
      back: new THREE.Vector3(0, 1, 0),
      left: new THREE.Vector3(-1, 0, 0),
      right: new THREE.Vector3(1, 0, 0),
      top: new THREE.Vector3(0, 0, 1),
      bottom: new THREE.Vector3(0, 0, -1),
      iso: new THREE.Vector3(1, -1, 0.85).normalize(),
    };
    const direction = directions[view];
    this.camera.up.set(0, 0, 1);
    if (view === 'top') this.camera.up.set(0, 1, 0);
    if (view === 'bottom') this.camera.up.set(0, -1, 0);

    this.controls.target.copy(centre);
    this.camera.position.copy(centre).addScaledVector(direction, distance);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  zoomBy(factor: number): void {
    const direction = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    direction.multiplyScalar(factor);
    this.camera.position.copy(this.controls.target).add(direction);
    this.controls.update();
    this.requestRender();
  }

  /* ------------------------------- display -------------------------------- */

  setDisplayMode(mode: DisplayMode): void {
    this.displayMode = mode;
    this.applyDisplayMode();
    this.requestRender();
  }

  setOpacity(opacity: number): void {
    this.opacity = THREE.MathUtils.clamp(opacity, 0.05, 1);
    this.applyDisplayMode();
    this.requestRender();
  }

  setColorOverride(color: string | null): void {
    this.colorOverride = color;
    this.applyDisplayMode();
    this.requestRender();
  }

  setGridVisible(visible: boolean): void {
    this.grid.visible = visible;
    this.requestRender();
  }

  /** True when at least one part was too dense to build edge geometry for. */
  private edgesSkipped = false;

  get edgesUnavailable(): boolean {
    return this.edgesSkipped;
  }

  private applyDisplayMode(): void {
    if (!this.model) return;
    const wantEdges = this.displayMode === 'shaded-edges';
    const wireframe = this.displayMode === 'wireframe';
    this.edgesSkipped = false;

    for (const part of this.model.parts) {
      const hidden = this.hiddenParts.has(part.id);
      part.mesh.visible = !hidden;

      for (const material of materialsOf(part.mesh)) {
        const standard = material as THREE.MeshStandardMaterial;
        standard.wireframe = wireframe;
        standard.transparent = this.opacity < 1;
        standard.opacity = this.opacity;
        standard.depthWrite = this.opacity >= 1;
        if ('color' in standard) {
          const base = this.originalColors.get(part.id);
          const selected = this.selectedPartId === part.id;
          if (selected) standard.color.copy(SELECT_COLOR);
          else if (this.colorOverride) standard.color.set(this.colorOverride);
          else if (base) standard.color.copy(base);
          // Faces coloured one by one: their colours, unless one colour stands for the whole part.
          standard.vertexColors = Boolean(part.mesh.geometry.getAttribute('color')) && !selected && !this.colorOverride;
        }
        standard.needsUpdate = true;
      }

      if (wantEdges && !hidden) {
        this.ensureEdges(part);
      }
      const line = this.edgeLines.get(part.id);
      if (line) line.visible = wantEdges && !hidden;
    }
  }

  private ensureEdges(part: CadPart): void {
    if (this.edgeLines.has(part.id)) return;
    if (part.triangles > EDGE_TRIANGLE_LIMIT) {
      this.edgesSkipped = true;
      return;
    }
    const edges = new THREE.EdgesGeometry(part.mesh.geometry, 24);
    const material = new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: 0.85 });
    material.clippingPlanes = this.section.isEnabled ? [this.section.plane] : null;
    const line = new THREE.LineSegments(edges, material);
    line.renderOrder = 7;
    part.mesh.add(line);
    this.edgeLines.set(part.id, line);
  }

  /* ------------------------------ visibility ------------------------------ */

  setPartVisible(partId: string, visible: boolean): void {
    if (visible) this.hiddenParts.delete(partId);
    else this.hiddenParts.add(partId);
    this.applyDisplayMode();
    this.requestRender();
  }

  /** Hide everything except the given parts. Pass `null` to show all. */
  isolate(partIds: string[] | null): void {
    if (!this.model) return;
    this.hiddenParts.clear();
    if (partIds && partIds.length > 0) {
      const keep = new Set(partIds);
      for (const part of this.model.parts) {
        if (!keep.has(part.id)) this.hiddenParts.add(part.id);
      }
    }
    this.applyDisplayMode();
    this.requestRender();
  }

  get hidden(): ReadonlySet<string> {
    return this.hiddenParts;
  }

  /* ------------------------------ selection ------------------------------- */

  select(partId: string | null, faceIndex: number | null = null): void {
    this.selectedPartId = partId;
    this.clearFaceHighlight();

    if (partId && faceIndex !== null && this.model) {
      const part = this.model.parts.find((candidate) => candidate.id === partId);
      if (part?.faceRanges) this.highlightFace(part, faceIndex);
    }

    this.applyDisplayMode();
    const part = this.model?.parts.find((candidate) => candidate.id === partId);
    this.callbacks.onSelectionChange?.({
      partId,
      faceIndex,
      faceCount: part?.faceRanges ? part.faceRanges.length / 2 : null,
    });
    this.requestRender();
  }

  clearSelection(): void {
    this.selectedPartId = null;
    this.clearFaceHighlight();
    this.applyDisplayMode();
    this.callbacks.onSelectionChange?.({ partId: null, faceIndex: null, faceCount: null });
    this.requestRender();
  }

  get selected(): string | null {
    return this.selectedPartId;
  }

  private highlightFace(part: CadPart, faceIndex: number): void {
    const ranges = part.faceRanges;
    if (!ranges) return;
    const first = ranges[faceIndex * 2];
    const last = ranges[faceIndex * 2 + 1];
    if (first === undefined || last === undefined) return;

    const sourceIndex = part.mesh.geometry.getIndex();
    if (!sourceIndex) return;

    const count = (last - first + 1) * 3;
    const subset = new Uint32Array(count);
    for (let i = 0; i < count; i += 1) subset[i] = sourceIndex.getX(first * 3 + i);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', part.mesh.geometry.getAttribute('position'));
    geometry.setIndex(new THREE.BufferAttribute(subset, 1));
    geometry.computeVertexNormals();

    const material = new THREE.MeshBasicMaterial({
      color: 0xffc46b,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    material.clippingPlanes = this.section.isEnabled ? [this.section.plane] : null;

    const highlight = new THREE.Mesh(geometry, material);
    highlight.renderOrder = 8;
    part.mesh.add(highlight);
    this.faceHighlight = highlight;
  }

  private clearFaceHighlight(): void {
    if (!this.faceHighlight) return;
    this.faceHighlight.removeFromParent();
    this.faceHighlight.geometry.dispose();
    (this.faceHighlight.material as THREE.Material).dispose();
    this.faceHighlight = null;
  }

  /* ------------------------------ bounding box ---------------------------- */

  setBoundingBoxVisible(visible: boolean, partId?: string | null): void {
    if (this.boxHelper) {
      this.boxHelper.removeFromParent();
      this.boxHelper = null;
    }
    if (!visible || !this.model) {
      this.requestRender();
      return;
    }
    const target = partId ? this.model.parts.find((part) => part.id === partId) : null;
    const box = target
      ? new THREE.Box3().setFromObject(target.mesh)
      : this.bounds.clone();
    this.boxHelper = new THREE.Box3Helper(box, new THREE.Color(0x4c8dff));
    (this.boxHelper.material as THREE.Material).depthTest = false;
    this.boxHelper.renderOrder = 9;
    this.scene.add(this.boxHelper);
    this.requestRender();
  }

  get modelBounds(): THREE.Box3 {
    return this.bounds;
  }

  /* -------------------------------- tools --------------------------------- */

  setTool(tool: ToolMode): void {
    if (this.tool === 'measure' && tool !== 'measure') {
      this.clearPicked();
      this.setHover(null);
    }
    this.tool = tool;
    this.clearPending();
    this.renderer.domElement.style.cursor = tool === 'select' ? '' : 'crosshair';
    this.requestRender();
  }

  get activeTool(): ToolMode {
    return this.tool;
  }

  clearMeasurements(): void {
    for (const child of [...this.annotations.children]) {
      this.annotations.remove(child);
      disposeObject(child);
    }
    this.measurements = [];
    this.clearPending();
    this.callbacks.onMeasurementsChange?.([]);
    this.requestRender();
  }

  removeMeasurement(id: string): void {
    const target = this.annotations.children.find((child) => child.userData.measurementId === id);
    if (target) {
      this.annotations.remove(target);
      disposeObject(target);
    }
    this.measurements = this.measurements.filter((measurement) => measurement.id !== id);
    this.callbacks.onMeasurementsChange?.([...this.measurements]);
    this.requestRender();
  }

  private clearPending(): void {
    for (const marker of this.pendingMarkers) {
      marker.removeFromParent();
      disposeObject(marker);
    }
    this.pendingMarkers = [];
    this.pendingPoints = [];
    this.callbacks.onPendingPointsChange?.(0);
  }

  /* ------------------------------- picking -------------------------------- */

  private pointerDownAt = { x: 0, y: 0, time: 0 };

  private onPointerDown = (event: PointerEvent): void => {
    this.pointerDownAt = { x: event.clientX, y: event.clientY, time: performance.now() };
  };

  private onPointerUp = (event: PointerEvent): void => {
    // Ignore the pointer-up that ends an orbit or pan gesture.
    const moved = Math.hypot(event.clientX - this.pointerDownAt.x, event.clientY - this.pointerDownAt.y);
    if (moved > 4 || performance.now() - this.pointerDownAt.time > 600) return;
    if (event.button !== 0) return;
    this.handleClick(event);
  };

  private handleClick(event: PointerEvent): void {
    if (!this.model) return;
    const hit = this.pick(event);

    if (this.tool === 'select') {
      if (!hit) {
        this.clearSelection();
        return;
      }
      const faceIndex =
        hit.part.faceRanges && hit.faceIndex !== null ? faceIndexForTriangle(hit.part.faceRanges, hit.faceIndex) : null;
      this.select(hit.part.id, faceIndex);
      return;
    }

    if (this.tool === 'measure') {
      this.measureClick(event);
      return;
    }

    if (!hit) return;

    // Distance and angle collect points.
    const local = hit.part.mesh.worldToLocal(hit.point.clone());
    const span = Math.max(...this.bounds.getSize(new THREE.Vector3()).toArray()) || 1;
    const snapped = snapToVertex(hit.part.mesh.geometry, hit.face, local, span * 0.02);
    const worldPoint = snapped ? hit.part.mesh.localToWorld(snapped.clone()) : hit.point.clone();

    this.pendingPoints.push(worldPoint);
    this.pendingMarkers.push(this.addPointMarker(worldPoint));
    this.callbacks.onPendingPointsChange?.(this.pendingPoints.length);

    if (this.tool === 'measure-distance' && this.pendingPoints.length === 2) {
      this.commitDistance(this.pendingPoints[0], this.pendingPoints[1]);
    } else if (this.tool === 'measure-angle' && this.pendingPoints.length === 3) {
      this.commitAngle(this.pendingPoints[0], this.pendingPoints[1], this.pendingPoints[2]);
    }
    this.requestRender();
  }

  private pick(event: PointerEvent): { part: CadPart; point: THREE.Vector3; face: THREE.Face | null; faceIndex: number | null } | null {
    if (!this.model) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const meshes = this.model.parts.filter((part) => !this.hiddenParts.has(part.id)).map((part) => part.mesh);
    const intersections = this.raycaster.intersectObjects(meshes, false);

    for (const intersection of intersections) {
      // Points cut away by the section plane must not be selectable.
      if (this.section.isEnabled && this.section.plane.distanceToPoint(intersection.point) < 0) continue;
      const part = this.model.parts.find((candidate) => candidate.mesh === intersection.object);
      if (!part) continue;
      return {
        part,
        point: intersection.point.clone(),
        face: intersection.face ?? null,
        faceIndex: intersection.faceIndex ?? null,
      };
    }
    return null;
  }

  /* ----------------------------- measurements ----------------------------- */

  /* ---------------------------- smart measuring ---------------------------- */

  /** The face, edge or vertex under a pointer position, or null over the background. */
  private entityUnder(event: { clientX: number; clientY: number }): Entity | null {
    const hit = this.pick(event as PointerEvent);
    if (!hit || hit.faceIndex === null) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const projected = new THREE.Vector3();
    const toScreen = (world: THREE.Vector3) => {
      projected.copy(world).project(this.camera);
      return { x: ((projected.x + 1) / 2) * rect.width, y: ((1 - projected.y) / 2) * rect.height };
    };
    return entityAt(hit.part, hit.faceIndex, pointer, toScreen);
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (this.tool !== 'measure' || event.buttons !== 0) return;
    this.hoverEvent = event;
    if (this.hoverFrame) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      const pending = this.hoverEvent;
      if (!pending || this.tool !== 'measure' || !this.model) return;
      const entity = this.entityUnder(pending);
      if (entity && this.picked.some((picked) => sameEntity(picked, entity))) this.setHover(null);
      else if (!(entity && this.hoverEntity && sameEntity(entity, this.hoverEntity))) this.setHover(entity);
    });
  };

  private onPointerLeave = (): void => {
    this.hoverEvent = null;
    this.setHover(null);
  };

  /** Shift+wheel anywhere over the view, or the wheel over the dimension's label: the next variant. */
  private onWheel = (event: WheelEvent): void => {
    if (this.tool !== 'measure' || this.liveOptions.length < 2 || !event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = event.deltaY || event.deltaX;
    if (delta !== 0) this.cycleMeasure(delta > 0 ? 1 : -1);
  };

  private setHover(entity: Entity | null): void {
    if (this.hoverObject) this.removeHighlight(this.hoverObject);
    this.hoverObject = null;
    this.hoverEntity = entity;
    if (entity) this.hoverObject = this.highlight(entity, HOVER_COLOR);
    this.requestRender();
  }

  private measureClick(event: PointerEvent): void {
    const entity = this.entityUnder(event);
    if (!entity) {
      // A click on nothing keeps what was measured and starts afresh.
      this.commitMeasure();
      this.clearPicked();
      return;
    }
    const already = this.picked.findIndex((picked) => sameEntity(picked, entity));
    if (already >= 0) {
      this.picked.splice(already, 1);
      this.removeHighlight(this.pickedObjects.splice(already, 1)[0]);
      this.refreshLive();
      return;
    }
    if (this.picked.length >= 2) {
      this.commitMeasure();
      this.clearPicked();
    }
    this.setHover(null);
    this.picked.push(entity);
    this.pickedObjects.push(this.highlight(entity, PICKED_COLOR));
    this.refreshLive();
  }

  /** Recompute the dimensions the picked entities offer; keep the chosen kind when it still applies. */
  private refreshLive(): void {
    const keep = this.liveOptions[this.liveIndex]?.key;
    this.removeLive();
    const view = new THREE.Vector3().subVectors(this.controls.target, this.camera.position).normalize();
    const span = this.bounds.getSize(new THREE.Vector3()).length() || 1;
    this.liveOptions = this.picked.length > 0 ? measureOptions(this.picked, view, span) : [];
    const kept = keep ? this.liveOptions.findIndex((option) => option.key === keep) : -1;
    this.liveIndex = kept >= 0 ? kept : 0;
    this.drawLive();
  }

  private drawLive(): void {
    this.removeLive();
    const option = this.liveOptions[this.liveIndex];
    if (option) this.liveGroup = this.drawDimension(option, true);
    this.emitLive();
    this.requestRender();
  }

  private removeLive(): void {
    if (!this.liveGroup) return;
    this.removeHighlight(this.liveGroup);
    this.liveGroup = null;
  }

  private emitLive(): void {
    if (this.picked.length === 0) {
      this.callbacks.onLiveMeasureChange?.(this.tool === 'measure' ? { selection: [], options: [], index: 0 } : null);
      return;
    }
    this.callbacks.onLiveMeasureChange?.({
      selection: this.picked.map(describe),
      options: this.liveOptions.map((option) => ({
        key: option.key,
        label: option.label,
        kind: option.kind,
        value: option.value,
        text: this.optionText(option),
      })),
      index: this.liveIndex,
    });
  }

  /** The next (or previous) dimension the picked entities offer. */
  cycleMeasure(step: number): void {
    const count = this.liveOptions.length;
    if (count < 2) return;
    this.liveIndex = (((this.liveIndex + step) % count) + count) % count;
    this.drawLive();
  }

  chooseMeasure(index: number): void {
    if (index < 0 || index >= this.liveOptions.length) return;
    this.liveIndex = index;
    this.drawLive();
  }

  /** Keep the dimension on screen and in the list. */
  commitMeasure(): boolean {
    const option = this.liveOptions[this.liveIndex];
    if (!option) return false;
    this.removeLive();
    const group = this.drawDimension(option, false);
    const points = [option.a, option.b, option.point].filter((p): p is THREE.Vector3 => Boolean(p));
    this.pushMeasurement({
      id: group.userData.measurementId as string,
      kind: option.kind,
      label: option.label,
      value: option.value,
      detail:
        option.kind === 'coords' && option.point
          ? (['x', 'y', 'z'] as const).map((axis) => ({ key: axis.toUpperCase(), value: formatLength(option.point![axis], this.units) }))
          : option.a && option.b && option.kind === 'distance'
            ? (['x', 'y', 'z'] as const).map((axis) => ({
                key: `Δ${axis.toUpperCase()}`,
                value: formatLength(Math.abs(option.b![axis] - option.a![axis]), this.units),
              }))
            : [],
      points: points.map((p) => p.toArray() as [number, number, number]),
    });
    this.liveOptions = [];
    this.liveIndex = 0;
    return true;
  }

  /** Drop the picked entities and the dimension not yet kept. */
  clearPicked(): void {
    for (const object of this.pickedObjects) this.removeHighlight(object);
    this.pickedObjects = [];
    this.picked = [];
    this.liveOptions = [];
    this.liveIndex = 0;
    this.removeLive();
    this.emitLive();
    this.requestRender();
  }

  get hasPicked(): boolean {
    return this.picked.length > 0;
  }

  /** A face, edge or vertex drawn over the model in `color`. */
  private highlight(entity: Entity, color: number): THREE.Object3D {
    if (entity.kind === 'face') {
      const triangles = faceTriangleList(entity.part, entity.index);
      const source = entity.part.mesh.geometry;
      const sourceIndex = source.getIndex();
      const subset = new Uint32Array(triangles.length * 3);
      triangles.forEach((t, k) => {
        for (let j = 0; j < 3; j += 1) subset[k * 3 + j] = sourceIndex ? sourceIndex.getX(t * 3 + j) : t * 3 + j;
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', source.getAttribute('position'));
      geometry.setIndex(new THREE.BufferAttribute(subset, 1));
      const material = new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: color === PICKED_COLOR ? 0.55 : 0.4,
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      material.clippingPlanes = this.section.isEnabled ? [this.section.plane] : null;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 8;
      // The position attribute belongs to the part: only the index is ours to free.
      mesh.userData.sharedPosition = true;
      entity.part.mesh.add(mesh);
      return mesh;
    }
    if (entity.kind === 'edge') {
      const line = this.fatLine(edgeLocalPoints(entity.part, entity.index), color, 4);
      line.renderOrder = 22;
      entity.part.mesh.add(line);
      return line;
    }
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(this.markerSize() * 1.2, 16, 12),
      new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }),
    );
    marker.position.copy(entity.point);
    marker.renderOrder = 23;
    this.scene.add(marker);
    return marker;
  }

  private removeHighlight(object: THREE.Object3D): void {
    object.removeFromParent();
    object.traverse((child) => {
      const material = (child as THREE.Mesh).material;
      if (material instanceof LineMaterial) this.lineMaterials.delete(material);
      // Leave the part's own vertex buffer alone; free only our index.
      if (child.userData.sharedPosition) (child as THREE.Mesh).geometry.deleteAttribute('position');
    });
    disposeObject(object);
    this.requestRender();
  }

  private markerSize(): number {
    return (Math.max(...this.bounds.getSize(new THREE.Vector3()).toArray()) || 1) * 0.005;
  }

  private fatLine(points: THREE.Vector3[], color: number, width: number, closed = false): Line2 {
    const flat: number[] = [];
    for (const p of points) flat.push(p.x, p.y, p.z);
    if (closed && points.length > 0) flat.push(points[0].x, points[0].y, points[0].z);
    const geometry = new LineGeometry();
    geometry.setPositions(flat);
    const material = new LineMaterial({ color, linewidth: width, depthTest: false, transparent: true });
    material.resolution.set(this.container.clientWidth || 1, this.container.clientHeight || 1);
    this.lineMaterials.add(material);
    const line = new Line2(geometry, material);
    line.computeLineDistances();
    return line;
  }

  /** A dimension as a drawing shows it: line with arrows, circle or arc, and its value. */
  private drawDimension(option: MeasureOption, live: boolean): THREE.Group {
    const group = this.createAnnotation();
    const size = this.markerSize();
    const arrow = (tip: THREE.Vector3, from: THREE.Vector3) => {
      const direction = tip.clone().sub(from);
      const length = direction.length();
      if (length < 1e-12) return;
      const head = Math.min(size * 3, length * 0.25);
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(head * 0.35, head, 12),
        new THREE.MeshBasicMaterial({ color: MEASURE_COLOR, depthTest: false, transparent: true }),
      );
      cone.position.copy(tip).addScaledVector(direction.normalize(), -head / 2);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
      cone.renderOrder = 21;
      group.add(cone);
    };
    if (option.a && option.b && option.a.distanceTo(option.b) > 0) {
      const line = this.fatLine([option.a, option.b], MEASURE_COLOR, 2.5);
      line.renderOrder = 20;
      group.add(line);
      arrow(option.b, option.a);
      if (option.kind !== 'radius') arrow(option.a, option.b);
    }
    if (option.circle) {
      const { center, normal, radius } = option.circle;
      const helper = Math.abs(normal.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
      const u = helper.cross(normal).normalize();
      const w = normal.clone().cross(u).normalize();
      const ring: THREE.Vector3[] = [];
      for (let i = 0; i < 96; i += 1) {
        const angle = (i / 96) * Math.PI * 2;
        ring.push(center.clone().addScaledVector(u, Math.cos(angle) * radius).addScaledVector(w, Math.sin(angle) * radius));
      }
      const circle = this.fatLine(ring, MEASURE_COLOR, 1.5, true);
      circle.renderOrder = 20;
      group.add(circle);
    }
    if (option.arc) {
      const { center, from, to, radius } = option.arc;
      const axis = from.clone().cross(to);
      const angle = from.angleTo(to);
      const points: THREE.Vector3[] = [];
      if (axis.lengthSq() > 1e-12) {
        axis.normalize();
        for (let i = 0; i <= 48; i += 1) points.push(from.clone().applyAxisAngle(axis, (angle * i) / 48).multiplyScalar(radius).add(center));
        const arc = this.fatLine(points, MEASURE_COLOR, 2);
        arc.renderOrder = 20;
        group.add(arc);
        const rays = this.fatLine([center.clone().addScaledVector(from, radius * 1.15), center, center.clone().addScaledVector(to, radius * 1.15)], MEASURE_COLOR, 1.5);
        rays.renderOrder = 20;
        group.add(rays);
        option = { ...option, labelAt: points[24].clone() };
      }
    }
    if (option.kind === 'coords' && option.point) group.add(this.createPointMarker(option.point));

    const element = document.createElement('div');
    element.className = live ? 'cad-label cad-label-live' : 'cad-label';
    element.textContent = this.optionText(option);
    if (live && this.liveOptions.length > 1) {
      const counter = document.createElement('span');
      counter.className = 'cad-label-count';
      counter.textContent = ` ${this.liveIndex + 1}/${this.liveOptions.length}`;
      element.appendChild(counter);
      element.title = translate('Wheel or Space: next variant');
      element.addEventListener(
        'wheel',
        (event) => {
          event.preventDefault();
          event.stopPropagation();
          const delta = event.deltaY || event.deltaX;
          if (delta !== 0) this.cycleMeasure(delta > 0 ? 1 : -1);
        },
        { passive: false },
      );
    }
    const label = new CSS2DObject(element);
    label.position.copy(option.labelAt);
    group.add(label);
    this.requestRender();
    return group;
  }

  /** The value as a drawing writes it: Ø 12.00 mm, R 6.00 mm, 45.00°. */
  private optionText(option: MeasureOption): string {
    switch (option.kind) {
      case 'diameter':
        return `Ø ${formatLength(option.value, this.units)}`;
      case 'radius':
        return `R ${formatLength(option.value, this.units)}`;
      case 'angle':
        return formatAngle(option.value);
      case 'area':
        return formatArea(option.value, this.units);
      case 'coords': {
        const p = option.point ?? new THREE.Vector3();
        const round = (value: number) => decimal(value.toFixed(Math.abs(value) < 1000 ? 2 : 1));
        return `X ${round(p.x)}  Y ${round(p.y)}  Z ${round(p.z)}`;
      }
      default:
        return formatLength(option.value, this.units);
    }
  }

  private commitDistance(a: THREE.Vector3, b: THREE.Vector3): void {
    const distance = a.distanceTo(b);
    const group = this.createAnnotation();
    group.add(this.createLine([a, b]));
    group.add(this.createPointMarker(a), this.createPointMarker(b));
    group.add(this.createLabel(midpoint(a, b), formatValue(distance, this.units)));

    this.pushMeasurement({
      id: group.userData.measurementId as string,
      kind: 'distance',
      label: 'Distance',
      value: distance,
      detail: [
        { key: 'ΔX', value: formatValue(Math.abs(b.x - a.x), this.units) },
        { key: 'ΔY', value: formatValue(Math.abs(b.y - a.y), this.units) },
        { key: 'ΔZ', value: formatValue(Math.abs(b.z - a.z), this.units) },
      ],
      points: [a.toArray() as [number, number, number], b.toArray() as [number, number, number]],
    });
    this.clearPending();
  }

  private commitAngle(a: THREE.Vector3, vertex: THREE.Vector3, c: THREE.Vector3): void {
    const first = new THREE.Vector3().subVectors(a, vertex);
    const second = new THREE.Vector3().subVectors(c, vertex);
    if (first.lengthSq() < 1e-12 || second.lengthSq() < 1e-12) {
      this.clearPending();
      return;
    }
    const radians = first.angleTo(second);
    const degrees = THREE.MathUtils.radToDeg(radians);

    const group = this.createAnnotation();
    group.add(this.createLine([a, vertex, c]));
    for (const point of [a, vertex, c]) group.add(this.createPointMarker(point));

    // A small arc at the vertex makes the measured angle unmistakable.
    const radius = Math.min(first.length(), second.length()) * 0.35;
    const arcPoints: THREE.Vector3[] = [];
    const steps = 24;
    const axis = new THREE.Vector3().crossVectors(first, second).normalize();
    if (axis.lengthSq() > 0.5) {
      const start = first.clone().normalize().multiplyScalar(radius);
      for (let i = 0; i <= steps; i += 1) {
        arcPoints.push(start.clone().applyAxisAngle(axis, (radians * i) / steps).add(vertex));
      }
      group.add(this.createLine(arcPoints));
    }
    group.add(
      this.createLabel(
        vertex.clone().add(first.clone().normalize().add(second.clone().normalize()).multiplyScalar(radius * 0.9)),
        `${degrees.toFixed(2)}°`,
      ),
    );

    this.pushMeasurement({
      id: group.userData.measurementId as string,
      kind: 'angle',
      label: 'Angle',
      value: degrees,
      detail: [
        { key: 'Leg A', value: formatValue(first.length(), this.units) },
        { key: 'Leg B', value: formatValue(second.length(), this.units) },
      ],
      points: [
        a.toArray() as [number, number, number],
        vertex.toArray() as [number, number, number],
        c.toArray() as [number, number, number],
      ],
    });
    this.clearPending();
  }

  private pushMeasurement(record: MeasurementRecord): void {
    this.measurements.push(record);
    this.callbacks.onMeasurementsChange?.([...this.measurements]);
    this.requestRender();
  }

  private createAnnotation(): THREE.Group {
    const group = new THREE.Group();
    group.userData.measurementId = `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.annotations.add(group);
    return group;
  }

  private createLine(points: THREE.Vector3[]): THREE.Line {
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({ color: MEASURE_COLOR, depthTest: false, transparent: true });
    const line = new THREE.Line(geometry, material);
    line.renderOrder = 20;
    return line;
  }

  private createPointMarker(position: THREE.Vector3): THREE.Mesh {
    const span = Math.max(...this.bounds.getSize(new THREE.Vector3()).toArray()) || 1;
    const geometry = new THREE.SphereGeometry(span * 0.006, 12, 8);
    const material = new THREE.MeshBasicMaterial({ color: MEASURE_COLOR, depthTest: false });
    const marker = new THREE.Mesh(geometry, material);
    marker.position.copy(position);
    marker.renderOrder = 21;
    return marker;
  }

  private addPointMarker(position: THREE.Vector3): THREE.Object3D {
    const marker = this.createPointMarker(position);
    this.scene.add(marker);
    return marker;
  }

  private createLabel(position: THREE.Vector3, text: string): CSS2DObject {
    const element = document.createElement('div');
    element.className = 'cad-label';
    element.textContent = text;
    const label = new CSS2DObject(element);
    label.position.copy(position);
    return label;
  }

  private get units(): string {
    return this.model?.units ?? 'mm';
  }

  /* -------------------------------- render -------------------------------- */

  requestRender(): void {
    this.dirty = true;
  }

  private resize(): void {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.labelRenderer.setSize(width, height);
    for (const material of this.lineMaterials) material.resolution.set(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.frameHandle = requestAnimationFrame(this.loop);

    // Damping keeps moving the camera for a few frames after input stops, so
    // let controls decide whether another frame is needed.
    if (this.controls.update()) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;

    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);

    this.frameCount += 1;
    const now = performance.now();
    if (now - this.lastFpsAt >= 1000) {
      const fps = Math.round((this.frameCount * 1000) / (now - this.lastFpsAt));
      // The renderer only draws when something changed, so a low number while
      // idle means "nothing is happening", not "slow". Report 0 for idle and
      // let the UI hide the counter.
      this.callbacks.onFps?.(this.frameCount >= 10 ? fps : 0);
      this.frameCount = 0;
      this.lastFpsAt = now;
    }
  };

  /**
   * Current canvas as a PNG data URL.
   *
   * Full resolution for the snapshot button, which is meant to be saved; the
   * workspace card passes `maxEdge` so a wall of tiles does not cost megabytes
   * of cached bitmaps.
   */
  snapshot(maxEdge?: number): string {
    this.renderer.render(this.scene, this.camera);
    const canvas = this.renderer.domElement;
    if (!maxEdge || Math.max(canvas.width, canvas.height) <= maxEdge) return canvas.toDataURL('image/png');
    return captureCanvas(canvas, maxEdge) ?? canvas.toDataURL('image/png');
  }

  dispose(): void {
    this.disposed = true;
    this.stopThemeWatch();
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.removeEventListener('pointerleave', this.onPointerLeave);
    this.container.removeEventListener('wheel', this.onWheel, { capture: true });
    cancelAnimationFrame(this.hoverFrame);
    this.clearModel();
    this.section.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelRenderer.domElement.remove();
  }
}

/* --------------------------------- helpers -------------------------------- */

function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

function primaryMaterial(mesh: THREE.Mesh): THREE.Material | null {
  return Array.isArray(mesh.material) ? mesh.material[0] ?? null : mesh.material ?? null;
}

function midpoint(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
  return a.clone().add(b).multiplyScalar(0.5);
}

function formatValue(value: number, unit: string): string {
  const absolute = Math.abs(value);
  if (absolute < 0.01) return `${value.toExponential(2)} ${unit}`;
  if (absolute < 10) return `${value.toFixed(3)} ${unit}`;
  if (absolute < 1000) return `${value.toFixed(2)} ${unit}`;
  return `${value.toFixed(1)} ${unit}`;
}

export function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = (child as THREE.Mesh).material;
    if (Array.isArray(material)) for (const entry of material) entry.dispose();
    else if (material) material.dispose();
    // CSS2D labels own a DOM node that outlives the scene graph otherwise.
    const label = child as Partial<CSS2DObject>;
    if (label.element instanceof HTMLElement) label.element.remove();
  });
}
