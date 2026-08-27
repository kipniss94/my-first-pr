import * as THREE from 'three';
import type { CadPart, SectionAxis } from './types';

const AXIS_NORMALS: Record<SectionAxis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

/** Render order slots. The cap has to be drawn after the stencil, before parts. */
const STENCIL_ORDER = 1;
const CAP_ORDER = 2;
const PART_ORDER = 6;

/**
 * Hatched cap material.
 *
 * The stripes live in the cap plane's own space, so they stay put when the
 * model is orbited — which is what a section view is supposed to look like.
 */
function createCapMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uFill: { value: new THREE.Color(0x8fa3bd) },
      uHatch: { value: new THREE.Color(0x2b3648) },
      uSpacing: { value: 6 },
      uHatchOn: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vLocal;
      void main() {
        vLocal = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uFill;
      uniform vec3 uHatch;
      uniform float uSpacing;
      uniform float uHatchOn;
      varying vec2 vLocal;

      void main() {
        vec3 color = uFill;
        if (uHatchOn > 0.5) {
          // 45-degree stripes, anti-aliased with the screen-space derivative so
          // they stay crisp at any zoom instead of turning into moire.
          // vLocal is already in model units, because the cap quad is built at
          // the model's scale - scaling it again put the stripes below one pixel
          // and washed the hatch out completely.
          float coordinate = (vLocal.x + vLocal.y) / uSpacing;
          float stripe = abs(fract(coordinate) - 0.5) * 2.0;
          float width = fwidth(coordinate) * 1.5;
          float line = 1.0 - smoothstep(0.45 - width, 0.45 + width, stripe);
          color = mix(uFill, uHatch, line * 0.55);
        }
        gl_FragColor = vec4(color, 1.0);
        #include <colorspace_fragment>
      }
    `,
    side: THREE.DoubleSide,
    stencilWrite: true,
    stencilRef: 0,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.ReplaceStencilOp,
    stencilZFail: THREE.ReplaceStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
  });
}

/**
 * Section plane with solid capping.
 *
 * The cap is not painted on: back faces increment the stencil buffer and front
 * faces decrement it, so the cap quad only shows where the ray actually passed
 * through material. A tube, a shell or a part with an internal cavity therefore
 * reads as hollow, which is the whole point of sectioning a CAD model.
 */
export class SectionController {
  readonly plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);

  private readonly group = new THREE.Group();
  private readonly capMesh: THREE.Mesh;
  private readonly capMaterial = createCapMaterial();
  private readonly stencilGroups: THREE.Group[] = [];
  private readonly clippedMaterials = new Set<THREE.Material>();

  private bounds = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  private axis: SectionAxis = 'z';
  private position = 0.5;
  private flipped = false;
  private enabled = false;

  constructor(private readonly scene: THREE.Scene) {
    this.group.name = 'section';
    this.group.visible = false;
    this.capMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.capMaterial);
    this.capMesh.renderOrder = CAP_ORDER;
    // Clearing the stencil after the cap keeps multiple frames independent.
    this.capMesh.onAfterRender = (renderer) => renderer.clearStencil();
    this.group.add(this.capMesh);
    this.scene.add(this.group);
  }

  /** Attach to a freshly loaded model. */
  setModel(parts: CadPart[], bounds: THREE.Box3): void {
    this.clear();
    this.bounds = bounds.clone();

    const size = bounds.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z) || 1;
    this.capMesh.geometry.dispose();
    this.capMesh.geometry = new THREE.PlaneGeometry(span * 2.2, span * 2.2);
    // Roughly 40 stripes across the part, which reads as hatching at any size.
    this.capMaterial.uniforms.uSpacing.value = Math.max(span / 40, 1e-4);

    for (const part of parts) {
      part.mesh.renderOrder = PART_ORDER;
      for (const material of materialsOf(part.mesh)) {
        material.clippingPlanes = [this.plane];
        material.clipIntersection = false;
        this.clippedMaterials.add(material);
      }
      const stencil = this.createStencilGroup(part.mesh.geometry);
      // Parenting to the part means a hidden part stops contributing to the
      // cap, exactly as a user would expect after isolating a component.
      part.mesh.add(stencil);
      this.stencilGroups.push(stencil);
    }

    this.update();
  }

  private createStencilGroup(geometry: THREE.BufferGeometry): THREE.Group {
    const group = new THREE.Group();
    const base = new THREE.MeshBasicMaterial();
    base.depthWrite = false;
    base.depthTest = false;
    base.colorWrite = false;
    base.stencilWrite = true;
    base.stencilFunc = THREE.AlwaysStencilFunc;

    const backMaterial = base.clone();
    backMaterial.side = THREE.BackSide;
    backMaterial.clippingPlanes = [this.plane];
    backMaterial.stencilFail = THREE.IncrementWrapStencilOp;
    backMaterial.stencilZFail = THREE.IncrementWrapStencilOp;
    backMaterial.stencilZPass = THREE.IncrementWrapStencilOp;
    const back = new THREE.Mesh(geometry, backMaterial);
    back.renderOrder = STENCIL_ORDER;

    const frontMaterial = base.clone();
    frontMaterial.side = THREE.FrontSide;
    frontMaterial.clippingPlanes = [this.plane];
    frontMaterial.stencilFail = THREE.DecrementWrapStencilOp;
    frontMaterial.stencilZFail = THREE.DecrementWrapStencilOp;
    frontMaterial.stencilZPass = THREE.DecrementWrapStencilOp;
    const front = new THREE.Mesh(geometry, frontMaterial);
    front.renderOrder = STENCIL_ORDER;

    group.add(back, front);
    group.name = 'section-stencil';
    return group;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.group.visible = enabled;
    for (const stencil of this.stencilGroups) stencil.visible = enabled;
    for (const material of this.clippedMaterials) {
      material.clippingPlanes = enabled ? [this.plane] : null;
      material.needsUpdate = true;
    }
    this.update();
  }

  setAxis(axis: SectionAxis): void {
    this.axis = axis;
    this.update();
  }

  setPosition(position: number): void {
    this.position = THREE.MathUtils.clamp(position, 0, 1);
    this.update();
  }

  setFlipped(flipped: boolean): void {
    this.flipped = flipped;
    this.update();
  }

  setShowCap(show: boolean): void {
    this.capMesh.visible = show;
  }

  setHatch(hatch: boolean): void {
    this.capMaterial.uniforms.uHatchOn.value = hatch ? 1 : 0;
  }

  /** Current cut coordinate in model units, for the readout. */
  get coordinate(): number {
    const min = this.bounds.min[this.axis];
    const max = this.bounds.max[this.axis];
    return min + (max - min) * this.position;
  }

  private update(): void {
    const normal = AXIS_NORMALS[this.axis].clone();
    if (!this.flipped) normal.negate();

    const coordinate = this.coordinate;
    const point = new THREE.Vector3();
    point[this.axis] = coordinate;
    this.plane.setFromNormalAndCoplanarPoint(normal, point);

    // Orient the cap quad to the plane and nudge it a hair off the cut so it
    // never z-fights with the geometry it is capping.
    this.capMesh.position.copy(point).addScaledVector(normal, -1e-4);
    this.capMesh.lookAt(point.clone().add(normal));

    const centre = this.bounds.getCenter(new THREE.Vector3());
    for (const axis of ['x', 'y', 'z'] as const) {
      if (axis !== this.axis) this.capMesh.position[axis] = centre[axis];
    }
    this.capMesh.updateMatrixWorld();
  }

  clear(): void {
    for (const stencil of this.stencilGroups) {
      stencil.removeFromParent();
      for (const child of stencil.children) {
        const mesh = child as THREE.Mesh;
        for (const material of materialsOf(mesh)) material.dispose();
      }
    }
    this.stencilGroups.length = 0;
    for (const material of this.clippedMaterials) {
      material.clippingPlanes = null;
    }
    this.clippedMaterials.clear();
  }

  dispose(): void {
    this.clear();
    this.capMesh.geometry.dispose();
    this.capMaterial.dispose();
    this.group.removeFromParent();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }
}

function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}
