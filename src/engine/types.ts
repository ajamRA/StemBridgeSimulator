export interface Vec2 {
  x: number;
  y: number;
}

export type SupportType = 'none' | 'pin' | 'roller';

export interface NodeDef {
  id: number;
  x: number;
  y: number;
  support: SupportType;
  /** True if this node is on the deck (can receive load) */
  isDeck: boolean;
}

export interface MemberDef {
  id: number;
  n1: number;
  n2: number;
  /**
   * Visual-only bars (e.g. mistaken Near↔Far Z connectors) must never enter the
   * 2D DSM. Prefer keeping such geometry entirely out of `members` (scene meshes);
   * this flag is a safety net if a bar is ever tagged visual.
   */
  visualOnly?: boolean;
}

export interface MemberResult {
  id: number;
  force: number; /** +tension, -compression */
  utilization: number;
  failed: boolean;
}

export interface SolveResult {
  ok: boolean;
  singular: boolean;
  message?: string;
  displacements: Map<number, Vec2>;
  members: MemberResult[];
  maxUtilization: number;
  criticalMemberId: number | null;
}

export type GameMode = 'bina' | 'uji' | 'padam';
