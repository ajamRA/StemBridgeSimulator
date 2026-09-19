import { AREA, E, COMPRESSION_CAPACITY, TENSION_CAPACITY, SINGULARITY_EPS } from './constants';
import { memberDirection, memberLength, membersForSolver } from './model';
import type { MemberDef, MemberResult, NodeDef, SolveResult, Vec2 } from './types';

/** Soft spring (per free DOF) used to regularize mechanisms so Uji still colours sticks. */
const SOFT_SPRING = (AREA * E) * 0.002;

/**
 * 2D truss Direct Stiffness Method.
 * DOF order per node: [ux, uy].
 * Force sign: + = tension, − = compression.
 *
 * If K is singular (mechanism), retries with ridge/soft springs so the player
 * always gets stress colours and a critical member — STEM break-test feel.
 */
export function solveTruss(
  nodes: NodeDef[],
  members: MemberDef[],
  loads: Map<number, Vec2>,
): SolveResult {
  const structural = membersForSolver(nodes, members);
  if (structural.length === 0) {
    return emptyResult('Tiada ahli struktur. Bina jambatan dahulu.');
  }

  const activeIds = new Set<number>();
  for (const m of structural) {
    activeIds.add(m.n1);
    activeIds.add(m.n2);
  }
  const active = nodes.filter((nd) => activeIds.has(nd.id));
  if (active.length < 2) {
    return emptyResult('Struktur terlalu kecil.');
  }

  const n = active.length;
  const ndof = n * 2;
  const idToIndex = new Map<number, number>();
  active.forEach((nd, i) => idToIndex.set(nd.id, i));

  const K = zeros(ndof, ndof);
  const F = new Float64Array(ndof);

  for (const m of structural) {
    const L = memberLength(nodes, m);
    if (L < 1e-12) continue;
    const { x: c, y: s } = memberDirection(nodes, m);
    const k = (AREA * E) / L;
    const cc = c * c;
    const ss = s * s;
    const cs = c * s;
    const ke = [
      [k * cc, k * cs, -k * cc, -k * cs],
      [k * cs, k * ss, -k * cs, -k * ss],
      [-k * cc, -k * cs, k * cc, k * cs],
      [-k * cs, -k * ss, k * cs, k * ss],
    ];
    const ia = idToIndex.get(m.n1)!;
    const ib = idToIndex.get(m.n2)!;
    const dofs = [ia * 2, ia * 2 + 1, ib * 2, ib * 2 + 1];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        K[dofs[i]!]![dofs[j]!]! += ke[i]![j]!;
      }
    }
  }

  for (const [nid, load] of loads) {
    const idx = idToIndex.get(nid);
    if (idx === undefined) continue;
    F[idx * 2]! += load.x;
    F[idx * 2 + 1]! += load.y;
  }

  const fixed = new Set<number>();
  for (const nd of active) {
    const idx = idToIndex.get(nd.id)!;
    if (nd.support === 'pin') {
      fixed.add(idx * 2);
      fixed.add(idx * 2 + 1);
    } else if (nd.support === 'roller') {
      fixed.add(idx * 2 + 1);
    }
  }

  const free: number[] = [];
  for (let i = 0; i < ndof; i++) {
    if (!fixed.has(i)) free.push(i);
  }

  if (free.length === 0) {
    return emptyResult('Tiada darjah kebebasan bebas.');
  }

  const nf = free.length;
  const Kff = zeros(nf, nf);
  const Ff = new Float64Array(nf);
  for (let i = 0; i < nf; i++) {
    Ff[i] = F[free[i]!]!;
    for (let j = 0; j < nf; j++) {
      Kff[i]![j] = K[free[i]!]![free[j]!]!;
    }
  }

  let uf = solveLinear(Kff, Ff);
  let stabilized = false;

  if (!uf) {
    // Ridge / soft springs → mechanism still deforms & shows strain colours
    const Ksoft = zeros(nf, nf);
    for (let i = 0; i < nf; i++) {
      for (let j = 0; j < nf; j++) Ksoft[i]![j] = Kff[i]![j]!;
      Ksoft[i]![i]! += SOFT_SPRING;
    }
    uf = solveLinear(Ksoft, Ff);
    stabilized = true;
  }

  if (!uf) {
    // Stronger spring fallback
    const Ksoft = zeros(nf, nf);
    for (let i = 0; i < nf; i++) {
      for (let j = 0; j < nf; j++) Ksoft[i]![j] = Kff[i]![j]!;
      Ksoft[i]![i]! += SOFT_SPRING * 40;
    }
    uf = solveLinear(Ksoft, Ff);
    stabilized = true;
  }

  if (!uf) {
    return springFallback(nodes, structural, active, idToIndex, loads, fixed);
  }

  const U = new Float64Array(ndof);
  for (let i = 0; i < nf; i++) {
    U[free[i]!] = uf[i]!;
  }

  const displacements = new Map<number, Vec2>();
  for (const nd of active) {
    const idx = idToIndex.get(nd.id)!;
    displacements.set(nd.id, { x: U[idx * 2]!, y: U[idx * 2 + 1]! });
  }

  let { memberResults, maxU, criticalId } = recoverForces(
    nodes,
    structural,
    idToIndex,
    U,
  );

  // Soft springs may absorb load without stressing colinear bars — fall back
  // so Uji still highlights a weak stick for the player.
  let loadMag = 0;
  for (const [, L] of loads) loadMag += Math.hypot(L.x, L.y);
  if (stabilized && maxU < 1e-4 && loadMag > 1e-9) {
    return springFallback(nodes, structural, active, idToIndex, loads, fixed);
  }

  const msg = stabilized
    ? 'Struktur fleksibel / kurang brace — tegasan dianggarkan (stabilisasi lembut). Lihat lidi merah.'
    : undefined;

  return {
    ok: true,
    singular: false,
    stabilized,
    message: msg,
    displacements,
    members: memberResults,
    maxUtilization: maxU,
    criticalMemberId: criticalId,
  };
}

/**
 * Last-resort bar-spring estimate so Uji never returns empty member colours.
 * Projects nodal loads into axial member forces via simple stiffness weights.
 */
function springFallback(
  nodes: NodeDef[],
  structural: MemberDef[],
  active: NodeDef[],
  idToIndex: Map<number, number>,
  loads: Map<number, Vec2>,
  fixed: Set<number>,
): SolveResult {
  const displacements = new Map<number, Vec2>();
  for (const nd of active) {
    const idx = idToIndex.get(nd.id)!;
    const load = loads.get(nd.id) ?? { x: 0, y: 0 };
    const ux = fixed.has(idx * 2) ? 0 : load.x * 0.02;
    const uy = fixed.has(idx * 2 + 1) ? 0 : load.y * 0.02;
    displacements.set(nd.id, { x: ux, y: uy });
  }

  // Seed U from crude displacements
  const U = new Float64Array(active.length * 2);
  for (const nd of active) {
    const idx = idToIndex.get(nd.id)!;
    const d = displacements.get(nd.id)!;
    U[idx * 2] = d.x;
    U[idx * 2 + 1] = d.y;
  }

  // Amplify: members nearer vertical load path get higher |delta|
  let loadMag = 0;
  for (const [, L] of loads) loadMag += Math.hypot(L.x, L.y);
  if (loadMag < 1e-9) loadMag = 1;

  const memberResults: MemberResult[] = [];
  let maxU = 0;
  let criticalId: number | null = null;

  for (const m of structural) {
    const L = memberLength(nodes, m);
    if (L < 1e-12) continue;
    const a = nodes.find((n) => n.id === m.n1)!;
    const b = nodes.find((n) => n.id === m.n2)!;
    const { x: c, y: s } = memberDirection(nodes, m);
    // Prefer members that resist vertical load (high |s|) near mid-span
    const midX = (a.x + b.x) / 2;
    const spanHint = Math.max(1, Math.max(...active.map((n) => n.x)));
    const midFactor = 1 + 1.5 * (1 - Math.abs(midX - spanHint / 2) / (spanHint / 2 + 1e-6));
    const resist = Math.abs(s) * 0.7 + Math.abs(c) * 0.3;
    const force = -loadMag * resist * midFactor * (0.35 + L / (spanHint + 1)); // compression bias under gravity
    const capacity = force >= 0 ? TENSION_CAPACITY : COMPRESSION_CAPACITY;
    const utilization = Math.min(2.5, Math.abs(force) / capacity);
    const failed = utilization >= 1;
    memberResults.push({ id: m.id, force, utilization, failed });
    if (utilization > maxU) {
      maxU = utilization;
      criticalId = m.id;
    }
  }

  return {
    ok: true,
    singular: false,
    stabilized: true,
    message:
      'Struktur tidak lengkap — anggaran tegasan (lihat lidi paling merah = paling lemah).',
    displacements,
    members: memberResults,
    maxUtilization: maxU,
    criticalMemberId: criticalId,
  };
}

function recoverForces(
  nodes: NodeDef[],
  structural: MemberDef[],
  idToIndex: Map<number, number>,
  U: Float64Array,
): { memberResults: MemberResult[]; maxU: number; criticalId: number | null } {
  const memberResults: MemberResult[] = [];
  let maxU = 0;
  let criticalId: number | null = null;

  for (const m of structural) {
    const L = memberLength(nodes, m);
    const { x: c, y: s } = memberDirection(nodes, m);
    const ia = idToIndex.get(m.n1)!;
    const ib = idToIndex.get(m.n2)!;
    const u1 = U[ia * 2]!;
    const v1 = U[ia * 2 + 1]!;
    const u2 = U[ib * 2]!;
    const v2 = U[ib * 2 + 1]!;
    const delta = -c * u1 - s * v1 + c * u2 + s * v2;
    const force = ((AREA * E) / L) * delta;
    const capacity = force >= 0 ? TENSION_CAPACITY : COMPRESSION_CAPACITY;
    const utilization = Math.abs(force) / capacity;
    const failed = utilization >= 1;
    memberResults.push({ id: m.id, force, utilization, failed });
    if (utilization > maxU) {
      maxU = utilization;
      criticalId = m.id;
    }
  }
  return { memberResults, maxU, criticalId };
}

function emptyResult(message: string): SolveResult {
  return {
    ok: false,
    singular: false,
    message,
    displacements: new Map(),
    members: [],
    maxUtilization: 0,
    criticalMemberId: null,
  };
}

function zeros(r: number, c: number): number[][] {
  const m: number[][] = [];
  for (let i = 0; i < r; i++) {
    m.push(new Array(c).fill(0));
  }
  return m;
}

/** Gaussian elimination with partial pivoting. Returns null if singular. */
export function solveLinear(A: number[][], b: Float64Array): Float64Array | null {
  const n = b.length;
  const M: number[][] = A.map((row) => row.slice());
  const x = new Float64Array(b);

  for (let k = 0; k < n; k++) {
    let piv = k;
    let maxAbs = Math.abs(M[k]![k]!);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(M[i]![k]!);
      if (v > maxAbs) {
        maxAbs = v;
        piv = i;
      }
    }
    if (maxAbs < SINGULARITY_EPS) return null;
    if (piv !== k) {
      const tmp = M[k]!;
      M[k] = M[piv]!;
      M[piv] = tmp;
      const tv = x[k]!;
      x[k] = x[piv]!;
      x[piv] = tv;
    }
    const akk = M[k]![k]!;
    for (let i = k + 1; i < n; i++) {
      const f = M[i]![k]! / akk;
      x[i]! -= f * x[k]!;
      for (let j = k; j < n; j++) {
        M[i]![j]! -= f * M[k]![j]!;
      }
    }
  }

  for (let i = n - 1; i >= 0; i--) {
    let s = x[i]!;
    for (let j = i + 1; j < n; j++) {
      s -= M[i]![j]! * x[j]!;
    }
    const di = M[i]![i]!;
    if (Math.abs(di) < SINGULARITY_EPS) return null;
    x[i] = s / di;
  }
  return x;
}

export function utilizationColor(u: number): number {
  if (u >= 1) return 0x7f0000;
  if (u >= 0.85) return 0xe53935;
  if (u >= 0.6) return 0xfb8c00;
  if (u >= 0.35) return 0xfdd835;
  return 0x43a047;
}
