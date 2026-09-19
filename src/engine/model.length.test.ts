import { describe, expect, it } from 'vitest';
import { SPAN } from './constants';
import {
  addArchMember,
  addBaseRail,
  countBaseRails,
  createGridNodes,
  findNodeAt,
  isAllowedMember,
  isAllowedMemberForLength,
  nextFreeBaseLane,
  resetMemberIds,
} from './model';
import type { MemberDef, NodeDef } from './types';

describe('isAllowedMember (freer angles / lengths)', () => {
  const nodes = createGridNodes();

  function ids(x1: number, y1: number, x2: number, y2: number) {
    const a = findNodeAt(nodes, x1, y1)!;
    const b = findNodeAt(nodes, x2, y2)!;
    return [a.id, b.id] as const;
  }

  it('allows odd diagonals and full-span chords', () => {
    const [a, b] = ids(0, 0, 4, 1);
    expect(isAllowedMember(nodes, a, b)).toBe(true);

    const [c, d] = ids(0, 0, SPAN, 0);
    expect(isAllowedMember(nodes, c, d)).toBe(true);

    const [e, f] = ids(0, 0, 5, 2);
    expect(isAllowedMember(nodes, e, f)).toBe(true);
  });

  it('rejects zero-length / identical ends', () => {
    const [a, b] = ids(0, 0, 0, 0);
    expect(isAllowedMember(nodes, a, b)).toBe(false);
  });
});

describe('isAllowedMemberForLength', () => {
  const nodes = createGridNodes();

  function ids(x1: number, y1: number, x2: number, y2: number) {
    const a = findNodeAt(nodes, x1, y1)!;
    const b = findNodeAt(nodes, x2, y2)!;
    return [a.id, b.id] as const;
  }

  it('Pendek (1): short braces only', () => {
    const [a, b] = ids(0, 0, 1, 0);
    expect(isAllowedMemberForLength(nodes, a, b, 1)).toBe(true);

    const [c, d] = ids(0, 0, 1, 1);
    expect(isAllowedMemberForLength(nodes, c, d, 1)).toBe(true);

    const [e, f] = ids(0, 0, 2, 0);
    expect(isAllowedMemberForLength(nodes, e, f, 1)).toBe(false);

    const [g, h] = ids(0, 0, SPAN, 0);
    expect(isAllowedMemberForLength(nodes, g, h, 1)).toBe(false);
  });

  it('Sederhana (2): medium lengths', () => {
    const [a, b] = ids(0, 0, 2, 0);
    expect(isAllowedMemberForLength(nodes, a, b, 2)).toBe(true);

    const [c, d] = ids(0, 0, 3, 0);
    expect(isAllowedMemberForLength(nodes, c, d, 2)).toBe(true);

    const [e, f] = ids(0, 0, SPAN, 0);
    expect(isAllowedMemberForLength(nodes, e, f, 2)).toBe(false);
  });

  it('Panjang: full-span and long chords', () => {
    const [a, b] = ids(0, 0, SPAN, 0);
    expect(isAllowedMemberForLength(nodes, a, b, 'panjang')).toBe(true);

    const [c, d] = ids(0, 0, 3, 0);
    expect(isAllowedMemberForLength(nodes, c, d, 'panjang')).toBe(true);

    const [e, f] = ids(0, 0, 1, 0);
    expect(isAllowedMemberForLength(nodes, e, f, 'panjang')).toBe(false);
  });

  it('Auto allows any length up to SPAN', () => {
    const [a, b] = ids(0, 0, 1, 0);
    expect(isAllowedMemberForLength(nodes, a, b, 'auto')).toBe(true);
    const [c, d] = ids(0, 0, 4, 1);
    expect(isAllowedMemberForLength(nodes, c, d, 'auto')).toBe(true);
    const [e, f] = ids(0, 0, SPAN, 0);
    expect(isAllowedMemberForLength(nodes, e, f, 'auto')).toBe(true);
  });
});

describe('addBaseRail (7 parallel panjang)', () => {
  it('places up to 7 full-span rails; first structural, rest visualOnly', () => {
    resetMemberIds();
    const nodes = createGridNodes();
    const members: MemberDef[] = [];

    expect(nextFreeBaseLane(members)).toBe(0);

    for (let i = 0; i < 7; i++) {
      const placed = addBaseRail(nodes, members);
      expect(placed).not.toBeNull();
      expect(placed!.lane).toBe(i);
    }
    expect(countBaseRails(members)).toBe(7);
    expect(addBaseRail(nodes, members)).toBeNull();
    expect(nextFreeBaseLane(members)).toBeNull();

    const structural = members.filter((m) => m.role === 'base' && !m.visualOnly);
    const visual = members.filter((m) => m.role === 'base' && m.visualOnly);
    expect(structural).toHaveLength(1);
    expect(visual).toHaveLength(6);
    expect(structural[0]!.n1).not.toBe(structural[0]!.n2);
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
