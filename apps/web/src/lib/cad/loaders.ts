import * as THREE from 'three';
import type { AssemblyPlacement, NmgManifest } from '@docuview/shared';
import { fetchApi, fetchWithProgress } from '@/lib/api';
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

/**
 * A colour attribute from per-face colours: each face range's vertices take
 * its colour, the rest the mesh's. False when there is nothing to paint.
 */
function paintFaces(
  geometry: THREE.BufferGeometry,
  indices: Uint32Array,
  faceRanges: number[] | undefined,
  faceColors: (string | null)[] | undefined,
  meshColor: string | undefined,
): boolean {
  if (!faceRanges || !faceColors || faceColors.length * 2 !== faceRanges.length) return false;
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  const base = new THREE.Color(meshColor ?? DEFAULT_PART_COLOR);
  for (let v = 0; v < count; v += 1) base.toArray(colors, v * 3);
  const color = new THREE.Color();
  faceColors.forEach((hex, face) => {
    if (!hex) return;
    color.set(hex);
    for (let triangle = faceRanges[face * 2]; triangle <= faceRanges[face * 2 + 1]; triangle += 1) {
      for (let corner = 0; corner < 3; corner += 1) color.toArray(colors, indices[triangle * 3 + corner] * 3);
    }
  });
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return true;
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
  const manifestResponse = await fetchApi(source, { signal });
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

    // Faces of their own colour: vertex colours, the material white beneath them.
    const faceColored = paintFaces(geometry, indices, meshSpec.faceRanges, meshSpec.faceColors, meshSpec.color);
    const mesh = new THREE.Mesh(geometry, createPartMaterial(faceColored ? 0xffffff : (meshSpec.color ?? DEFAULT_PART_COLOR)));
    if (faceColored) (mesh.material as THREE.MeshStandardMaterial).vertexColors = true;
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
      // glTF is in metres with Y up; the viewer measures in millimetres with Z up.
      gltf.scene.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2).scale(new THREE.Vector3(1000, 1000, 1000)));
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

/* -------------------------------------------------------------------------- */
/* Merging several models into one scene                                      */
/* -------------------------------------------------------------------------- */

export interface MergeSource {
  /** Label for the tree node this model hangs under. */
  name: string;
  model: CadModel;
  /** For a part drawn in one of its configurations rather than as last saved. */
  configuration?: string;
}

/**
 * Combine independently loaded models into a single `CadModel`.
 *
 * This is what lets an assembly appear piece by piece: every component that
 * finishes processing is merged in and the scene is rebuilt, so the model grows
 * as the files arrive instead of appearing only once the last one lands.
 *
 * Component *placement* is a separate matter. The transforms live in the
 * assembly's own closed geometry, so unless a converter produced real assembly
 * geometry we cannot know where each part belongs — the parts are laid out side
 * by side instead of stacked at the origin, and the viewer says so.
 */
export function mergeModels(sources: MergeSource[], rootName: string, layout: 'row' | 'stack' = 'row'): CadModel {
  const root = new THREE.Group();
  root.name = rootName;

  const parts: CadPart[] = [];
  const nodes: CadTreeNode[] = [];
  const rootNode: CadTreeNode = { id: 'root', name: rootName, parentId: null, childIds: [], partIds: [], depth: 0 };
  nodes.push(rootNode);

  let triangles = 0;
  let vertices = 0;
  let hasBrepFaces = false;
  const warnings: string[] = [];
  const units = sources[0]?.model.units ?? 'mm';
  const producers = new Set<string>();

  let cursorX = 0;
  const gap = () => {
    const spans = sources.map((source) => {
      const box = new THREE.Box3().setFromObject(source.model.root);
      return box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).x;
    });
    const widest = Math.max(0, ...spans);
    return widest * 0.15 || 1;
  };
  const spacing = layout === 'row' ? gap() : 0;

  sources.forEach((source, index) => {
    const prefix = `c${index}:`;
    const holder = new THREE.Group();
    holder.name = source.name;
    holder.add(source.model.root);

    if (layout === 'row') {
      const box = new THREE.Box3().setFromObject(source.model.root);
      if (!box.isEmpty()) {
        const size = box.getSize(new THREE.Vector3());
        const centre = box.getCenter(new THREE.Vector3());
        // Sit each component on the same origin plane, next to the last one.
        holder.position.set(cursorX + size.x / 2 - centre.x, -box.min.y, -centre.z);
        cursorX += size.x + spacing;
      }
    }
    root.add(holder);

    const holderNode: CadTreeNode = {
      id: `${prefix}holder`,
      name: source.name,
      parentId: rootNode.id,
      childIds: [],
      partIds: [],
      depth: 1,
    };
    nodes.push(holderNode);
    rootNode.childIds.push(holderNode.id);

    for (const node of source.model.nodes) {
      nodes.push({
        id: prefix + node.id,
        name: node.name,
        parentId: node.parentId === null ? holderNode.id : prefix + node.parentId,
        childIds: node.childIds.map((child) => prefix + child),
        partIds: node.partIds.map((part) => prefix + part),
        depth: node.depth + 2,
      });
    }
    for (const id of source.model.rootIds) holderNode.childIds.push(prefix + id);

    for (const part of source.model.parts) {
      parts.push({ ...part, id: prefix + part.id, nodeId: prefix + part.nodeId });
      triangles += part.triangles;
      vertices += part.vertices;
    }

    hasBrepFaces ||= source.model.hasBrepFaces;
    producers.add(source.model.producer);
    warnings.push(...source.model.warnings);
  });

  return {
    root,
    parts,
    nodes,
    rootIds: [rootNode.id],
    units,
    producer: [...producers].join(', ') || 'DocuView',
    stats: { parts: parts.length, triangles, vertices },
    warnings,
    hasBrepFaces,
  };
}

/**
 * An assembly built the way it was designed: every part where the assembly
 * puts it.
 *
 * `placements` come from the assembly file itself, one per occurrence of a
 * part, already resolved through its sub-assemblies. Each occurrence is a copy
 * of the part's loaded model that shares its geometry — a hundred identical
 * screws cost one mesh — but has its own material, so selecting one does not
 * light up the rest. `primary` is geometry the assembly carries itself, already
 * placed; parts whose file has not arrived yet are simply not drawn yet.
 */
export function placeModels(
  primary: CadModel | null,
  components: MergeSource[],
  placements: AssemblyPlacement[],
  rootName: string,
  stored: CadModel | null = null,
): CadModel {
  const root = new THREE.Group();
  root.name = rootName;
  const parts: CadPart[] = [];
  const nodes: CadTreeNode[] = [];
  const rootNode: CadTreeNode = { id: 'root', name: rootName, parentId: null, childIds: [], partIds: [], depth: 0 };
  nodes.push(rootNode);
  const byId = new Map<string, CadTreeNode>([[rootNode.id, rootNode]]);
  const producers = new Set<string>();
  const warnings: string[] = [];
  let triangles = 0;
  let vertices = 0;
  let hasBrepFaces = false;

  /** The tree node for a path of instance names, made on first use. */
  const nodeFor = (path: string[]): CadTreeNode => {
    let parent = rootNode;
    let key = rootNode.id;
    path.forEach((name, depth) => {
      key = `${key}/${name}`;
      let node = byId.get(key);
      if (!node) {
        node = { id: key, name, parentId: parent.id, childIds: [], partIds: [], depth: depth + 1 };
        byId.set(key, node);
        nodes.push(node);
        parent.childIds.push(node.id);
      }
      parent = node;
    });
    return parent;
  };

  if (primary) {
    root.add(primary.root);
    for (const node of primary.nodes) {
      const imported = {
        ...node,
        id: `p:${node.id}`,
        parentId: node.parentId === null ? rootNode.id : `p:${node.parentId}`,
        childIds: node.childIds.map((child) => `p:${child}`),
        partIds: node.partIds.map((part) => `p:${part}`),
        depth: node.depth + 1,
      };
      nodes.push(imported);
      byId.set(imported.id, imported);
    }
    rootNode.childIds.push(...primary.rootIds.map((id) => `p:${id}`));
    for (const part of primary.parts) {
      parts.push({ ...part, id: `p:${part.id}`, nodeId: `p:${part.nodeId}` });
      triangles += part.triangles;
      vertices += part.vertices;
    }
    hasBrepFaces ||= primary.hasBrepFaces;
    producers.add(primary.producer);
    warnings.push(...primary.warnings);
  }

  // A part used in several configurations brings one model per configuration;
  // each occurrence takes the one it was placed as, else the part as saved.
  const models = new Map<string, CadModel>();
  for (const source of components) {
    const name = source.name.toLowerCase();
    models.set(source.configuration === undefined ? name : `${name}|${source.configuration}`, source.model);
  }
  // A part whose file has not been added: the mesh the assembly keeps of it.
  const storedModels = new Map<number, CadModel>();
  const storedModel = (id: number | undefined): CadModel | undefined => {
    if (!stored || id === undefined) return undefined;
    let model = storedModels.get(id);
    if (!model) {
      const part = stored.parts.find((p) => p.id === `m${id}`);
      if (!part) return undefined;
      const mesh = part.mesh.clone();
      const group = new THREE.Group();
      group.add(mesh);
      model = { ...stored, root: group, parts: [{ ...part, mesh }] };
      storedModels.set(id, model);
    }
    return model;
  };
  const matrix = new THREE.Matrix4();
  placements.forEach((placement, index) => {
    const name = placement.component.toLowerCase();
    const model = models.get(`${name}|${placement.configuration}`) ?? models.get(name) ?? storedModel(placement.stored);
    if (!model) return;
    const copy = model.root.clone(true);
    // Pair each original mesh with its copy: clone() keeps traversal order.
    const originals: THREE.Mesh[] = [];
    const copies: THREE.Mesh[] = [];
    model.root.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) originals.push(object as THREE.Mesh);
    });
    copy.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) {
        const mesh = object as THREE.Mesh;
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => m.clone()) : mesh.material.clone();
        copies.push(mesh);
      }
    });
    const twin = new Map(originals.map((mesh, i) => [mesh, copies[i]]));

    const holder = new THREE.Group();
    holder.name = placement.path.join(' / ');
    matrix.fromArray(placement.matrix);
    matrix.decompose(holder.position, holder.quaternion, holder.scale);
    holder.add(copy);
    root.add(holder);

    const node = nodeFor(placement.path);
    for (const part of model.parts) {
      const mesh = twin.get(part.mesh);
      if (!mesh) continue;
      const id = `i${index}:${part.id}`;
      parts.push({ ...part, id, mesh, nodeId: node.id });
      node.partIds.push(id);
      triangles += part.triangles;
      vertices += part.vertices;
    }
    hasBrepFaces ||= model.hasBrepFaces;
    producers.add(model.producer);
  });

  return {
    root,
    parts,
    nodes,
    rootIds: [rootNode.id],
    units: primary?.units ?? components[0]?.model.units ?? 'mm',
    producer: [...producers].join(', ') || 'DocuView',
    stats: { parts: parts.length, triangles, vertices },
    warnings,
    hasBrepFaces,
  };
}
