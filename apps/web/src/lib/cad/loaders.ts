import * as THREE from 'three';
import type { NmgManifest } from '@docuview/shared';
import { apiUrl, fetchWithProgress } from '@/lib/api';
import type { CadModel, CadPart, CadTreeNode } from './types';

/** Neutral engineering grey used whenever the file carries no colour. */
export const DEFAULT_PART_COLOR = 0xb4bcc8;

export function createPartMaterial(color: number | string = DEFAULT_PART_COLOR): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    metalness: 0.15,
    roughness: 0.55,
    side: THREE.DoubleSide,
    flatShading: false,
  });
}

/* -------------------------------------------------------------------------- */
/* Normalized geometry (STEP / IGES / BREP)                                   */
/* -------------------------------------------------------------------------- */

export async function loadNmg(
  source: string,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<CadModel> {
  onProgress?.(5);
  const manifestResponse = await fetch(apiUrl(source), { signal });
  if (!manifestResponse.ok) throw new Error('Could not load the prepared geometry.');
  const manifest = (await manifestResponse.json()) as NmgManifest;

  const bufferUrl = source.replace(/[^/]+$/, manifest.buffer.uri);
  const buffer = await fetchWithProgress(
    bufferUrl,
    (loaded, total) => onProgress?.(10 + Math.round((loaded / total) * 70)),
    signal,
  );
  onProgress?.(85);

  const root = new THREE.Group();
  root.name = 'Model';
  const parts: CadPart[] = [];
  const nodes: CadTreeNode[] = [];
  const groupById = new Map<number, THREE.Group>();

  // Nodes first, so parts can be attached to the right group.
  const nodeById = new Map(manifest.nodes.map((node) => [node.id, node]));
  const depthOf = (id: number): number => {
    let depth = 0;
    let current = nodeById.get(id);
    while (current?.parent !== null && current?.parent !== undefined) {
      depth += 1;
      current = nodeById.get(current.parent);
      if (depth > 128) break;
    }
    return depth;
  };

  for (const node of manifest.nodes) {
    const group = new THREE.Group();
    group.name = node.name;
    groupById.set(node.id, group);
    nodes.push({
      id: `n${node.id}`,
      name: node.name,
      parentId: node.parent === null ? null : `n${node.parent}`,
      childIds: node.children.map((child) => `n${child}`),
      partIds: node.meshes.map((mesh) => `m${mesh}`),
      depth: depthOf(node.id),
    });
  }
  for (const node of manifest.nodes) {
    const group = groupById.get(node.id);
    if (!group) continue;
    if (node.parent === null) root.add(group);
    else groupById.get(node.parent)?.add(group);
  }

  const meshOwner = new Map<number, number>();
  for (const node of manifest.nodes) {
    for (const meshId of node.meshes) meshOwner.set(meshId, node.id);
  }

  for (const meshSpec of manifest.meshes) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(buffer, meshSpec.position.offset, meshSpec.position.count);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    if (meshSpec.normal) {
      const normals = new Float32Array(buffer, meshSpec.normal.offset, meshSpec.normal.count);
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    }
    const indices = new Uint32Array(buffer, meshSpec.index.offset, meshSpec.index.count);
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    if (!meshSpec.normal) geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, createPartMaterial(meshSpec.color ?? DEFAULT_PART_COLOR));
    mesh.name = meshSpec.name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    const ownerId = meshOwner.get(meshSpec.id);
    const parent = ownerId !== undefined ? groupById.get(ownerId) : undefined;
    (parent ?? root).add(mesh);

    parts.push({
      id: `m${meshSpec.id}`,
      name: meshSpec.name,
      mesh,
      nodeId: ownerId !== undefined ? `n${ownerId}` : 'n-root',
      faceRanges: meshSpec.faceRanges,
      triangles: meshSpec.index.count / 3,
      vertices: meshSpec.position.count / 3,
    });
  }

  onProgress?.(100);

  return {
    root,
    parts,
    nodes,
    rootIds: manifest.roots.map((id) => `n${id}`),
    units: manifest.units || 'mm',
    producer: manifest.producer,
    stats: {
      parts: manifest.stats.meshes,
      triangles: Math.round(manifest.stats.triangles),
      vertices: Math.round(manifest.stats.vertices),
    },
    warnings: manifest.warnings ?? [],
    hasBrepFaces: manifest.meshes.some((mesh) => (mesh.faceRanges?.length ?? 0) > 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Browser-parsed mesh formats                                                */
/* -------------------------------------------------------------------------- */

/**
 * Mesh formats are parsed here rather than on the server because three.js
 * already ships correct, maintained readers for them — shipping the file
 * straight to the browser removes a whole round trip from the critical path.
 */
export async function loadMeshFile(
  source: string,
  formatId: string,
  fileName: string,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<CadModel> {
  const buffer = await fetchWithProgress(
    source,
    (loaded, total) => onProgress?.(Math.round((loaded / total) * 60)),
    signal,
  );
  onProgress?.(65);

  const object = await parseMesh(buffer, formatId, fileName);
  onProgress?.(88);

  const root = new THREE.Group();
  root.name = fileName;
  root.add(object);

  const { parts, nodes, rootIds } = buildTreeFromObject(root, fileName);
  onProgress?.(100);

  let triangles = 0;
  let vertices = 0;
  for (const part of parts) {
    triangles += part.triangles;
    vertices += part.vertices;
  }

  return {
    root,
    parts,
    nodes,
    rootIds,
    units: 'mm',
    producer: `three.js ${THREE.REVISION} loader`,
    stats: { parts: parts.length, triangles, vertices },
    warnings: [],
    hasBrepFaces: false,
  };
}

async function parseMesh(buffer: ArrayBuffer, formatId: string, fileName: string): Promise<THREE.Object3D> {
  switch (formatId) {
    case 'stl': {
      const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
      const geometry = new STLLoader().parse(buffer);
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, createPartMaterial());
      mesh.name = fileName.replace(/\.[^.]+$/, '') || 'Mesh';
      return mesh;
    }
    case 'obj': {
      const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
      const group = new OBJLoader().parse(new TextDecoder().decode(buffer));
      normalizeMaterials(group);
      return group;
    }
    case 'ply': {
      const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
      const geometry = new PLYLoader().parse(buffer);
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(
        geometry,
        createPartMaterial(geometry.getAttribute('color') ? 0xffffff : DEFAULT_PART_COLOR),
      );
      if (geometry.getAttribute('color')) (mesh.material as THREE.MeshStandardMaterial).vertexColors = true;
      mesh.name = fileName.replace(/\.[^.]+$/, '') || 'Mesh';
      return mesh;
    }
    case '3mf': {
      const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js');
      const group = new ThreeMFLoader().parse(buffer);
      normalizeMaterials(group);
      return group;
    }
    case 'gltf': {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const loader = new GLTFLoader();
      const gltf = await loader.parseAsync(buffer, '');
      prepareImportedMaterials(gltf.scene);
      return gltf.scene;
    }
    case 'fbx': {
      const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
      const group = new FBXLoader().parse(buffer, '');
      prepareImportedMaterials(group);
      return group;
    }
    case 'dae': {
      const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js');
      const collada = new ColladaLoader().parse(new TextDecoder().decode(buffer), '');
      const scene = collada?.scene;
      if (!scene) throw new Error('COLLADA file contained no scene');
      prepareImportedMaterials(scene);
      return scene;
    }
    default:
      throw new Error(`No browser loader for ${formatId}`);
  }
}

/** Formats without materials get the standard CAD look. */
function normalizeMaterials(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    mesh.material = createPartMaterial();
  });
}

/**
 * Imported materials are kept (so textured glTF still looks right) but made
 * safe for the viewer: cloned so edits cannot leak between parts, double sided
 * because CAD exports are often inconsistently wound, and stripped of any
 * flat-shading surprise.
 */
function prepareImportedMaterials(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const cloned = materials.map((material) => {
      if (!material) return createPartMaterial();
      const copy = material.clone();
      copy.side = THREE.DoubleSide;
      return copy;
    });
    mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
    if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
  });
}

/** Turn an arbitrary Object3D hierarchy into the tree the panel renders. */
function buildTreeFromObject(
  root: THREE.Object3D,
  fallbackName: string,
): { parts: CadPart[]; nodes: CadTreeNode[]; rootIds: string[] } {
  const parts: CadPart[] = [];
  const nodes: CadTreeNode[] = [];
  let counter = 0;

  const walk = (object: THREE.Object3D, parentId: string | null, depth: number): string | null => {
    const isMesh = (object as THREE.Mesh).isMesh;
    const meshChildren = object.children.filter((child) => child.visible !== false);

    // Skip pass-through wrappers that carry neither geometry nor a name.
    if (!isMesh && meshChildren.length === 1 && !object.name && depth > 0) {
      return walk(meshChildren[0], parentId, depth);
    }

    const id = `n${counter++}`;
    const node: CadTreeNode = {
      id,
      name: object.name || (isMesh ? `Mesh ${counter}` : depth === 0 ? fallbackName : `Group ${counter}`),
      parentId,
      childIds: [],
      partIds: [],
      depth,
    };
    nodes.push(node);

    if (isMesh) {
      const mesh = object as THREE.Mesh;
      const geometry = mesh.geometry;
      const index = geometry.getIndex();
      const position = geometry.getAttribute('position');
      const partId = `m${parts.length}`;
      node.partIds.push(partId);
      parts.push({
        id: partId,
        name: node.name,
        mesh,
        nodeId: id,
        triangles: index ? index.count / 3 : (position?.count ?? 0) / 3,
        vertices: position?.count ?? 0,
      });
    }

    for (const child of object.children) {
      const childId = walk(child, id, depth + 1);
      if (childId) node.childIds.push(childId);
    }
    return id;
  };

  const rootId = walk(root, null, 0);
  return { parts, nodes, rootIds: rootId ? [rootId] : [] };
}
