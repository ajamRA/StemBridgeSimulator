import { SPAN, MAX_HEIGHT, ALLOWED_LENGTHS, GRID } from './constants';
import type { MemberDef, NodeDef, SupportType, Vec2 } from './types';

let nextMemberId = 1;

export function createGridNodes(): NodeDef[] {
  const nodes: NodeDef[] = [];
  let id = 0;
  for (let y = 0; y <= MAX_HEIGHT; y++) {
    for (let x = 0; x <= SPAN; x++) {
      let support: SupportType = 'none';
      if (y === 0 && x === 0) support = 'pin';
      if (y === 0 && x === SPAN) support = 'roller';
      nodes.push({
        id: id++,
        x: x * GRID,
        y: y * GRID,
        support,
        isDeck: y === 0,
      });
    }
  }
  return nodes;
}

export function nodeKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function findNodeAt(nodes: NodeDef[], x: number, y: number): NodeDef | undefined {
  return nodes.find((n) => n.x === x && n.y === y);
}

export function findNodeById(nodes: NodeDef[], id: number): NodeDef | undefined {
  return nodes.find((n) => n.id === id);
}

/** Mid-span deck node (default load point) */
export function defaultLoadNodeId(nodes: NodeDef[]): number {
  const midX = (SPAN * GRID) / 2;
  const n = nodes.find((nd) => nd.isDeck && nd.x === midX);
  return n?.id ?? nodes.find((nd) => nd.isDeck)?.id ?? 0;
}

export function memberLength(nodes: NodeDef[], m: MemberDef): number {
  const a = findNodeById(nodes, m.n1)!;
  const b = findNodeById(nodes, m.n2)!;
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function memberDirection(nodes: NodeDef[], m: MemberDef): Vec2 {
  const a = findNodeById(nodes, m.n1)!;
  const b = findNodeById(nodes, m.n2)!;
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  if (L < 1e-12) return { x: 0, y: 0 };
  return { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
}

/**
 * Allowed if both ends on grid and length is 1–3 axis-aligned,
 * or a diagonal with both Δx,Δy integers in 1..3 and hypotenuse matching grid.
 */
export function isAllowedMember(nodes: NodeDef[], n1: number, n2: number): boolean {
  if (n1 === n2) return false;
  const a = findNodeById(nodes, n1);
  const b = findNodeById(nodes, n2);
  if (!a || !b) return false;
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return false;

  // Axis-aligned: length in ALLOWED_LENGTHS
  if (dx === 0 || dy === 0) {
    return (ALLOWED_LENGTHS as readonly number[]).includes(L);
  }

  // Diagonal: both ends on integer grid, each leg 1..3
  const gx = dx / GRID;
  const gy = dy / GRID;
  if (!Number.isInteger(gx) || !Number.isInteger(gy)) return false;
  if (gx < 1 || gx > 3 || gy < 1 || gy > 3) return false;
  return true;
}

export function membersEqual(a: MemberDef, b: MemberDef): boolean {
  return (a.n1 === b.n1 && a.n2 === b.n2) || (a.n1 === b.n2 && a.n2 === b.n1);
}

export function hasMember(members: MemberDef[], n1: number, n2: number): boolean {
  return members.some(
    (m) => (m.n1 === n1 && m.n2 === n2) || (m.n1 === n2 && m.n2 === n1),
  );
}

export function addMember(members: MemberDef[], n1: number, n2: number): MemberDef | null {
  if (hasMember(members, n1, n2)) return null;
  const m: MemberDef = { id: nextMemberId++, n1, n2 };
  members.push(m);
  return m;
}

export function removeMemberById(members: MemberDef[], id: number): MemberDef | null {
  const i = members.findIndex((m) => m.id === id);
  if (i < 0) return null;
  const [m] = members.splice(i, 1);
  return m ?? null;
}

export function findMemberNearPoint(
  nodes: NodeDef[],
  members: MemberDef[],
  px: number,
  py: number,
  threshold: number,
): MemberDef | null {
  let best: MemberDef | null = null;
  let bestD = threshold;
  for (const m of members) {
    const a = findNodeById(nodes, m.n1)!;
    const b = findNodeById(nodes, m.n2)!;
    const d = distToSegment(px, py, a.x, a.y, b.x, b.y);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return best;
}

function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function resetMemberIds(): void {
  nextMemberId = 1;
}

export function cloneMembers(members: MemberDef[]): MemberDef[] {
  return members.map((m) => ({ ...m }));
}

/**
 * Members that may enter the 2D axial DSM.
 *
 * Drops:
 * - visualOnly bars (must stay out of the planar truss)
 * - self-loops / zero XY length (e.g. a Near↔Far Z brace wrongly stored as an
 *   XY member between coincident nodes — those make K singular / NaN)
 *
 * Near/far auto-mirror and transverse deck braces belong in BridgeScene only.
 */
export function membersForSolver(nodes: NodeDef[], members: MemberDef[]): MemberDef[] {
  return members.filter((m) => {
    if (m.visualOnly) return false;
    if (m.n1 === m.n2) return false;
    const a = findNodeById(nodes, m.n1);
    const b = findNodeById(nodes, m.n2);
    if (!a || !b) return false;
    return Math.hypot(b.x - a.x, b.y - a.y) >= 1e-12;
  });
}
