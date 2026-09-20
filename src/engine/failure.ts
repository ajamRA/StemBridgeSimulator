import { cloneMembers, removeMemberById } from './model';
import { solveTruss } from './solver';
import type { MemberDef, NodeDef, SolveResult, Vec2 } from './types';

export interface ProgressiveResult {
  steps: SolveResult[];
  final: SolveResult;
  removedIds: number[];
  collapsed: boolean;
}

export interface ProgressiveOptions {
  /**
   * Max members to break per Uji click.
   * Default 1 = one clear patah (critical stick only).
   * Pass 2 for at-most-two; use with continuous for cascade.
   */
  maxBreaks?: number;
  /**
   * When true, re-solve and keep removing until stable / empty
   * ("runtuh berterusan"). Default false = single click, one patah.
   */
  continuous?: boolean;
  /** Cap cascade iterations when continuous. Ignored otherwise. */
  maxSteps?: number;
}

/**
 * Solve and optionally remove overstressed members (u≥1).
 * Default: break only the worst 1 member — no full-bridge cascade.
 */
export function progressiveFailure(
  nodes: NodeDef[],
  members: MemberDef[],
  loads: Map<number, Vec2>,
  opts: ProgressiveOptions = {},
): ProgressiveResult {
  const maxBreaks = Math.max(1, opts.maxBreaks ?? 1);
  const continuous = opts.continuous ?? false;
  const maxSteps = continuous ? (opts.maxSteps ?? 20) : 1;

  let current = cloneMembers(members);
  const steps: SolveResult[] = [];
  const removedIds: number[] = [];
  let collapsed = false;

  for (let step = 0; step < maxSteps; step++) {
    const result = solveTruss(nodes, current, loads);
    steps.push(result);

    if (!result.ok) {
      collapsed = current.length === 0;
      break;
    }

    if (removedIds.length >= maxBreaks) break;

    const failed = result.members.filter((m) => m.failed);
    if (failed.length === 0) break;

    // Worst offenders first (clearest "patah" feedback)
    failed.sort((a, b) => b.utilization - a.utilization);
    const budget = maxBreaks - removedIds.length;
    // Default / non-continuous: only the worst stick(s) up to budget.
    // Continuous cascade: still respect budget but can take several per step.
    const take = continuous
      ? Math.min(budget, Math.max(1, Math.ceil(failed.length / 2)))
      : Math.min(budget, maxBreaks);
    const toRemove = failed.slice(0, take);
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

    if (!continuous) {
      // One clear patah — optional follow-up solve for final colours, then stop.
      const after = solveTruss(nodes, current, loads);
      steps.push(after);
      if (!after.ok && current.length === 0) collapsed = true;
      break;
    }
  }

  const final = steps[steps.length - 1]!;
  return { steps, final, removedIds, collapsed };
}
