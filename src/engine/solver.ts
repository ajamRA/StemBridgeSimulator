import { AREA, E, COMPRESSION_CAPACITY, TENSION_CAPACITY, SINGULARITY_EPS } from './constants';
import { memberDirection, memberLength, membersForSolver } from './model';
import type { MemberDef, MemberResult, NodeDef, SolveResult, Vec2 } from './types';

/**
 * 2D truss Direct Stiffness Method.
 * DOF order per node: [ux, uy].
 * Force sign: + = tension, − = compression.
 */
export function solveTruss(
  nodes: NodeDef[],
  members: MemberDef[],
  loads: Map<number, Vec2>,
): SolveResult {
  // Strip visual-only / zero-length junk so Near↔Far Z braces never poison K
  const structural = membersForSolver(nodes, members);
  if (structural.length === 0) {
    return emptyResult('Tiada ahli struktur. Bina jambatan dahulu.');
  }

  // Only joints that participate in structural members (unused grid nodes would make K singular)
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
    // Local axial → global 4x4
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

  // Fixed DOFs from supports (active joints only)
  const fixed = new Set<number>();
  for (const nd of active) {
    const idx = idToIndex.get(nd.id)!;
    if (nd.support === 'pin') {
      fixed.add(idx * 2);
      fixed.add(idx * 2 + 1);
    } else if (nd.support === 'roller') {
      fixed.add(idx * 2 + 1); // vertical only
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

  const uf = solveLinear(Kff, Ff);
  if (!uf) {
    return {
      ok: false,
      singular: true,
      message:
        'Struktur tidak stabil (matriks singular). Tambah segi tiga pada satah XY — brace Near↔Far hanya visual!',
      displacements: new Map(),
      members: [],
      maxUtilization: 0,
      criticalMemberId: null,
    };
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
    // Axial elongation: [−c −s c s] · u
    const delta = -c * u1 - s * v1 + c * u2 + s * v2;
    const force = ((AREA * E) / L) * delta; // + tension
    const capacity = force >= 0 ? TENSION_CAPACITY : COMPRESSION_CAPACITY;
    const utilization = Math.abs(force) / capacity;
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
    displacements,
    members: memberResults,
    maxUtilization: maxU,
    criticalMemberId: criticalId,
  };
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
  if (u >= 1) return 0x7f0000; // dark red — fail
  if (u >= 0.85) return 0xe53935; // red
  if (u >= 0.6) return 0xfb8c00; // orange
  if (u >= 0.35) return 0xfdd835; // yellow
  return 0x43a047; // green
}
