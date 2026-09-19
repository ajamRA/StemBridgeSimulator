import { describe, expect, it } from 'vitest';
import {
  BASE_RAIL_TARGET,
  DECK_POINTS,
  GRID,
  laneZ,
  MAX_HEIGHT,
  OUTER_LANES,
  SPAN,
} from './constants';
import {
  deckMagnetPositions,
  gridXValues,
  gridXYPoints,
  gridYValues,
  isGridVertex,
  nearestGridPoint,
  wallGridSegmentPairs,
  wallMagnetPositions,
} from './grid';
import { createGridNodes, softSnapToGrid } from './model';

describe('shared grid coordinates', () => {
  it('gridXValues / gridYValues match DECK_POINTS × (MAX_HEIGHT+1)', () => {
    const xs = gridXValues();
    const ys = gridYValues();
    expect(xs).toHaveLength(DECK_POINTS);
    expect(ys).toHaveLength(MAX_HEIGHT + 1);
    expect(xs[0]).toBe(0);
    expect(xs[xs.length - 1]).toBe(SPAN * GRID);
    expect(ys[0]).toBe(0);
    expect(ys[ys.length - 1]).toBe(MAX_HEIGHT * GRID);
    // Uniform spacing = GRID
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]! - xs[i - 1]!).toBe(GRID);
    }
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]! - ys[i - 1]!).toBe(GRID);
    }
  });

  it('createGridNodes XY equals gridXYPoints (no offset)', () => {
    const nodes = createGridNodes();
    const pts = gridXYPoints();
    expect(nodes).toHaveLength(pts.length);
    for (let i = 0; i < pts.length; i++) {
      expect(nodes[i]!.x).toBe(pts[i]!.x);
      expect(nodes[i]!.y).toBe(pts[i]!.y);
    }
  });

  it('every node has a wall magnet vertex on each outer wall z', () => {
    const nodes = createGridNodes();
    for (const lane of OUTER_LANES) {
      const magnets = wallMagnetPositions(lane);
      const z = laneZ(lane);
      const key = (x: number, y: number) => `${x},${y},${z}`;
      const set = new Set(magnets.map((m) => key(m.x, m.y)));
      for (const n of nodes) {
        expect(set.has(key(n.x, n.y))).toBe(true);
      }
    }
  });

  it('wall wireframe segment endpoints are only grid vertices', () => {
    for (const lane of OUTER_LANES) {
      const magnets = wallMagnetPositions(lane);
      const magSet = new Set(magnets.map((m) => `${m.x},${m.y},${m.z}`));
      const pairs = wallGridSegmentPairs(lane);
      expect(pairs.length % 2).toBe(0);
      for (const p of pairs) {
        expect(magSet.has(`${p.x},${p.y},${p.z}`)).toBe(true);
        expect(isGridVertex(p.x, p.y)).toBe(true);
      }
      // Every magnet is an endpoint of some segment (lies on a line)
      // Verticals cover all x at y extremes; horizontals cover all y at x extremes.
      // Interior magnets sit on both a vertical and a horizontal through them.
      for (const m of magnets) {
        const onVert = pairs.some(
          (p, i) =>
            i % 2 === 0 &&
            p.x === m.x &&
            pairs[i + 1]!.x === m.x &&
            m.y >= Math.min(p.y, pairs[i + 1]!.y) &&
            m.y <= Math.max(p.y, pairs[i + 1]!.y),
        );
        const onHoriz = pairs.some(
          (p, i) =>
            i % 2 === 0 &&
            p.y === m.y &&
            pairs[i + 1]!.y === m.y &&
            m.x >= Math.min(p.x, pairs[i + 1]!.x) &&
            m.x <= Math.max(p.x, pairs[i + 1]!.x),
        );
        expect(onVert || onHoriz).toBe(true);
      }
    }
  });

  it('deck magnets sit on laneZ with exact grid X and y=0', () => {
    const deck = deckMagnetPositions();
    expect(deck).toHaveLength(DECK_POINTS * BASE_RAIL_TARGET);
    for (const p of deck) {
      expect(p.y).toBe(0);
      expect(isGridVertex(p.x, p.y)).toBe(true);
      expect(p.z).toBe(laneZ(p.lane));
    }
  });

  it('softSnap / nearestGridPoint land on createGridNodes vertices', () => {
    const nodes = createGridNodes();
    const nodeSet = new Set(nodes.map((n) => `${n.x},${n.y}`));
    // Near a known vertex
    const hit = softSnapToGrid(2.1, 1.05);
    expect(nodeSet.has(`${hit.x},${hit.y}`)).toBe(true);
    expect(nearestGridPoint(2.1, 1.05, 0.35)).toEqual({ x: 2, y: 1 });
    // Far from grid — softSnap clamps but may leave non-vertex; nearest returns null
    expect(nearestGridPoint(2.5, 1.5, 0.2)).toBeNull();
  });
});
