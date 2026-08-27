import type * as THREE from 'three';

/** One selectable solid or mesh in the loaded model. */
export interface CadPart {
  id: string;
  name: string;
  mesh: THREE.Mesh;
  /** Tree node this part belongs to. */
  nodeId: string;
  /**
   * Flat `[firstTriangle, lastTriangle]` pairs describing the B-Rep faces the
   * part was tessellated from. Present for STEP/IGES, absent for mesh formats.
   */
  faceRanges?: number[];
  triangles: number;
  vertices: number;
}

/** A node in the assembly tree shown in the left panel. */
export interface CadTreeNode {
  id: string;
  name: string;
  parentId: string | null;
  childIds: string[];
  /** Part ids attached directly to this node. */
  partIds: string[];
  depth: number;
}

export interface CadModel {
  /** Root object added to the scene. */
  root: THREE.Group;
  parts: CadPart[];
  nodes: CadTreeNode[];
  rootIds: string[];
  /** Units label used for every measurement readout. */
  units: string;
  /** Engine that produced the geometry, shown in properties. */
  producer: string;
  stats: { parts: number; triangles: number; vertices: number };
  warnings: string[];
  /** True when the geometry carries B-Rep face information. */
  hasBrepFaces: boolean;
}

export type DisplayMode = 'shaded' | 'shaded-edges' | 'wireframe';

export type StandardView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';

export type ToolMode = 'select' | 'measure-distance' | 'measure-length' | 'measure-angle';

export type SectionAxis = 'x' | 'y' | 'z';

export interface SectionState {
  enabled: boolean;
  axis: SectionAxis;
  /** 0..1 position across the model's extent on that axis. */
  position: number;
  flipped: boolean;
  showCap: boolean;
  hatch: boolean;
}

export interface MeasurementRecord {
  id: string;
  kind: 'distance' | 'length' | 'angle';
  label: string;
  value: number;
  /** Extra readouts shown under the value, e.g. ΔX / ΔY / ΔZ. */
  detail: { key: string; value: string }[];
  points: [number, number, number][];
}

export interface PartProperties {
  name: string;
  type: string;
  size: { x: number; y: number; z: number };
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  volume: number | null;
  /** True when the mesh is not closed, so volume is an estimate. */
  volumeApproximate: boolean;
  surfaceArea: number;
  triangles: number;
  vertices: number;
  brepFaces: number | null;
  material: string | null;
  color: string;
}
