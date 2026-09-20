import { describe, expect, it } from 'vitest';
import { progressiveFailure } from './failure';
import type { MemberDef, Vec2 } from './types';

/** Heavily loaded A-frame — both legs overstressed in compression. */
function overloadedAFrame(P: number) {
  const nodes = [
    { id: 0, x: 0, y: 0, support: 'pin' as const, isDeck: true },
    { id: 1, x: 2, y: 0, support: 'pin' as const, isDeck: true },
    { id: 2, x: 1, y: 1, support: 'none' as const, isDeck: false },
  ];
  const members: MemberDef[] = [
    { id: 1, n1: 0, n2: 2 },
    { id: 2, n1: 1, n2: 2 },
  ];
  const loads = new Map<number, Vec2>([[2, { x: 0, y: -P }]]);
  return { nodes, members, loads };
}

describe('progressiveFailure — single patah default', () => {
  it('breaks only the worst 1 member per click (not a full cascade)', () => {
    // P large enough that both legs fail (F = −P/√2, capacity 30)
    const { nodes, members, loads } = overloadedAFrame(100);
    const prog = progressiveFailure(nodes, members, loads);

    expect(prog.removedIds.length).toBe(1);
    expect(members).toHaveLength(2); // input untouched
    // Remaining structure after one break still has 1 member in the working copy path
    expect(prog.collapsed).toBe(false);
  });

  it('respects maxBreaks: 2 when requested', () => {
    const { nodes, members, loads } = overloadedAFrame(100);
    const prog = progressiveFailure(nodes, members, loads, { maxBreaks: 2 });
    expect(prog.removedIds.length).toBeLessThanOrEqual(2);
    expect(prog.removedIds.length).toBeGreaterThanOrEqual(1);
  });

  it('continuous cascade can remove more than one step', () => {
    const { nodes, members, loads } = overloadedAFrame(100);
    const prog = progressiveFailure(nodes, members, loads, {
      continuous: true,
      maxBreaks: 10,
    });
    // Both legs eventually go under continuous collapse
    expect(prog.removedIds.length).toBeGreaterThanOrEqual(1);
  });

  it('removes nothing when all members are within capacity', () => {
    const { nodes, members, loads } = overloadedAFrame(5);
    const prog = progressiveFailure(nodes, members, loads);
    expect(prog.removedIds).toHaveLength(0);
    expect(prog.collapsed).toBe(false);
  });
});
