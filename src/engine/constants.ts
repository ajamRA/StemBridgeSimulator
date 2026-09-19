/** Grid spacing in world units */
export const GRID = 1;

/** Bridge span in grid units (left support x=0, right support x=SPAN) */
export const SPAN = 10;

/** Number of vertical grid levels above deck (deck is y=0) */
export const MAX_HEIGHT = 3;

/** Allowed member length in grid units (axis-aligned) */
export const ALLOWED_LENGTHS = [1, 2, 3] as const;

/** Cross-section area A (relative units) */
export const AREA = 1.0;

/** Young's modulus E (relative units) — keeps displacements readable */
export const E = 2000;

/**
 * Axial capacities (force units, same as load F).
 * Compression is lower to reflect buckling of slender stick members.
 */
export const TENSION_CAPACITY = 50;
export const COMPRESSION_CAPACITY = 30;

/** Default vertical load magnitude (downward positive in UI; applied as -Fy in solver) */
export const DEFAULT_LOAD = 20;

/** Softening / numerical tolerance for singularity */
export const SINGULARITY_EPS = 1e-10;

/**
 * Half-width of the 3D truss (near plane at +TRUSS_HALF_DEPTH, far at −TRUSS_HALF_DEPTH).
 * Physics remains 2D axial DSM on the primary (XY) plane; Z is visual only.
 */
export const TRUSS_HALF_DEPTH = 0.85;
