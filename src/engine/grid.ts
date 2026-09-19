/**
 * Single source of truth for snap / visual grid coordinates.
 * ALL visual grids (deck magnets, wall wireframes, height magnets) and
 * soft-snap targets MUST use these helpers — same as createGridNodes().
 */
import {
  BASE_RAIL_TARGET,
  DECK_POINTS,
  GRID,
  isOuterLane,
  laneZ,
  MAX_HEIGHT,
  SPAN,
} from './constants';
import type { Vec2 } from './types';

/** X coordinates of deck / wall columns: 0, GRID, …, SPAN (= DECK_POINTS points). */
export function gridXValues(): number[] {
  const xs: number[] = [];
  for (let i = 0; i < DECK_POINTS; i++) xs.push(i * GRID);
  return xs;
}

/** Y coordinates of height rows: 0, GRID, …, MAX_HEIGHT * GRID. */
export function gridYValues(): number[] {
  const ys: number[] = [];
  for (let i = 0; i <= MAX_HEIGHT; i++) ys.push(i * GRID);
  return ys;
}

/** Every XY snap point matching createGridNodes() (row-major: y outer, x inner). */
export function gridXYPoints(): Vec2[] {
  const pts: Vec2[] = [];
  for (const y of gridYValues()) {
    for (const x of gridXValues()) {
      pts.push({ x, y });
    }
  }
  return pts;
}

/** World XYZ of every deck magnet (12 × 7 lanes), y exactly 0. */
export function deckMagnetPositions(): { x: number; y: number; z: number; lane: number }[] {
  const out: { x: number; y: number; z: number; lane: number }[] = [];
  for (const x of gridXValues()) {
    for (let lane = 0; lane < BASE_RAIL_TARGET; lane++) {
      out.push({ x, y: 0, z: laneZ(lane), lane });
    }
  }
  return out;
}

/**
 * World XYZ of wall height magnets on outer walls.
 * Includes deck row y=0 so every createGridNodes() point has a vertex on the wall.
 */
export function wallMagnetPositions(
  lane: number,
): { x: number; y: number; z: number }[] {
  const z = laneZ(lane);
  const out: { x: number; y: number; z: number }[] = [];
  for (const y of gridYValues()) {
    for (const x of gridXValues()) {
      out.push({ x, y, z });
    }
  }
  return out;
}

/**
 * Line-segment endpoint pairs for a wall plane (LineSegments-ready).
 * Verticals at every grid X from y=0..MAX_HEIGHT; horizontals at every grid Y
 * from x=0..SPAN. Vertices === wallMagnetPositions(lane).
 */
export function wallGridSegmentPairs(
  lane: number,
): { x: number; y: number; z: number }[] {
  const z = laneZ(lane);
  const xs = gridXValues();
  const ys = gridYValues();
  const pairs: { x: number; y: number; z: number }[] = [];
  const y0 = ys[0]!;
  const y1 = ys[ys.length - 1]!;
  const x0 = xs[0]!;
  const x1 = xs[xs.length - 1]!;
  for (const x of xs) {
    pairs.push({ x, y: y0, z }, { x, y: y1, z });
  }
  for (const y of ys) {
    pairs.push({ x: x0, y, z }, { x: x1, y, z });
  }
  return pairs;
}

/** Longitudinal deck lane guide endpoints (one segment per lane). */
export function deckLaneSegmentPairs(): {
  road: { x: number; y: number; z: number }[];
  wall: { x: number; y: number; z: number }[];
} {
  const road: { x: number; y: number; z: number }[] = [];
  const wall: { x: number; y: number; z: number }[] = [];
  const x0 = 0;
  const x1 = SPAN * GRID;
  for (let lane = 0; lane < BASE_RAIL_TARGET; lane++) {
    const z = laneZ(lane);
    const pair = [
      { x: x0, y: 0, z },
      { x: x1, y: 0, z },
    ];
    if (isOuterLane(lane)) wall.push(...pair);
    else road.push(...pair);
  }
  return { road, wall };
}

/** Nearest grid XY (exact createGridNodes coordinate), or null if outside radius. */
export function nearestGridPoint(
  x: number,
  y: number,
  radius: number,
): Vec2 | null {
  const gx = Math.round(x / GRID) * GRID;
  const gy = Math.round(y / GRID) * GRID;
  const clampedX = Math.max(0, Math.min(SPAN * GRID, gx));
  const clampedY = Math.max(0, Math.min(MAX_HEIGHT * GRID, gy));
  // Must land on a real grid vertex (integer multiples already — just bounds)
  if (Math.hypot(x - clampedX, y - clampedY) <= radius) {
    return { x: clampedX, y: clampedY };
  }
  return null;
}

/** True iff (x,y) is exactly a createGridNodes() coordinate. */
export function isGridVertex(x: number, y: number, eps = 1e-9): boolean {
  if (x < -eps || y < -eps) return false;
  if (x > SPAN * GRID + eps || y > MAX_HEIGHT * GRID + eps) return false;
  const onX = Math.abs(x / GRID - Math.round(x / GRID)) < eps;
  const onY = Math.abs(y / GRID - Math.round(y / GRID)) < eps;
  return onX && onY;
}
