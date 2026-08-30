import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { captureCanvas } from '@/lib/thumbnail';
import { findEdgeAtPoint, faceIndexForTriangle, snapToVertex } from './geometry';
import { SectionController } from './section';
import type { CadModel, CadPart, DisplayMode, MeasurementRecord, StandardView, ToolMode } from './types';

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
  onFps?(fps: number): void;
}

const SELECT_COLOR = new THREE.Color(0xff8a3d);
const EDGE_COLOR = new THREE.Color(0x2a3444);
const MEASURE_COLOR = 0xf5a524;
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

  private displayMode: DisplayMode = 'shaded';
  private opacity = 1;
  private colorOverride: string | null = null;

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
    this.renderer.setClearColor(0x0e131b, 1);
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

    this.grid = new THREE.GridHelper(10, 10, 0x33405a, 0x1d2534);
    this.grid.visible = false;
    this.scene.add(this.grid);

    this.annotations.name = 'annotations';
    this.scene.add(this.annotations);

    this.section = new SectionController(this.scene);

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.loop();
  }

  /* ------------------------------ environment ----------------------------- */

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
    // The CAD convention here is Z-up, so the grid is rotated into the XY plane.
    const wasVisible = this.grid.visible;
    this.grid.removeFromParent();
    this.grid.geometry.dispose();
    const grid = new THREE.GridHelper(span * 4, 20, 0x33405a, 0x1d2534);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(
      (this.bounds.min.x + this.bounds.max.x) / 2,
      (this.bounds.min.y + this.bounds.max.y) / 2,
      this.bounds.min.z,
    );
    const gridMaterial = grid.material as THREE.Material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.35;
    gridMaterial.depthWrite = false;
    grid.visible = wasVisible;
    this.scene.add(grid);
    this.grid = grid;

    this.section.setModel(model.parts, this.bounds);
    this.applyDisplayMode();
    this.fit();
    this.requestRender();
  }

  private clearModel(dispose = true): void {
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
          if (this.selectedPartId === part.id) standard.color.copy(SELECT_COLOR);
          else if (this.colorOverride) standard.color.set(this.colorOverride);
          else if (base) standard.color.copy(base);
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
    this.tool = tool;
    this.clearPending();
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

    if (!hit) return;

    if (this.tool === 'measure-length') {
      this.measureEdge(hit);
      return;
    }

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

  private measureEdge(hit: { part: CadPart; point: THREE.Vector3 }): void {
    const local = hit.part.mesh.worldToLocal(hit.point.clone());
    const edge = findEdgeAtPoint(hit.part.mesh.geometry, local);
    if (!edge) {
      // Too dense to index; say nothing rather than report a wrong number.
      return;
    }
    const start = hit.part.mesh.localToWorld(edge.start.clone());
    const end = hit.part.mesh.localToWorld(edge.end.clone());
    const length = start.distanceTo(end);

    const group = this.createAnnotation();
    group.add(this.createLine([start, end]));
    group.add(this.createPointMarker(start), this.createPointMarker(end));
    group.add(this.createLabel(midpoint(start, end), formatValue(length, this.units)));

    this.pushMeasurement({
      id: group.userData.measurementId as string,
      kind: 'length',
      label: 'Edge length',
      value: length,
      detail: [],
      points: [start.toArray() as [number, number, number], end.toArray() as [number, number, number]],
    });
    this.clearPending();
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
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
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
