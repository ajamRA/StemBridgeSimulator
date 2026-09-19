export interface Vec2 {
  x: number;
  y: number;
}

export type SupportType = 'none' | 'pin' | 'roller';

export type StickShape = 'lurus' | 'lengkung';

/** Classroom stick length preset — Panjang may span the full gap. */
export type StickLengthPreset = 1 | 2 | 'panjang' | 'auto';

export type MemberRole = 'normal' | 'base' | 'transverse';

export interface NodeDef {
  id: number;
  x: number;
  y: number;
  support: SupportType;
  /** True if this node is on the deck (can receive load) */
  isDeck: boolean;
  /**
   * Intermediate apex of a Lengkung (curved) stick — not on the build snap grid.
   * Included in the DSM; excluded from placement picking.
   */
  isApex?: boolean;
  /** User-placed free joint (soft-snapped), not part of the fixed abutment grid. */
  isFree?: boolean;
}

export interface MemberDef {
  id: number;
  n1: number;
  n2: number;
  /**
   * Visual-only bars (e.g. extra parallel base rails beyond the first structural
   * chord) must never enter the 2D DSM. Prefer keeping such geometry tagged.
   */
  visualOnly?: boolean;
  /** Straight chord vs curved arch (Lengkung uses two segments + apex). */
  shape?: StickShape;
  /** Shared id for the two axial legs of one Lengkung stick. */
  archGroupId?: number;
  /** Original chord endpoints [a,b] for a Lengkung segment. */
  archChord?: [number, number];
  /** Deck base rail (full-span lidi panjang) vs normal brace/chord. */
  role?: MemberRole;
  /**
   * Z lane index 0..BASE_RAIL_TARGET-1.
   * Base rails use any deck lane; side-truss uprights/diagonals use outer
   * lanes only (0 = Kiri, last = Kanan) so the middle roadway stays clear.
   */
  zLane?: number;
  /**
   * Transverse (Merintang) member: spans two Z lanes across the roadway.
   * Endpoints are XY node ids (often the same id for a pure cross-brace).
   * Render: (x1,y1,zLaneFrom) → (x2,y2,zLaneTo).
   */
  zLaneFrom?: number;
  zLaneTo?: number;
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
  /** True when K was regularized (soft springs) so Uji can still show stress. */
  stabilized?: boolean;
  message?: string;
  displacements: Map<number, Vec2>;
  members: MemberResult[];
  maxUtilization: number;
  criticalMemberId: number | null;
}

export type GameMode = 'bina' | 'uji' | 'padam';

/** Active through-truss side wall for build/snap. */
export type WallMode = 'kiri' | 'kanan' | 'auto' | 'merintang';
