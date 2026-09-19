import {
  BASE_RAIL_TARGET,
  GRID,
  LENGTH_MAX,
  LENGTH_MIN,
  LENGTH_PENDEK_MAX,
  LENGTH_SEDERHANA_MAX,
  MAX_HEIGHT,
  SOFT_SNAP,
  SPAN,
} from './constants';
import type {
  MemberDef,
  NodeDef,
  StickLengthPreset,
  SupportType,
  Vec2,
} from './types';

let nextMemberId = 1;
const APEX_ID_START = 1000;
let nextApexNodeId = APEX_ID_START;
let nextArchGroupId = 1;
const FREE_ID_START = 500;
let nextFreeNodeId = FREE_ID_START;

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
  return nodes.find((n) => Math.abs(n.x - x) < 1e-9 && Math.abs(n.y - y) < 1e-9);
}

export function findNodeById(nodes: NodeDef[], id: number): NodeDef | undefined {
  return nodes.find((n) => n.id === id);
}

/** Mid-span deck node (default load point) */
export function defaultLoadNodeId(nodes: NodeDef[]): number {
  const midX = (SPAN * GRID) / 2;
  const n = nodes.find((nd) => nd.isDeck && Math.abs(nd.x - midX) < 1e-9 && !nd.isFree);
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
 * Freer classroom rule: any chord between two distinct nodes whose length is
 * in [LENGTH_MIN, LENGTH_MAX]. Angles are unrestricted (odd diagonals OK).
 * Soft snap happens at placement time — here we only check geometry.
 */
export function isAllowedMember(nodes: NodeDef[], n1: number, n2: number): boolean {
  if (n1 === n2) return false;
  const a = findNodeById(nodes, n1);
  const b = findNodeById(nodes, n2);
  if (!a || !b) return false;
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  return L >= LENGTH_MIN - 1e-9 && L <= LENGTH_MAX + 1e-9;
}

export function membersEqual(a: MemberDef, b: MemberDef): boolean {
  return (a.n1 === b.n1 && a.n2 === b.n2) || (a.n1 === b.n2 && a.n2 === b.n1);
}

/**
 * Structural duplicate check (same endpoints). Parallel base rails that share
 * endpoints but differ by zLane are allowed via {@link hasBaseLane}.
 */
export function hasMember(members: MemberDef[], n1: number, n2: number): boolean {
  return members.some(
    (m) =>
      m.role !== 'base' &&
      ((m.n1 === n1 && m.n2 === n2) || (m.n1 === n2 && m.n2 === n1)),
  );
}

export function hasBaseLane(members: MemberDef[], lane: number): boolean {
  return members.some((m) => m.role === 'base' && m.zLane === lane);
}

export function countBaseRails(members: MemberDef[]): number {
  return members.filter((m) => m.role === 'base').length;
}

/** Next free deck lane index, or null if all BASE_RAIL_TARGET lanes are filled. */
export function nextFreeBaseLane(members: MemberDef[]): number | null {
  for (let i = 0; i < BASE_RAIL_TARGET; i++) {
    if (!hasBaseLane(members, i)) return i;
  }
  return null;
}

export function addMember(
  members: MemberDef[],
  n1: number,
  n2: number,
  extra?: Partial<
    Pick<MemberDef, 'shape' | 'archGroupId' | 'archChord' | 'visualOnly' | 'role' | 'zLane'>
  >,
): MemberDef | null {
  if (extra?.role === 'base') {
    if (extra.zLane == null) return null;
    if (hasBaseLane(members, extra.zLane)) return null;
  } else if (hasMember(members, n1, n2)) {
    return null;
  }
  const m: MemberDef = { id: nextMemberId++, n1, n2, ...extra };
  members.push(m);
  return m;
}

/**
 * Drop one full-span base rail (lidi panjang) in the next free Z lane.
 * Left abutment deck node → right abutment deck node.
 *
 * Physics: only the first base rail enters the 2D DSM; extra lanes are
 * visualOnly (same XY would otherwise over-stiffen / duplicate the chord).
 * Documented in README — multi-rail deck physics is approximate.
 */
export function addBaseRail(
  nodes: NodeDef[],
  members: MemberDef[],
): { member: MemberDef; lane: number } | null {
  const lane = nextFreeBaseLane(members);
  if (lane == null) return null;

  const left = nodes.find((n) => n.isDeck && n.support === 'pin' && !n.isFree && !n.isApex);
  const right = nodes.find((n) => n.isDeck && n.support === 'roller' && !n.isFree && !n.isApex);
  if (!left || !right) return null;

  const alreadyStructural = members.some(
    (m) =>
      m.role === 'base' &&
      !m.visualOnly &&
      ((m.n1 === left.id && m.n2 === right.id) || (m.n1 === right.id && m.n2 === left.id)),
  );

  const m = addMember(members, left.id, right.id, {
    shape: 'lurus',
    role: 'base',
    zLane: lane,
    visualOnly: alreadyStructural, // first rail structural; rest visual parallel
  });
  if (!m) return null;
  return { member: m, lane };
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
  nextFreeNodeId = FREE_ID_START;
}

export function cloneMembers(members: MemberDef[]): MemberDef[] {
  return members.map((m) => ({ ...m }));
}

/**
 * Members that may enter the 2D axial DSM.
 *
 * Drops:
 * - visualOnly bars (extra parallel base rails, etc.)
 * - self-loops / zero XY length
 *
 * Multi-rail deck: only the first (structural) base chord is solved; extra
 * lanes are visual. Side truss braces / free nodes still contribute fully.
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

/**
 * Classroom length filter on top of {@link isAllowedMember}.
 *
 * - Pendek (1): short braces / verticals — L ≤ ~1.75
 * - Sederhana (2): medium — L ≤ ~3.6
 * - Panjang: long chords up to full SPAN (one placement across the gap)
 * - Auto: any length in [LENGTH_MIN, LENGTH_MAX]
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
  const L = Math.hypot(b.x - a.x, b.y - a.y);

  if (selectedL === 1) return L <= LENGTH_PENDEK_MAX + 1e-9;
  if (selectedL === 2) return L <= LENGTH_SEDERHANA_MAX + 1e-9;
  // panjang
  return L >= LENGTH_PENDEK_MAX - 0.25 && L <= LENGTH_MAX + 1e-9;
}

/** Soft-snap a world point onto the integer grid (light magnet). */
export function softSnapToGrid(x: number, y: number, radius = SOFT_SNAP): Vec2 {
  const gx = Math.round(x / GRID) * GRID;
  const gy = Math.round(y / GRID) * GRID;
  const clampedY = Math.max(0, Math.min(MAX_HEIGHT * GRID, gy));
  const clampedX = Math.max(0, Math.min(SPAN * GRID, gx));
  if (Math.hypot(x - clampedX, y - clampedY) <= radius) {
    return { x: clampedX, y: clampedY };
  }
  // No hard snap — still clamp into build volume softly
  return {
    x: Math.max(0, Math.min(SPAN * GRID, x)),
    y: Math.max(0, Math.min(MAX_HEIGHT * GRID, y)),
  };
}

/**
 * Find an existing pickable node near world, or create a free joint
 * (soft-snapped). Supports + apexes are never duplicated.
 */
export function findOrCreateNodeNear(
  gridNodes: NodeDef[],
  freeNodes: NodeDef[],
  apexNodes: NodeDef[],
  world: Vec2,
  pickRadius = SOFT_SNAP * 1.4,
): { node: NodeDef; created: boolean } {
  const all = [...gridNodes, ...freeNodes];
  let best: NodeDef | null = null;
  let bestD = pickRadius;
  for (const n of all) {
    if (n.isApex) continue;
    const d = Math.hypot(n.x - world.x, n.y - world.y);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  if (best) return { node: best, created: false };

  const snapped = softSnapToGrid(world.x, world.y);
  // Prefer merging onto grid if soft-snap landed on an existing grid node
  const onGrid = findNodeAt(gridNodes, snapped.x, snapped.y);
  if (onGrid && !onGrid.isApex) return { node: onGrid, created: false };
  const onFree = freeNodes.find(
    (n) => Math.abs(n.x - snapped.x) < 1e-6 && Math.abs(n.y - snapped.y) < 1e-6,
  );
  if (onFree) return { node: onFree, created: false };

  const node: NodeDef = {
    id: nextFreeNodeId++,
    x: snapped.x,
    y: snapped.y,
    support: 'none',
    isDeck: Math.abs(snapped.y) < 1e-6,
    isFree: true,
  };
  freeNodes.push(node);
  void apexNodes; // apexes stay separate
  return { node, created: true };
}

/** Remove free nodes that no longer participate in any member. */
export function pruneOrphanFreeNodes(members: MemberDef[], freeNodes: NodeDef[]): void {
  const used = new Set<number>();
  for (const m of members) {
    used.add(m.n1);
    used.add(m.n2);
  }
  for (let i = freeNodes.length - 1; i >= 0; i--) {
    const n = freeNodes[i]!;
    if (!used.has(n.id)) freeNodes.splice(i, 1);
  }
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
  promoteBaseRails(members);
  return removed;
}


/** Ensure at least one base rail is structural if any remain (for DSM). */
export function promoteBaseRails(members: MemberDef[]): void {
  const bases = members.filter((m) => m.role === 'base');
  if (!bases.length) return;
  if (bases.some((m) => !m.visualOnly)) return;
  // Promote the lowest lane to structural
  bases.sort((a, b) => (a.zLane ?? 0) - (b.zLane ?? 0));
  bases[0]!.visualOnly = false;
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

export function cloneFreeNodes(free: NodeDef[]): NodeDef[] {
  return free.map((n) => ({ ...n }));
}

export function allNodes(grid: NodeDef[], apexes: NodeDef[], free: NodeDef[] = []): NodeDef[] {
  return [...grid, ...free, ...apexes];
}

/** Pickable build nodes only (exclude Lengkung apexes). */
export function pickableNodes(nodes: NodeDef[]): NodeDef[] {
  return nodes.filter((n) => !n.isApex);
}

export type { StickLengthPreset };
