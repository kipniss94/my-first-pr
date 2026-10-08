// three.js ships meshoptimizer's simplifier without type declarations; this is
// the part of it the STEP export uses.
declare module 'three/examples/jsm/libs/meshopt_simplifier.module.js' {
  export const MeshoptSimplifier: {
    ready: Promise<void>;
    supported: boolean;
    /**
     * Fewer triangles over the same vertices. Stops at `targetIndexCount` or
     * when the next collapse would move the surface more than `targetError`
     * (relative to the mesh's extent unless ErrorAbsolute is given).
     * Returns the new indices and the error reached.
     */
    simplify(
      indices: Uint32Array,
      positions: Float32Array,
      stride: number,
      targetIndexCount: number,
      targetError: number,
      flags?: Array<'LockBorder' | 'Sparse' | 'ErrorAbsolute' | 'Prune' | 'Regularize'>,
    ): [Uint32Array, number];
  };
}
