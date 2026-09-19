import {
  BASE_RAIL_TARGET,
  DEFAULT_LOAD,
  NODE_PICK_RADIUS,
  OUTER_LANE_KANAN,
  OUTER_LANE_KIRI,
  SOFT_SNAP,
} from '../engine/constants';
import { progressiveFailure } from '../engine/failure';
import {
  addArchMember,
  addBaseRail,
  addMember,
  allNodes,
  cloneApexNodes,
  cloneFreeNodes,
  cloneMembers,
  countBaseRails,
  findMemberNearPoint,
  isAbutmentDeckSpan,
  findNodeById,
  findOrCreateNodeNear,
  hasArchBetween,
  hasMember,
  isAllowedMemberForLength,
  nextFreeBaseLane,
  pickableNodes,
  pruneOrphanApexes,
  promoteBaseRails,
  pruneOrphanFreeNodes,
  removeMemberById,
  removeMemberOrArch,
  resetMemberIds,
  softSnapToGrid,
} from '../engine/model';
import { solveTruss } from '../engine/solver';
import type {
  GameMode,
  MemberDef,
  MemberResult,
  NodeDef,
  StickLengthPreset,
  StickShape,
  Vec2,
  WallMode,
} from '../engine/types';
import { createLevelState, defaultLevel } from '../levels';
import { BridgeScene } from '../scene/BridgeScene';
import {
  mountUI,
  renderResultPanel,
  setActiveLength,
  setActiveMode,
  setActiveShape,
  setActiveWall,
  setBaseCounter,
  type UIHandles,
} from '../ui/dom';
import * as THREE from 'three';

/** Pixels of movement before a pointer gesture counts as orbit/drag (not a click). */
const CLICK_SLOP_PX = 6;

const TIP_MS =
  'Truss pada lorong 1 dan 7 (tepi). Tengah untuk lalu. Tarik = 1 lidi; + Base = 1 lorong; Uji tunjuk patah.';

interface BuildSnapshot {
  members: MemberDef[];
  apexes: NodeDef[];
  free: NodeDef[];
}

export class Game {
  private ui: UIHandles;
  private scene: BridgeScene;
  /** Fixed snap-grid nodes (supports + deck magnets). */
  private gridNodes: NodeDef[];
  /** User-placed free joints. */
  private freeNodes: NodeDef[] = [];
  /** Lengkung apex nodes (not pickable). */
  private apexNodes: NodeDef[] = [];
  private members: MemberDef[] = [];
  private undoStack: BuildSnapshot[] = [];
  private mode: GameMode = 'bina';
  private loadNodeId: number;
  private loadMagnitude = DEFAULT_LOAD;
  private lastResults: MemberResult[] | null = null;
  private tested = false;

  /** Default Panjang for base-first classroom workflow. */
  private selectedLength: StickLengthPreset = 'panjang';
  private selectedShape: StickShape = 'lurus';
  private wallMode: WallMode = 'kiri';

  private dragFrom: NodeDef | null = null;
  private pointerDown = false;
  private interacting = false;
  private downClient: { x: number; y: number } | null = null;
  private stickyNode: NodeDef | null = null;
  private shiftHeld = false;
  /** Pending free node created on pointerdown (rolled back if cancelled). */
  private pendingCreated: NodeDef | null = null;

  constructor(app: HTMLElement) {
    this.ui = mountUI(app);
    this.scene = new BridgeScene(this.ui.canvas);

    const state = createLevelState(defaultLevel);
    this.gridNodes = state.nodes;
    this.members = state.members;
    this.loadNodeId = state.loadNodeId;
    this.loadMagnitude = state.loadMagnitude;
    this.ui.loadSlider.value = String(this.loadMagnitude);
    this.ui.loadVal.textContent = String(this.loadMagnitude);

    setActiveLength(this.ui, this.selectedLength);
    setActiveShape(this.ui, this.selectedShape);
    setActiveWall(this.ui, this.wallMode);
    this.scene.setWallMode(this.wallMode);

    this.refreshNodes();
    this.syncScene();
    this.updateBaseCounter();
    this.bindUI();
    this.bindPointer();
    this.onResize();
    window.addEventListener('resize', () => this.onResize());

    const loop = () => {
      this.scene.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);

    this.showIdleTip();
  }

  private nodes(): NodeDef[] {
    return allNodes(this.gridNodes, this.apexNodes, this.freeNodes);
  }

  private refreshNodes(): void {
    this.scene.setNodes(this.nodes());
  }

  private updateBaseCounter(): void {
    setBaseCounter(this.ui, countBaseRails(this.members));
  }

  private bindUI(): void {
    this.ui.btnBina.addEventListener('click', () => this.setMode('bina'));
    this.ui.btnUji.addEventListener('click', () => this.runTest());
    this.ui.btnPadam.addEventListener('click', () => this.setMode('padam'));
    this.ui.btnUndo.addEventListener('click', () => this.undo());
    this.ui.btnReset.addEventListener('click', () => this.reset());
    this.ui.btnBase.addEventListener('click', () => this.placeBaseRail());
    this.ui.chkMirror.addEventListener('change', () => {
      const on = this.ui.chkMirror.checked;
      this.scene.setAutoMirrorDepth(on);
      this.refreshNodes();
      this.syncScene();
      this.flash(
        on
          ? 'Cermin 3D HIDUP — setiap lidi digandakan near+far + brace melintang (kotak).'
          : 'Cermin 3D MATI — satu tarikan = satu lidi sahaja.',
        on ? 'warn' : 'ok',
      );
    });
    this.ui.loadSlider.addEventListener('input', () => {
      this.loadMagnitude = Number(this.ui.loadSlider.value);
      this.ui.loadVal.textContent = String(this.loadMagnitude);
      this.invalidateTest();
      this.updateLoadArrow();
    });

    for (const btn of this.ui.lengthButtons) {
      btn.addEventListener('click', () => {
        const raw = btn.dataset.length;
        if (raw === 'auto') this.selectedLength = 'auto';
        else if (raw === 'panjang') this.selectedLength = 'panjang';
        else if (raw === '1' || raw === '2') {
          this.selectedLength = Number(raw) as 1 | 2;
        } else return;
        setActiveLength(this.ui, this.selectedLength);
        this.flash(
          `Panjang lidi: ${this.lengthLabel()}. Tip: + Base = 1 lidi/lorong (ulang ×7); Pendek untuk brace.`,
          '',
        );
      });
    }

    for (const btn of this.ui.shapeButtons) {
      btn.addEventListener('click', () => {
        const raw = btn.dataset.shape;
        if (raw !== 'lurus' && raw !== 'lengkung') return;
        this.selectedShape = raw;
        setActiveShape(this.ui, this.selectedShape);
        this.flash(
          raw === 'lengkung'
            ? 'Bentuk Lengkung — busur auto-sisip nod puncak + 2 ahli (kuat untuk arch).'
            : 'Bentuk Lurus — satu ahli axial antara dua nod.',
          '',
        );
      });
    }

    for (const btn of this.ui.wallButtons) {
      btn.addEventListener('click', () => {
        const raw = btn.dataset.wall;
        if (raw !== 'kiri' && raw !== 'kanan' && raw !== 'auto') return;
        this.wallMode = raw;
        setActiveWall(this.ui, this.wallMode);
        this.scene.setWallMode(this.wallMode);
        const label =
          raw === 'kiri'
            ? 'Kiri (lorong 1 — dinding truss)'
            : raw === 'kanan'
              ? 'Kanan (lorong 7 — dinding truss)'
              : 'Auto — dinding luar terdekat';
        this.flash(`Dinding aktif: ${label}. Tengah (lorong 2–6) untuk lalu.`, '');
      });
    }

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') {
        this.shiftHeld = true;
        this.applyShiftPan();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        this.undo();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') {
        this.shiftHeld = false;
        this.applyShiftPan();
      }
    });
  }


  private currentWallLane(clientX?: number, clientY?: number): number {
    if (this.wallMode === 'auto' && clientX != null && clientY != null) {
      const rect = this.ui.canvas.getBoundingClientRect();
      return this.scene.resolveWallFromClient(clientX, clientY, rect);
    }
    if (this.wallMode === 'kanan') return OUTER_LANE_KANAN;
    return OUTER_LANE_KIRI;
  }

  private lengthLabel(): string {
    switch (this.selectedLength) {
      case 1:
        return 'Pendek';
      case 2:
        return 'Sederhana';
      case 'panjang':
        return 'Panjang (hingga rentang)';
      default:
        return 'Auto';
    }
  }

  private applyShiftPan(): void {
    if (this.interacting) return;
    this.scene.controls.mouseButtons.LEFT = this.shiftHeld
      ? THREE.MOUSE.PAN
      : THREE.MOUSE.ROTATE;
  }

  /** Resolve a world hit to a pickable node, optionally creating a free joint. */
  private resolveNode(
    world: Vec2,
    from: NodeDef | null,
    allowCreate: boolean,
  ): NodeDef | null {
    const candidates = pickableNodes(this.nodes());
    if (!from) {
      const near = this.scene.nearestNode(candidates, world, NODE_PICK_RADIUS);
      if (near) return near;
      if (!allowCreate) return null;
      const { node, created } = findOrCreateNodeNear(
        this.gridNodes,
        this.freeNodes,
        this.apexNodes,
        world,
        SOFT_SNAP * 1.5,
      );
      if (created) {
        this.pendingCreated = node;
        this.refreshNodes();
      }
      return node;
    }

    // Second endpoint: prefer valid targets; may create free node if Auto/Panjang
    const validExisting = candidates.filter(
      (n) =>
        n.id !== from.id &&
        isAllowedMemberForLength(this.nodes(), from.id, n.id, this.selectedLength) &&
        !hasMember(this.members, from.id, n.id) &&
        !(
          this.selectedShape === 'lengkung' &&
          hasArchBetween(this.members, from.id, n.id, this.scene.getActiveWallLane())
        ),
    );
    const nearValid = this.scene.nearestNode(validExisting, world, NODE_PICK_RADIUS);
    if (nearValid) return nearValid;

    const nearAny = this.scene.nearestNode(
      candidates.filter((n) => n.id !== from.id),
      world,
      NODE_PICK_RADIUS,
    );
    if (nearAny) return nearAny;

    if (!allowCreate) return null;
    const { node, created } = findOrCreateNodeNear(
      this.gridNodes,
      this.freeNodes,
      this.apexNodes,
      world,
      SOFT_SNAP * 1.5,
    );
    if (created) {
      this.pendingCreated = node;
      this.refreshNodes();
    }
    return node;
  }

  private discardPendingCreated(): void {
    if (!this.pendingCreated) return;
    const id = this.pendingCreated.id;
    const used = this.members.some((m) => m.n1 === id || m.n2 === id);
    if (!used) {
      const i = this.freeNodes.findIndex((n) => n.id === id);
      if (i >= 0) this.freeNodes.splice(i, 1);
      this.refreshNodes();
    }
    this.pendingCreated = null;
  }

  private bindPointer(): void {
    const canvas = this.ui.canvas;

    const getPos = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return this.scene.worldFromClient(e.clientX, e.clientY, rect);
    };

    canvas.addEventListener(
      'pointerdown',
      (e) => {
        canvas.setPointerCapture(e.pointerId);
        this.pointerDown = true;
        this.downClient = { x: e.clientX, y: e.clientY };
        this.pendingCreated = null;

        if (e.button === 1 || e.button === 2) return;
        if (this.shiftHeld) return;

        if (this.mode === 'bina' || this.mode === 'padam') {
          this.currentWallLane(e.clientX, e.clientY);
        }
        const world = getPos(e);

        if (this.mode === 'padam') {
          this.interacting = true;
          this.scene.setOrbitEnabled(false);
          this.deleteAt(world);
          return;
        }

        if (this.mode === 'bina') {
          const node = this.resolveNode(world, null, true);
          if (node) {
            this.interacting = true;
            this.scene.setOrbitEnabled(false);
            this.dragFrom = node;
            this.scene.highlightNode(node.id);
            this.scene.setGhostNode(null);
          }
        }
      },
      { capture: true },
    );

    canvas.addEventListener('pointermove', (e) => {
      if (!this.pointerDown) {
        if (this.mode === 'bina') this.currentWallLane(e.clientX, e.clientY);
        const world = getPos(e);
        const from = this.stickyNode;
        if (from) {
          const hover = this.resolveNode(world, from, false);
          this.scene.highlightNode(hover?.id ?? from.id);
          if (hover) {
            const valid = this.canPlace(from.id, hover.id);
            this.scene.setPreview(
              { x: from.x, y: from.y },
              { x: hover.x, y: hover.y },
              valid,
              this.selectedShape === 'lengkung',
            );
            this.scene.setGhostNode(null);
          } else {
            const snapped = softSnapToGrid(world.x, world.y);
            this.scene.setPreview(
              { x: from.x, y: from.y },
              snapped,
              false,
              this.selectedShape === 'lengkung',
            );
            this.scene.setGhostNode(snapped);
          }
        } else {
          const hover = this.scene.nearestNode(
            pickableNodes(this.nodes()),
            world,
            NODE_PICK_RADIUS,
          );
          this.scene.highlightNode(hover?.id ?? null);
          this.scene.setPreview(null, null, false);
          if (!hover && this.mode === 'bina') {
            this.scene.setGhostNode(softSnapToGrid(world.x, world.y));
          } else {
            this.scene.setGhostNode(null);
          }
        }
        return;
      }

      if (!this.interacting || !this.dragFrom || this.mode !== 'bina') return;

      this.currentWallLane(e.clientX, e.clientY);
      const world = getPos(e);
      const hover = this.resolveNode(world, this.dragFrom, false);
      this.scene.highlightNode(hover?.id ?? this.dragFrom.id);

      if (hover) {
        const valid = this.canPlace(this.dragFrom.id, hover.id);
        this.scene.setPreview(
          { x: this.dragFrom.x, y: this.dragFrom.y },
          { x: hover.x, y: hover.y },
          valid,
          this.selectedShape === 'lengkung',
        );
        this.scene.setGhostNode(null);
      } else {
        const snapped = softSnapToGrid(world.x, world.y);
        this.scene.setPreview(
          { x: this.dragFrom.x, y: this.dragFrom.y },
          snapped,
          false,
          this.selectedShape === 'lengkung',
        );
        this.scene.setGhostNode(snapped);
      }
    });

    canvas.addEventListener('pointerup', (e) => {
      const wasInteracting = this.interacting;
      const from = this.dragFrom;
      const down = this.downClient;

      this.pointerDown = false;
      this.dragFrom = null;
      this.downClient = null;
      this.interacting = false;
      this.scene.setOrbitEnabled(true);
      this.applyShiftPan();
      this.scene.setPreview(null, null, false);
      this.scene.setGhostNode(null);

      if (!wasInteracting || this.mode !== 'bina' || !from || e.button !== 0) {
        this.discardPendingCreated();
        return;
      }

      const moved =
        down != null &&
        Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX;

      this.currentWallLane(e.clientX, e.clientY);
      const world = getPos(e);

      // Drag to another point — create/connect endpoint
      if (moved) {
        const to = this.resolveNode(world, from, true);
        if (to && to.id !== from.id) {
          this.tryAddMember(from.id, to.id);
          this.stickyNode = null;
          this.scene.highlightNode(null);
          this.pendingCreated = null;
          return;
        }
        this.discardPendingCreated();
        return;
      }

      // Short click: two-click sticky workflow (may place free node as sticky)
      const same = this.scene.nearestNode(
        pickableNodes(this.nodes()),
        world,
        NODE_PICK_RADIUS,
      );
      const clicked = same ?? from;

      if (this.stickyNode && this.stickyNode.id !== clicked.id) {
        this.tryAddMember(this.stickyNode.id, clicked.id);
        this.stickyNode = null;
        this.scene.highlightNode(null);
        this.pendingCreated = null;
      } else if (this.stickyNode && this.stickyNode.id === clicked.id) {
        this.stickyNode = null;
        this.scene.highlightNode(null);
        this.discardPendingCreated();
      } else {
        this.stickyNode = clicked;
        this.scene.highlightNode(clicked.id);
        this.pendingCreated = null; // keep free node as sticky start
        this.flash(
          'Nod dipilih — klik nod kedua (atau ruang kosong) untuk sambung lidi.',
          '',
        );
      }
    });

    canvas.addEventListener('pointercancel', () => {
      this.pointerDown = false;
      this.dragFrom = null;
      this.downClient = null;
      this.interacting = false;
      this.discardPendingCreated();
      this.scene.setOrbitEnabled(true);
      this.applyShiftPan();
      this.scene.setPreview(null, null, false);
      this.scene.setGhostNode(null);
    });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private placeBaseRail(): void {
    if (countBaseRails(this.members) >= BASE_RAIL_TARGET) {
      this.flash(`Sudah ${BASE_RAIL_TARGET} lidi base.`, 'warn');
      return;
    }
    this.pushUndo();
    const placed = addBaseRail(this.gridNodes, this.members);
    if (!placed) {
      this.undoStack.pop();
      this.flash('Tidak dapat menambah base rail.', 'warn');
      return;
    }
    this.invalidateTest();
    this.syncScene();
    this.updateBaseCounter();
    const n = countBaseRails(this.members);
    this.flash(
      `Base lidi panjang (lorong ${placed.lane + 1}/${BASE_RAIL_TARGET}). Base: ${n}/${BASE_RAIL_TARGET}. Klik lagi untuk lorong seterusnya.`,
      n >= BASE_RAIL_TARGET ? 'ok' : '',
    );
  }

  private canPlace(n1: number, n2: number): boolean {
    if (!isAllowedMemberForLength(this.nodes(), n1, n2, this.selectedLength)) {
      return false;
    }
    // Full deck abutment span → next free Z lane (parallel base), not mid-plane duplicate
    if (isAbutmentDeckSpan(this.nodes(), n1, n2)) {
      return nextFreeBaseLane(this.members) != null;
    }
    const wall = this.scene.getActiveWallLane();
    if (this.selectedShape === 'lengkung') {
      return !hasArchBetween(this.members, n1, n2, wall) && !hasMember(this.members, n1, n2, wall);
    }
    return !hasMember(this.members, n1, n2, wall);
  }

  private tryAddMember(n1: number, n2: number): void {
    if (!isAllowedMemberForLength(this.nodes(), n1, n2, this.selectedLength)) {
      this.flash(
        `Panjang tidak sepadan dengan ${this.lengthLabel()}. Cuba Auto, atau + Base untuk lidi penuh.`,
        'warn',
      );
      pruneOrphanFreeNodes(this.members, this.freeNodes);
      this.refreshNodes();
      return;
    }

    // Pin↔roller full span: one parallel base rail per drag (fills next Z lane)
    if (isAbutmentDeckSpan(this.nodes(), n1, n2)) {
      this.placeBaseRail();
      return;
    }

    if (this.selectedShape === 'lengkung') {
      const wall = this.scene.getActiveWallLane();
      if (hasArchBetween(this.members, n1, n2, wall) || hasMember(this.members, n1, n2, wall)) {
        this.flash('Busur / ahli sudah wujud pada dinding ini.', 'warn');
        return;
      }
      this.pushUndo();
      const placed = addArchMember(
        [...this.gridNodes, ...this.freeNodes],
        this.apexNodes,
        this.members,
        n1,
        n2,
        wall,
      );
      if (!placed) {
        this.undoStack.pop();
        this.flash('Gagal menambah lengkung.', 'warn');
        return;
      }
      this.invalidateTest();
      this.refreshNodes();
      this.syncScene();
      this.updateBaseCounter();
      this.flash(
        `Lengkung ditambah (nod puncak + 2 ahli). Jumlah ahli: ${this.members.length}.`,
        'ok',
      );
      return;
    }

    const wall = this.scene.getActiveWallLane();
    if (hasMember(this.members, n1, n2, wall)) {
      this.flash('Ahli sudah wujud pada dinding ini.', 'warn');
      return;
    }
    this.pushUndo();
    addMember(this.members, n1, n2, { shape: 'lurus', zLane: wall });
    this.invalidateTest();
    this.syncScene();
    this.updateBaseCounter();
    const wallLabel = wall === OUTER_LANE_KIRI ? 'Kiri (1)' : 'Kanan (7)';
    this.flash(
      `Lidi ditambah pada dinding ${wallLabel}. Ahli: ${this.members.length}. Base: ${countBaseRails(this.members)}/${BASE_RAIL_TARGET}.`,
      'ok',
    );
  }

  private deleteAt(world: Vec2): void {
    const m = findMemberNearPoint(this.nodes(), this.members, world.x, world.y, 0.28);
    if (!m) {
      this.flash('Tiada lidi berhampiran.', 'warn');
      return;
    }
    this.pushUndo();
    const removed = removeMemberOrArch(this.members, this.apexNodes, m.id);
    pruneOrphanFreeNodes(this.members, this.freeNodes);
    this.invalidateTest();
    this.refreshNodes();
    this.syncScene();
    this.updateBaseCounter();
    const arch = removed.some((r) => r.archGroupId != null);
    const base = removed.some((r) => r.role === 'base');
    this.flash(
      arch
        ? 'Busur lengkung dipadam.'
        : base
          ? `Base rail dipadam. Base: ${countBaseRails(this.members)}/${BASE_RAIL_TARGET}.`
          : 'Lidi dipadam.',
      'ok',
    );
  }

  private setMode(mode: GameMode): void {
    this.mode = mode;
    setActiveMode(this.ui, mode);
    this.stickyNode = null;
    this.scene.highlightNode(null);
    this.scene.setPreview(null, null, false);
    this.scene.setGhostNode(null);

    if (mode === 'bina') {
      this.invalidateTest();
      this.flash(
        'Mod Bina — truss pada lorong 1 & 7 (Kiri/Kanan). Tengah untuk lalu. Tarik = 1 lidi.',
        '',
      );
    } else if (mode === 'padam') {
      this.invalidateTest();
      this.flash('Mod Padam — klik lidi untuk buang.', '');
    }
  }

  private runTest(): void {
    this.mode = 'uji';
    setActiveMode(this.ui, 'uji');

    const nodes = this.nodes();
    const loads = this.buildLoads();
    const initial = solveTruss(nodes, this.members, loads);

    if (!initial.ok && initial.members.length === 0) {
      renderResultPanel(this.ui.resultPanel, {
        tip: TIP_MS,
        statusHtml: initial.message ?? 'Ujian gagal — tiada ahli.',
        statusClass: 'bad',
      });
      this.lastResults = null;
      this.tested = false;
      this.syncScene();
      return;
    }

    const prog = progressiveFailure(nodes, this.members, loads);

    // Keep first-step stress colours for display even after snaps
    const displayResults =
      prog.steps[0]?.members?.length
        ? prog.steps[0]!.members
        : initial.members.length
          ? initial.members
          : prog.final.members;

    if (prog.removedIds.length > 0) {
      this.pushUndo();
      for (const id of prog.removedIds) {
        removeMemberById(this.members, id);
      }
      promoteBaseRails(this.members);
      pruneOrphanApexes(this.members, this.apexNodes);
      pruneOrphanFreeNodes(this.members, this.freeNodes);
      this.refreshNodes();
      this.updateBaseCounter();
    }

    this.lastResults = displayResults;
    this.tested = true;
    this.syncScene(true);
    this.updateLoadArrow();

    const first = prog.steps[0] ?? initial;
    const crit = first.criticalMemberId;
    const critRes = first.members.find((m) => m.id === crit);
    const forceStr = critRes
      ? `${critRes.force >= 0 ? 'Tegangan' : 'Mampatan'} ${Math.abs(critRes.force).toFixed(1)} (u=${critRes.utilization.toFixed(2)})`
      : '—';

    const broken = prog.removedIds;
    let statusClass: 'ok' | 'warn' | 'bad' = 'ok';
    let msg: string;

    if (broken.length > 0) {
      statusClass = prog.collapsed ? 'bad' : 'warn';
      const ids = broken.slice(0, 5).map((id) => `#${id}`).join(', ');
      msg = prog.collapsed
        ? `Runtuh! Patah pada lidi ${ids}${broken.length > 5 ? '…' : ''}. Lidi gelap merah = titik lemah.`
        : `Patah pada lidi ${ids}${broken.length > 5 ? '…' : ''}! Lidi gelap merah = paling kritikal.`;
    } else if (first.stabilized) {
      statusClass = first.maxUtilization >= 0.85 ? 'bad' : 'warn';
      msg =
        crit != null
          ? `Struktur lemah / kurang brace — tegasan tertinggi pada lidi #${crit}. Tambah segi tiga!`
          : (first.message ?? 'Struktur lemah — lihat warna tegasan.');
    } else if (first.maxUtilization >= 1) {
      statusClass = 'bad';
      msg = crit != null ? `Luluh! Kritikal lidi #${crit}.` : 'Ahli melebihi kapasiti.';
    } else if (first.maxUtilization >= 0.85) {
      statusClass = 'warn';
      msg = `Hampir had! u=${first.maxUtilization.toFixed(2)} — kritikal lidi #${crit ?? '—'}.`;
    } else {
      msg = `Lulus! Utilisasi maks u=${first.maxUtilization.toFixed(2)}.`;
    }

    renderResultPanel(this.ui.resultPanel, {
      tip: TIP_MS,
      statusHtml: msg,
      statusClass,
      meta: `Beban=${this.loadMagnitude} ↓. Kritikal: ${forceStr}. Base: ${countBaseRails(this.members)}/${BASE_RAIL_TARGET} (kongsi beban). Digugurkan: ${broken.length}.`,
    });
  }

  private buildLoads(): Map<number, Vec2> {
    const loads = new Map<number, Vec2>();
    loads.set(this.loadNodeId, { x: 0, y: -this.loadMagnitude });
    return loads;
  }

  private invalidateTest(): void {
    this.tested = false;
    this.lastResults = null;
    this.syncScene();
    this.updateLoadArrow();
  }

  private pushUndo(): void {
    this.undoStack.push({
      members: cloneMembers(this.members),
      apexes: cloneApexNodes(this.apexNodes),
      free: cloneFreeNodes(this.freeNodes),
    });
    if (this.undoStack.length > 50) this.undoStack.shift();
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) {
      this.flash('Tiada tindakan untuk undo.', 'warn');
      return;
    }
    this.members = prev.members;
    this.apexNodes = prev.apexes;
    this.freeNodes = prev.free;
    this.invalidateTest();
    this.refreshNodes();
    this.updateBaseCounter();
    this.flash('Undo berjaya.', 'ok');
  }

  private reset(): void {
    this.pushUndo();
    this.members = [];
    this.apexNodes = [];
    this.freeNodes = [];
    resetMemberIds();
    this.loadMagnitude = defaultLevel.defaultLoad;
    this.ui.loadSlider.value = String(this.loadMagnitude);
    this.ui.loadVal.textContent = String(this.loadMagnitude);
    this.invalidateTest();
    this.refreshNodes();
    this.updateBaseCounter();
    this.setMode('bina');
    this.flash('Reset — mula bina semula. + Base = 1 lidi/lorong (ulang hingga 7).', 'ok');
  }

  private syncScene(highlightFailed = false): void {
    this.scene.syncMembers(
      this.nodes(),
      this.members,
      this.tested ? this.lastResults : null,
      highlightFailed,
    );
    this.updateLoadArrow();
  }

  private updateLoadArrow(): void {
    const node = findNodeById(this.nodes(), this.loadNodeId);
    this.scene.setLoadArrow(node, this.loadMagnitude, true);
  }

  private flash(msg: string, cls: 'ok' | 'warn' | 'bad' | ''): void {
    renderResultPanel(this.ui.resultPanel, {
      tip: TIP_MS,
      statusHtml: msg,
      statusClass: cls,
      meta: `Ahli: ${this.members.length} · Base: ${countBaseRails(this.members)}/${BASE_RAIL_TARGET} · Dinding: ${this.wallMode} · Lidi: ${this.lengthLabel()} · ${this.selectedShape === 'lengkung' ? 'Lengkung' : 'Lurus'} · Beban: ${this.loadMagnitude}`,
    });
  }

  private showIdleTip(): void {
    this.flash(
      'Truss pada lorong 1 dan 7 (tepi). Tengah untuk lalu. + Base = deck; Uji = patah.',
      '',
    );
  }

  private onResize(): void {
    const canvas = this.ui.canvas;
    const parent = canvas.parentElement!;
    const toolbar = this.ui.root.querySelector('.toolbar') as HTMLElement;
    const panel = this.ui.resultPanel;
    const w = parent.clientWidth;
    const h = Math.max(
      200,
      parent.clientHeight - toolbar.offsetHeight - panel.offsetHeight,
    );
    const pr = Math.min(devicePixelRatio, 2);
    canvas.width = Math.floor(w * pr);
    canvas.height = Math.floor(h * pr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    this.scene.resize(w, h);
  }
}
