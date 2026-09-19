import { describe, expect, it } from 'vitest';
import {
  addArchMember,
  createGridNodes,
  findNodeAt,
  isAllowedMember,
  isAllowedMemberForLength,
  resetMemberIds,
} from './model';
import type { MemberDef, NodeDef } from './types';

describe('isAllowedMemberForLength', () => {
  const nodes = createGridNodes();

  function ids(x1: number, y1: number, x2: number, y2: number) {
    const a = findNodeAt(nodes, x1, y1)!;
    const b = findNodeAt(nodes, x2, y2)!;
    return [a.id, b.id] as const;
  }

  it('Pendek (1): only 1-ortho and 1×1 diagonal', () => {
    const [a, b] = ids(0, 0, 1, 0);
    expect(isAllowedMemberForLength(nodes, a, b, 1)).toBe(true);

    const [c, d] = ids(0, 0, 1, 1);
    expect(isAllowedMemberForLength(nodes, c, d, 1)).toBe(true);

    const [e, f] = ids(0, 0, 2, 0);
    expect(isAllowedMemberForLength(nodes, e, f, 1)).toBe(false);

    const [g, h] = ids(0, 0, 2, 1);
    expect(isAllowedMember(nodes, g, h)).toBe(true);
    expect(isAllowedMemberForLength(nodes, g, h, 1)).toBe(false);
  });

  it('Sederhana (2): 2-ortho and diagonals with max leg 2', () => {
    const [a, b] = ids(0, 0, 2, 0);
    expect(isAllowedMemberForLength(nodes, a, b, 2)).toBe(true);

    const [c, d] = ids(0, 0, 2, 2);
    expect(isAllowedMemberForLength(nodes, c, d, 2)).toBe(true);

    const [e, f] = ids(0, 0, 2, 1);
    expect(isAllowedMemberForLength(nodes, e, f, 2)).toBe(true);

    const [g, h] = ids(0, 0, 1, 1);
    expect(isAllowedMemberForLength(nodes, g, h, 2)).toBe(false);

    const [i, j] = ids(0, 0, 3, 0);
    expect(isAllowedMemberForLength(nodes, i, j, 2)).toBe(false);
  });

  it('Panjang (3): 3-ortho and diagonals with max leg 3', () => {
    const [a, b] = ids(0, 0, 3, 0);
    expect(isAllowedMemberForLength(nodes, a, b, 3)).toBe(true);

    const [c, d] = ids(0, 0, 3, 2);
    expect(isAllowedMemberForLength(nodes, c, d, 3)).toBe(true);

    const [e, f] = ids(0, 0, 2, 2);
    expect(isAllowedMemberForLength(nodes, e, f, 3)).toBe(false);
  });

  it('Auto allows any currently allowed member', () => {
    const [a, b] = ids(0, 0, 1, 0);
    expect(isAllowedMemberForLength(nodes, a, b, 'auto')).toBe(true);
    const [c, d] = ids(0, 0, 3, 3);
    expect(isAllowedMemberForLength(nodes, c, d, 'auto')).toBe(true);
    const [e, f] = ids(0, 0, 4, 0);
    expect(isAllowedMember(nodes, e, f)).toBe(false);
    expect(isAllowedMemberForLength(nodes, e, f, 'auto')).toBe(false);
  });
});

describe('addArchMember (Lengkung)', () => {
  it('inserts upward apex + two axial legs for a chord', () => {
    resetMemberIds();
    const nodes = createGridNodes();
    const apexes: NodeDef[] = [];
    const members: MemberDef[] = [];
    const a = findNodeAt(nodes, 0, 0)!;
    const b = findNodeAt(nodes, 3, 0)!;

    const placed = addArchMember(nodes, apexes, members, a.id, b.id);
    expect(placed).not.toBeNull();
    expect(apexes).toHaveLength(1);
    expect(members).toHaveLength(2);
    expect(apexes[0]!.isApex).toBe(true);
    expect(apexes[0]!.y).toBeGreaterThan(0);
    expect(apexes[0]!.x).toBeCloseTo(1.5, 5);
    expect(members.every((m) => m.shape === 'lengkung')).toBe(true);
    expect(members[0]!.archGroupId).toBe(members[1]!.archGroupId);
  });
});
