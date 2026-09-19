import { cloneMembers, removeMemberById } from './model';
import { solveTruss } from './solver';
import type { MemberDef, NodeDef, SolveResult, Vec2 } from './types';

export interface ProgressiveResult {
  steps: SolveResult[];
  final: SolveResult;
  removedIds: number[];
  collapsed: boolean;
}

/**
 * Solve, remove overstressed members (u≥1), re-solve until stable.
 * Soft-stabilized solves still produce member colours — never a dead-end.
 */
export function progressiveFailure(
  nodes: NodeDef[],
  members: MemberDef[],
  loads: Map<number, Vec2>,
  maxSteps = 20,
): ProgressiveResult {
  let current = cloneMembers(members);
  const steps: SolveResult[] = [];
  const removedIds: number[] = [];
  let collapsed = false;

  for (let step = 0; step < maxSteps; step++) {
    const result = solveTruss(nodes, current, loads);
    steps.push(result);

    if (!result.ok) {
      // Truly empty / unusable — stop
      collapsed = current.length === 0;
      break;
    }

    const failed = result.members.filter((m) => m.failed);
    if (failed.length === 0) break;

    // Snap the worst offenders first (clearest "patah" feedback)
    failed.sort((a, b) => b.utilization - a.utilization);
    const toRemove = failed.slice(0, Math.max(1, Math.ceil(failed.length / 2)));
    for (const f of toRemove) {
      if (removeMemberById(current, f.id)) removedIds.push(f.id);
    }

    if (current.length === 0) {
      collapsed = true;
      steps.push({
        ok: true,
        singular: false,
        stabilized: true,
        message: 'Semua ahli gagal. Struktur runtuh!',
        displacements: new Map(),
        members: [],
        maxUtilization: 1,
        criticalMemberId: removedIds[removedIds.length - 1] ?? null,
      });
      break;
    }
  }

  const final = steps[steps.length - 1]!;
  return { steps, final, removedIds, collapsed };
}
