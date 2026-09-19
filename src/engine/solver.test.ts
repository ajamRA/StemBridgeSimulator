import { describe, expect, it } from 'vitest';
import { AREA, E, SPAN } from './constants';
import { createGridNodes, findNodeAt } from './model';
import { solveTruss } from './solver';
import type { MemberDef, Vec2 } from './types';

/**
 * Classic two-bar symmetric truss with two pins:
 *   Pins at (0,0) and (2,0), apex at (1,1)
 *   Vertical load P downward at apex.
 * Analytical: each bar force = −P / (2 sinθ) = −P/√2 (compression), θ=45°.
 */
describe('DSM truss sanity', () => {
  it('matches analytical two-bar truss', () => {
    const nodes = [
      { id: 0, x: 0, y: 0, support: 'pin' as const, isDeck: true },
      { id: 1, x: 2, y: 0, support: 'pin' as const, isDeck: true },
      { id: 2, x: 1, y: 1, support: 'none' as const, isDeck: false },
    ];
    const members: MemberDef[] = [
      { id: 1, n1: 0, n2: 2 },
      { id: 2, n1: 1, n2: 2 },
    ];
    const P = 10;
    const loads = new Map<number, Vec2>([[2, { x: 0, y: -P }]]);
    const result = solveTruss(nodes, members, loads);

    expect(result.ok).toBe(true);
    expect(result.singular).toBe(false);
    expect(result.members).toHaveLength(2);

    // A-frame (apex above supports) → compression under downward load
    const analytical = -P / Math.SQRT2;
    for (const m of result.members) {
      expect(m.force).toBeLessThan(0);
      expect(Math.abs(m.force - analytical)).toBeLessThan(1e-6);
    }

    const u = result.displacements.get(2)!;
    expect(u.y).toBeLessThan(0);

    // Axial shortening δ = F L / (AE); L=√2 (F negative)
    const L = Math.SQRT2;
    const delta = (analytical * L) / (AREA * E);
    // Vertical deflection: each bar shortens; uy ≈ δ / sinθ = δ√2
    const expectedUy = delta * Math.SQRT2; // delta<0 → uy<0
    expect(Math.abs(u.y - expectedUy)).toBeLessThan(1e-6);
  });

  it('detects unstable mechanism (colinear bars on pin-roller)', () => {
    const nodes = [
      { id: 0, x: 0, y: 0, support: 'pin' as const, isDeck: true },
      { id: 1, x: 1, y: 0, support: 'none' as const, isDeck: true },
      { id: 2, x: 2, y: 0, support: 'roller' as const, isDeck: true },
    ];
    const members: MemberDef[] = [
      { id: 1, n1: 0, n2: 1 },
      { id: 2, n1: 1, n2: 2 },
    ];
    const loads = new Map<number, Vec2>([[1, { x: 0, y: -5 }]]);
    const result = solveTruss(nodes, members, loads);
    expect(result.singular || !result.ok).toBe(true);
  });

  it('stable triangle on pin-roller span', () => {
    const nodes = [
      { id: 0, x: 0, y: 0, support: 'pin' as const, isDeck: true },
      { id: 1, x: 2, y: 0, support: 'roller' as const, isDeck: true },
      { id: 2, x: 1, y: 1, support: 'none' as const, isDeck: false },
    ];
    const members: MemberDef[] = [
      { id: 1, n1: 0, n2: 1 },
      { id: 2, n1: 0, n2: 2 },
      { id: 3, n1: 1, n2: 2 },
    ];
    const loads = new Map<number, Vec2>([[2, { x: 0, y: -10 }]]);
    const result = solveTruss(nodes, members, loads);
    expect(result.ok).toBe(true);
    expect(result.singular).toBe(false);
    expect(result.members.every((m) => Number.isFinite(m.force))).toBe(true);
  });

  it('builds default grid with pin and roller', () => {
    const nodes = createGridNodes();
    const left = findNodeAt(nodes, 0, 0);
    const right = findNodeAt(nodes, SPAN, 0);
    expect(left?.support).toBe('pin');
    expect(right?.support).toBe('roller');
  });
});

describe('playable span bridge', () => {
  it('solves a simple triangular deck bridge on default grid', () => {
    const nodes = createGridNodes();
    // Deck chord 0-5-10 + apex at (5,2) with diagonals — minimal stable
    const find = (x: number, y: number) => {
      const n = findNodeAt(nodes, x, y);
      if (!n) throw new Error(`missing ${x},${y}`);
      return n.id;
    };
    const members: MemberDef[] = [
      { id: 1, n1: find(0, 0), n2: find(5, 0) },
      { id: 2, n1: find(5, 0), n2: find(10, 0) },
      { id: 3, n1: find(0, 0), n2: find(5, 2) },
      { id: 4, n1: find(10, 0), n2: find(5, 2) },
      { id: 5, n1: find(5, 0), n2: find(5, 2) },
    ];
    const mid = find(5, 0);
    const loads = new Map<number, Vec2>([[mid, { x: 0, y: -20 }]]);
    const result = solveTruss(nodes, members, loads);
    expect(result.ok).toBe(true);
    expect(result.singular).toBe(false);
    expect(result.maxUtilization).toBeGreaterThan(0);
  });
});

describe('3D visual braces must not break 2D DSM', () => {
  it('solves a fully triangulated Pratt span on the default grid', () => {
    const nodes = createGridNodes();
    const find = (x: number, y: number) => {
      const n = findNodeAt(nodes, x, y);
      if (!n) throw new Error(`missing ${x},${y}`);
      return n.id;
    };
    const members: MemberDef[] = [];
    let id = 1;
    const add = (x1: number, y1: number, x2: number, y2: number) => {
      members.push({ id: id++, n1: find(x1, y1), n2: find(x2, y2) });
    };
    for (let x = 0; x < 10; x++) add(x, 0, x + 1, 0);
    for (let x = 0; x < 10; x++) add(x, 2, x + 1, 2);
    for (let x = 0; x <= 10; x++) add(x, 0, x, 2);
    for (let x = 0; x < 10; x++) {
      if (x % 2 === 0) add(x, 0, x + 1, 2);
      else add(x, 2, x + 1, 0);
    }
    const loads = new Map<number, Vec2>([[find(5, 0), { x: 0, y: -8 }]]);
    const result = solveTruss(nodes, members, loads);
    expect(result.ok).toBe(true);
    expect(result.singular).toBe(false);
    expect(result.members.length).toBe(members.length);
    expect(result.maxUtilization).toBeGreaterThan(0);
  });

  it('ignores visual-only / zero-length pollution (fake Z-braces)', () => {
    const nodes = createGridNodes();
    const find = (x: number, y: number) => findNodeAt(nodes, x, y)!.id;
    // Minimal stable deck bridge (same topology as playable span test)
    const good: MemberDef[] = [
      { id: 1, n1: find(0, 0), n2: find(5, 0) },
      { id: 2, n1: find(5, 0), n2: find(10, 0) },
      { id: 3, n1: find(0, 0), n2: find(5, 2) },
      { id: 4, n1: find(10, 0), n2: find(5, 2) },
      { id: 5, n1: find(5, 0), n2: find(5, 2) },
    ];
    // Simulate mistaken Near↔Far Z brace stored as XY member: self-loop,
    // visualOnly flag, or both — must not enter active DOFs or force recovery
    const polluted: MemberDef[] = [
      ...good,
      { id: 90, n1: find(5, 2), n2: find(5, 2), visualOnly: true },
      { id: 91, n1: find(0, 0), n2: find(0, 0) },
      { id: 92, n1: find(5, 0), n2: find(5, 0), visualOnly: true },
    ];
    const loads = new Map<number, Vec2>([[find(5, 0), { x: 0, y: -20 }]]);
    const clean = solveTruss(nodes, good, loads);
    const dirty = solveTruss(nodes, polluted, loads);
    expect(clean.ok).toBe(true);
    expect(dirty.ok).toBe(true);
    expect(dirty.singular).toBe(false);
    expect(dirty.members.find((m) => m.id === 90)).toBeUndefined();
    expect(dirty.members.find((m) => m.id === 91)).toBeUndefined();
    expect(dirty.members.find((m) => m.id === 92)).toBeUndefined();
    expect(dirty.members.length).toBe(good.length);
    expect(dirty.maxUtilization).toBeGreaterThan(0);
  });

  it('rectangle ladder without diagonals stays singular (demo failure mode)', () => {
    const nodes = createGridNodes();
    const find = (x: number, y: number) => findNodeAt(nodes, x, y)!.id;
    const members: MemberDef[] = [];
    let id = 1;
    const add = (x1: number, y1: number, x2: number, y2: number) => {
      members.push({ id: id++, n1: find(x1, y1), n2: find(x2, y2) });
    };
    for (let x = 0; x < 10; x++) add(x, 0, x + 1, 0);
    for (let x = 0; x < 10; x++) add(x, 2, x + 1, 2);
    for (let x = 0; x <= 10; x++) add(x, 0, x, 2);
    const loads = new Map<number, Vec2>([[find(5, 0), { x: 0, y: -8 }]]);
    const result = solveTruss(nodes, members, loads);
    expect(result.singular || !result.ok).toBe(true);
  });
});
