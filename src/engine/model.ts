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
import { gridXValues, gridYValues, nearestGridPoint } from './grid';
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
  // Same X/Y lists as visual grids / soft-snap (see engine/grid.ts).
  for (const y of gridYValues()) {
    for (const x of gridXValues()) {
      let support: SupportType = 'none';
      if (y === 0 && x === 0) support = 'pin';
      if (y === 0 && x === SPAN * GRID) support = 'roller';
      nodes.push({
        id: id++,
        x,
        y,
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

/** Mid-span deck node (default load point) — nearest grid x on deck. */
export function defaultLoadNodeId(nodes: NodeDef[]): number {
  const midX = Math.floor(SPAN / 2) * GRID;
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
export function hasMember(
  members: MemberDef[],
  n1: number,
  n2: number,
  zLane?: number,
): boolean {
  return members.some((m) => {
    if (m.role === 'base' || m.role === 'transverse') return false;
    const ends =
      (m.n1 === n1 && m.n2 === n2) || (m.n1 === n2 && m.n2 === n1);
    if (!ends) return false;
    // Same XY on a different outer wall is a parallel visual brace, not a duplicate.
    if (zLane != null && m.zLane != null) return m.zLane === zLane;
    return true;
  });
}

export function hasBaseLane(members: MemberDef[], lane: number): boolean {
  return members.some((m) => m.role === 'base' && m.zLane === lane);
}

/** True if a transverse (Merintang) brace already spans these XY endpoints across the given Z lanes. */
export function hasTransverse(
  members: MemberDef[],
  n1: number,
  n2: number,
  zFrom: number,
  zTo: number,
): boolean {
  const lanePair = (a: number, b: number) =>
    (a === zFrom && b === zTo) || (a === zTo && b === zFrom);
  return members.some((m) => {
    if (m.role !== 'transverse') return false;
    const ends =
      (m.n1 === n1 && m.n2 === n2) || (m.n1 === n2 && m.n2 === n1);
    if (!ends) return false;
    if (m.zLaneFrom == null || m.zLaneTo == null) return true;
    return lanePair(m.zLaneFrom, m.zLaneTo);
  });
}

/**
 * Place one Merintang stick across the roadway (outer wall → outer wall).
 * Same XY (n1===n2) is allowed — pure cross-brace with no XY length.
 * Different XY = skewed transverse brace (XY projection enters the DSM).
 */
export function addTransverseMember(
  members: MemberDef[],
  n1: number,
  n2: number,
  zFrom: number,
  zTo: number,
): MemberDef | null {
  if (zFrom === zTo) return null;
  if (hasTransverse(members, n1, n2, zFrom, zTo)) return null;
  const m: MemberDef = {
    id: nextMemberId++,
    n1,
    n2,
    shape: 'lurus',
    role: 'transverse',
    zLaneFrom: zFrom,
    zLaneTo: zTo,
  };
  members.push(m);
  return m;
}

/** Unique occupied deck Z lanes (arch legs on one lane count as one rail). */
export function countBaseRails(members: MemberDef[]): number {
  const lanes = new Set<number>();
  for (const m of members) {
    if (m.role === 'base' && m.zLane != null) lanes.add(m.zLane);
  }
  return lanes.size;
}

/** Next free deck lane index, or null if all BASE_RAIL_TARGET lanes are filled. */
export function nextFreeBaseLane(members: MemberDef[]): number | null {
  for (let i = 0; i < BASE_RAIL_TARGET; i++) {
    if (!hasBaseLane(members, i)) return i;
  }
  return null;
}

/** True if n1–n2 is the full deck chord between pin and roller abutments. */
export function isAbutmentDeckSpan(nodes: NodeDef[], n1: number, n2: number): boolean {
  const a = findNodeById(nodes, n1);
  const b = findNodeById(nodes, n2);
  if (!a || !b) return false;
  const pin = (n: NodeDef) =>
    n.isDeck && n.support === 'pin' && !n.isFree && !n.isApex;
  const roller = (n: NodeDef) =>
    n.isDeck && n.support === 'roller' && !n.isFree && !n.isApex;
  return (pin(a) && roller(b)) || (roller(a) && pin(b));
}

export function addMember(
  members: MemberDef[],
  n1: number,
  n2: number,
  extra?: Partial<
    Pick<
      MemberDef,
      'shape' | 'archGroupId' | 'archChord' | 'visualOnly' | 'role' | 'zLane' | 'zLaneFrom' | 'zLaneTo'
    >
  >,
): MemberDef | null {
  let opts = extra ? { ...extra } : undefined;
  if (opts?.role === 'base') {
    if (opts.zLane == null) return null;
    if (hasBaseLane(members, opts.zLane)) {
      // Allow second Lengkung leg on the same lane (same archGroupId).
      const gid = opts.archGroupId;
      const lane = opts.zLane;
      const sameLane = members.filter((m) => m.role === 'base' && m.zLane === lane);
      if (gid == null || sameLane.some((m) => m.archGroupId !== gid)) return null;
    }
  } else if (hasMember(members, n1, n2, opts?.zLane)) {
    return null;
  }
  // Both outer walls (lane 0 & 6) stay structural so Uji paints stress on BOTH.
  // Same XY × 2 walls ≈ 2×EA — intentional dual-wall load sharing (like base rails).
  const m: MemberDef = { id: nextMemberId++, n1, n2, ...opts };
  members.push(m);
  return m;
}

/** Clear leftover visualOnly on side-truss (non-base) so both walls enter DSM / get colours. */
export function ensureWallMembersStructural(members: MemberDef[]): number {
  let n = 0;
  for (const m of members) {
    if (m.role === 'base' || m.role === 'transverse') continue;
    if (m.visualOnly) {
      m.visualOnly = false;
      n++;
    }
  }
  return n;
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
 * - non-base visualOnly bars (legacy junk only — side walls must NOT be visualOnly)
 * - self-loops / zero XY length
 * - pure Merintang (same XY, Z-only span)
 *
 * Parallel base rails AND both outer-wall trusses DO enter the solve —
 * same XY chord × N ≈ N×EA (classroom dual-wall / multi-rail load sharing).
 * Skewed transverse (different XY) contributes its XY projection.
 */
export function membersForSolver(nodes: NodeDef[], members: MemberDef[]): MemberDef[] {
  return members.filter((m) => {
    if (m.visualOnly && m.role !== 'base') return false;
    // Pure Merintang (same XY, span in Z only) has no XY axial length — skip DSM.
    // Skewed transverse (different XY) contributes its XY projection like a normal brace.
    if (m.role === 'transverse' && m.n1 === m.n2) return false;
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

/** Soft-snap a world point onto the shared grid vertices (engine/grid.ts). */
export function softSnapToGrid(x: number, y: number, radius = SOFT_SNAP): Vec2 {
  const hit = nearestGridPoint(x, y, radius);
  if (hit) return hit;
  // Outside magnet radius — still clamp into build volume (no separate spacing)
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

/** Chord already has a Lengkung arch between these endpoints (optionally same wall). */
export function hasArchBetween(
  members: MemberDef[],
  n1: number,
  n2: number,
  zLane?: number,
): boolean {
  return members.some((m) => {
    if (!m.archChord) return false;
    const [a, b] = m.archChord;
    const ends = (a === n1 && b === n2) || (a === n2 && b === n1);
    if (!ends) return false;
    if (zLane != null && m.zLane != null) return m.zLane === zLane;
    return true;
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
  zLane?: number,
): ArchPlacement | null {
  if (n1 === n2) return null;
  if (hasArchBetween(members, n1, n2) || hasMember(members, n1, n2, zLane)) return null;
  const a = findNodeById([...nodes, ...apexNodes], n1);
  const b = findNodeById([...nodes, ...apexNodes], n2);
  if (!a || !b) return null;

  const apex = createApexNode(a, b);
  apexNodes.push(apex);
  const gid = nextArchGroupId++;
  const chord: [number, number] = [n1, n2];
  const legExtra = {
    shape: 'lengkung' as const,
    archGroupId: gid,
    archChord: chord,
    ...(zLane != null ? { zLane } : {}),
  };
  const leg1 = addMember(members, n1, apex.id, legExtra);
  const leg2 = addMember(members, apex.id, n2, legExtra);
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


export type BendTarget =
  | {
      kind: 'straight';
      member: MemberDef;
      mid: Vec2;
    }
  | {
      kind: 'arch';
      archGroupId: number;
      apex: NodeDef;
      n1: number;
      n2: number;
      mid: Vec2;
    };

function distToSegmentParam(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { d: number; t: number; qx: number; qy: number } {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-12) {
    return { d: Math.hypot(px - ax, py - ay), t: 0, qx: ax, qy: ay };
  }
  let t = ((px - ax) * abx + (py - ay) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * abx;
  const qy = ay + t * aby;
  return { d: Math.hypot(px - qx, py - qy), t, qx, qy };
}

/**
 * Pick the middle of a stick for bow editing.
 * Prefers mid-chord (t∈[0.28,0.72]) of straight members, or arch apex / chord mid.
 */
export function findBendTargetNearPoint(
  nodes: NodeDef[],
  members: MemberDef[],
  px: number,
  py: number,
  threshold: number,
): BendTarget | null {
  let best: BendTarget | null = null;
  let bestD = threshold;

  // Arch groups first (apex is the natural handle)
  const seen = new Set<number>();
  for (const m of members) {
    if (m.archGroupId == null || !m.archChord) continue;
    if (seen.has(m.archGroupId)) continue;
    seen.add(m.archGroupId);
    const [c1, c2] = m.archChord;
    const a = findNodeById(nodes, c1);
    const b = findNodeById(nodes, c2);
    if (!a || !b) continue;
    const legs = members.filter((x) => x.archGroupId === m.archGroupId);
    const endIds = new Set([c1, c2]);
    const apexId = legs
      .flatMap((l) => [l.n1, l.n2])
      .find((id) => !endIds.has(id));
    const apex = apexId != null ? findNodeById(nodes, apexId) : undefined;
    if (!apex) continue;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dApex = Math.hypot(px - apex.x, py - apex.y);
    const dMid = Math.hypot(px - mid.x, py - mid.y);
    const d = Math.min(dApex, dMid);
    if (d < bestD) {
      bestD = d;
      best = {
        kind: 'arch',
        archGroupId: m.archGroupId,
        apex,
        n1: c1,
        n2: c2,
        mid,
      };
    }
  }

  for (const m of members) {
    if (m.archGroupId != null) continue;
    const a = findNodeById(nodes, m.n1);
    const b = findNodeById(nodes, m.n2);
    if (!a || !b) continue;
    const { d, t } = distToSegmentParam(px, py, a.x, a.y, b.x, b.y);
    if (t < 0.28 || t > 0.72) continue;
    if (d < bestD) {
      bestD = d;
      best = {
        kind: 'straight',
        member: m,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
    }
  }
  return best;
}

/**
 * Convert a straight member into a Lengkung arch with apex at `apexPos`.
 * Preserves role / zLane / visualOnly (for base rails).
 */
export function convertMemberToArch(
  apexNodes: NodeDef[],
  members: MemberDef[],
  memberId: number,
  apexPos: Vec2,
): ArchPlacement | null {
  const m = members.find((x) => x.id === memberId);
  if (!m || m.archGroupId != null) return null;
  const n1 = m.n1;
  const n2 = m.n2;
  const role = m.role;
  const zLane = m.zLane;
  const visualOnly = m.visualOnly;
  removeMemberById(members, memberId);

  const apex: NodeDef = {
    id: nextApexNodeId++,
    x: apexPos.x,
    y: apexPos.y,
    support: 'none',
    isDeck: false,
    isApex: true,
  };
  apexNodes.push(apex);
  const gid = nextArchGroupId++;
  const chord: [number, number] = [n1, n2];
  const extra = {
    shape: 'lengkung' as const,
    archGroupId: gid,
    archChord: chord,
    role,
    zLane,
    visualOnly,
  };
  const leg1 = addMember(members, n1, apex.id, extra);
  const leg2 = addMember(members, apex.id, n2, extra);
  if (!leg1 || !leg2) {
    if (leg1) removeMemberById(members, leg1.id);
    if (leg2) removeMemberById(members, leg2.id);
    const i = apexNodes.findIndex((n) => n.id === apex.id);
    if (i >= 0) apexNodes.splice(i, 1);
    // restore straight on failure
    addMember(members, n1, n2, {
      shape: 'lurus',
      role,
      zLane,
      visualOnly,
    });
    return null;
  }
  return { apex, leg1, leg2, archGroupId: gid };
}

/** Move an existing Lengkung apex to a new XY position. */
export function moveArchApex(apex: NodeDef, pos: Vec2): void {
  apex.x = pos.x;
  apex.y = pos.y;
}

/**
 * Apply interactive bow: convert straight→arch or move existing apex.
 * Returns the bend target after mutation (always arch).
 */
export function applyBendAt(
  apexNodes: NodeDef[],
  members: MemberDef[],
  target: BendTarget,
  pos: Vec2,
): BendTarget | null {
  if (target.kind === 'straight') {
    const placed = convertMemberToArch(apexNodes, members, target.member.id, pos);
    if (!placed) return null;
    return {
      kind: 'arch',
      archGroupId: placed.archGroupId,
      apex: placed.apex,
      n1: placed.leg1.archChord![0],
      n2: placed.leg1.archChord![1],
      mid: target.mid,
    };
  }
  moveArchApex(target.apex, pos);
  return target;
}

export type { StickLengthPreset };
