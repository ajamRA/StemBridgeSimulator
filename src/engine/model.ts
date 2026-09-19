import { SPAN, MAX_HEIGHT, ALLOWED_LENGTHS, GRID } from './constants';
import type { MemberDef, NodeDef, SupportType, Vec2 } from './types';

let nextMemberId = 1;
const APEX_ID_START = 1000;
let nextApexNodeId = APEX_ID_START;
let nextArchGroupId = 1;

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

export function addMember(
  members: MemberDef[],
  n1: number,
  n2: number,
  extra?: Partial<Pick<MemberDef, 'shape' | 'archGroupId' | 'archChord' | 'visualOnly'>>,
): MemberDef | null {
  if (hasMember(members, n1, n2)) return null;
  const m: MemberDef = { id: nextMemberId++, n1, n2, ...extra };
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
  nextApexNodeId = APEX_ID_START;
  nextArchGroupId = 1;
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

/** Stick length preset: fixed 1–3 grid units, or auto (any allowed). */
export type StickLengthPreset = 1 | 2 | 3 | 'auto';

/**
 * Classroom length filter on top of {@link isAllowedMember}.
 *
 * - Ortho: grid span must equal selected L (e.g. Pendek → only 1-unit bars).
 * - Diagonal: max(|Δx|,|Δy|) in grid units must equal L (legs already 1..3 via isAllowedMember).
 * - Auto: any currently allowed member.
 */
export function isAllowedMemberForLength(
  nodes: NodeDef[],
  n1: number,
  n2: number,
  selectedL: StickLengthPreset,
): boolean {
  if (!isAllowedMember(nodes, n1, n2)) return false;
  if (selectedL === 'auto') return true;

  const a = findNodeById(nodes, n1);
  const b = findNodeById(nodes, n2);
  if (!a || !b) return false;

  const gx = Math.abs(b.x - a.x) / GRID;
  const gy = Math.abs(b.y - a.y) / GRID;

  // Axis-aligned: exact length L
  if (gx === 0 || gy === 0) {
    return Math.max(gx, gy) === selectedL;
  }

  // Diagonal: longer leg equals selected L (e.g. L=2 → 2×1, 2×2; not 1×1)
  return Math.max(gx, gy) === selectedL;
}


/** Chord already has a Lengkung arch between these endpoints. */
export function hasArchBetween(members: MemberDef[], n1: number, n2: number): boolean {
  return members.some((m) => {
    if (!m.archChord) return false;
    const [a, b] = m.archChord;
    return (a === n1 && b === n2) || (a === n2 && b === n1);
  });
}

/**
 * Apex of a Lengkung stick: midpoint offset opposite gravity (~0.5–1 grid).
 * Perpendicular in the +Y hemisphere so arches bulge upward.
 */
export function archApexPosition(a: NodeDef, b: NodeDef): Vec2 {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { x: mx, y: my + GRID };

  const rise = Math.min(GRID, Math.max(0.5 * GRID, len * 0.35));
  let px = -dy / len;
  let py = dx / len;
  if (py < 0) {
    px = -px;
    py = -py;
  }
  // Nearly horizontal chord → pure +Y rise (clearest classroom arch)
  if (Math.abs(dy) < 1e-9 || py < 0.25) {
    return { x: mx, y: my + rise };
  }
  return { x: mx + px * rise, y: my + py * rise };
}

export function createApexNode(a: NodeDef, b: NodeDef): NodeDef {
  const p = archApexPosition(a, b);
  return {
    id: nextApexNodeId++,
    x: p.x,
    y: p.y,
    support: 'none',
    isDeck: false,
    isApex: true,
  };
}

export interface ArchPlacement {
  apex: NodeDef;
  leg1: MemberDef;
  leg2: MemberDef;
  archGroupId: number;
}

/**
 * Place a Lengkung stick: intermediate apex + two axial legs.
 * Chord span (n1–n2) must already pass length validation; legs are free-length.
 */
export function addArchMember(
  nodes: NodeDef[],
  apexNodes: NodeDef[],
  members: MemberDef[],
  n1: number,
  n2: number,
): ArchPlacement | null {
  if (n1 === n2) return null;
  if (hasArchBetween(members, n1, n2) || hasMember(members, n1, n2)) return null;
  const a = findNodeById([...nodes, ...apexNodes], n1);
  const b = findNodeById([...nodes, ...apexNodes], n2);
  if (!a || !b) return null;

  const apex = createApexNode(a, b);
  apexNodes.push(apex);
  const gid = nextArchGroupId++;
  const chord: [number, number] = [n1, n2];
  const leg1 = addMember(members, n1, apex.id, {
    shape: 'lengkung',
    archGroupId: gid,
    archChord: chord,
  });
  const leg2 = addMember(members, apex.id, n2, {
    shape: 'lengkung',
    archGroupId: gid,
    archChord: chord,
  });
  if (!leg1 || !leg2) {
    // rollback
    if (leg1) removeMemberById(members, leg1.id);
    if (leg2) removeMemberById(members, leg2.id);
    const i = apexNodes.findIndex((n) => n.id === apex.id);
    if (i >= 0) apexNodes.splice(i, 1);
    return null;
  }
  return { apex, leg1, leg2, archGroupId: gid };
}

/** Remove a member; if it is part of a Lengkung arch, remove the whole group + orphan apex. */
export function removeMemberOrArch(
  members: MemberDef[],
  apexNodes: NodeDef[],
  id: number,
): MemberDef[] {
  const target = members.find((m) => m.id === id);
  if (!target) return [];
  const removed: MemberDef[] = [];
  if (target.archGroupId != null) {
    const gid = target.archGroupId;
    const group = members.filter((m) => m.archGroupId === gid);
    for (const m of group) {
      removeMemberById(members, m.id);
      removed.push(m);
    }
  } else {
    const m = removeMemberById(members, id);
    if (m) removed.push(m);
  }
  pruneOrphanApexes(members, apexNodes);
  return removed;
}

export function pruneOrphanApexes(members: MemberDef[], apexNodes: NodeDef[]): void {
  const used = new Set<number>();
  for (const m of members) {
    used.add(m.n1);
    used.add(m.n2);
  }
  for (let i = apexNodes.length - 1; i >= 0; i--) {
    const n = apexNodes[i]!;
    if (!used.has(n.id)) apexNodes.splice(i, 1);
  }
}

export function cloneApexNodes(apexes: NodeDef[]): NodeDef[] {
  return apexes.map((n) => ({ ...n }));
}

export function allNodes(grid: NodeDef[], apexes: NodeDef[]): NodeDef[] {
  return apexes.length ? [...grid, ...apexes] : grid;
}

/** Pickable build nodes only (exclude Lengkung apexes). */
export function pickableNodes(nodes: NodeDef[]): NodeDef[] {
  return nodes.filter((n) => !n.isApex);
}
