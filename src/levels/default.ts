import { DEFAULT_LOAD, SPAN } from '../engine/constants';
import { createGridNodes, defaultLoadNodeId } from '../engine/model';
import type { MemberDef } from '../engine/types';

export interface LevelConfig {
  id: string;
  name: string;
  nameMs: string;
  tipMs: string;
  span: number;
  defaultLoad: number;
  /** Optional starter members for tutorial */
  starterMembers?: MemberDef[];
}

export const defaultLevel: LevelConfig = {
  id: 'span10',
  name: 'Simple Span',
  nameMs: 'Rentang Mudah',
  tipMs:
    'Tip: Base: pilih Panjang. Sokongan: pilih Pendek. Lengkung = busur (nod puncak + 2 ahli) untuk arch. Segi tiga XY supaya stabil — mampatan lebih lemah!',
  span: SPAN,
  defaultLoad: DEFAULT_LOAD,
};

export function createLevelState(level: LevelConfig = defaultLevel) {
  const nodes = createGridNodes();
  const members: MemberDef[] = level.starterMembers
    ? level.starterMembers.map((m) => ({ ...m }))
    : [];
  const loadNodeId = defaultLoadNodeId(nodes);
  return {
    level,
    nodes,
    members,
    loadNodeId,
    loadMagnitude: level.defaultLoad,
  };
}
