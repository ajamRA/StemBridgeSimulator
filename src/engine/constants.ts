/** Grid spacing in world units */
export const GRID = 1;

/** Bridge span in grid units (left support x=0, right support x=SPAN) */
export const SPAN = 10;

/** Number of vertical grid levels above deck (deck is y=0) */
export const MAX_HEIGHT = 3;

/**
 * Soft length bands for classroom stick presets (world units).
 * Panjang may reach the full span in ONE placement (like a real lidi).
 */
export const LENGTH_PENDEK_MAX = 1.75;
export const LENGTH_SEDERHANA_MAX = 3.6;
export const LENGTH_MIN = 0.45;
/** Max chord length = full span (abutment to abutment). */
export const LENGTH_MAX = SPAN;

/** @deprecated Prefer length bands; kept for tests that still mention discrete lengths. */
export const ALLOWED_LENGTHS = [1, 2, 3, SPAN] as const;

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
 * Half-width of the 3D truss envelope (near plane at +depth, far at −depth).
 * Physics remains 2D axial DSM on the primary (XY) plane; Z is visual / deck lanes.
 */
export const TRUSS_HALF_DEPTH = 1.05;

/** Classroom challenge: ~7 parallel long sticks as the deck base. */
export const BASE_RAIL_TARGET = 7;

/** Soft snap radius when placing free nodes (world units). */
export const SOFT_SNAP = 0.35;

/** Max distance to pick an existing node when connecting. */
export const NODE_PICK_RADIUS = 0.55;

/**
 * Z coordinate for deck lane index `lane` in 0 .. BASE_RAIL_TARGET-1.
 * Lane 0 = near edge, last = far edge.
 */
export function laneZ(lane: number, lanes = BASE_RAIL_TARGET): number {
  if (lanes <= 1) return 0;
  const t = lane / (lanes - 1);
  return TRUSS_HALF_DEPTH - 2 * TRUSS_HALF_DEPTH * t;
}
