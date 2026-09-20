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
  addTransverseMember,
  allNodes,
  cloneApexNodes,
  cloneFreeNodes,
  cloneMembers,
  countBaseRails,
  ensureWallMembersStructural,
  findMemberNearPoint,
  isAbutmentDeckSpan,
  findNodeById,
  findOrCreateNodeNear,
  hasArchBetween,
  hasMember,
  hasTransverse,
  isAllowedMemberForLength,
  nextFreeBaseLane,
  pickableNodes,
  pruneOrphanApexes,
  promoteBaseRails,
  pruneOrphanFreeNodes,
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
  'Uji: satu lidi paling kritikal patah (bukan semua). Melintang = Kiri↔Kanan. + Base = 1 lorong.';

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
  private lastDisplacements: Map<number, Vec2> | null = null;
  private tested = false;
  /** True while snap/fall anim plays before members are removed. */
  private breakingInProgress = false;

  /** Default Panjang for base-first classroom workflow. */
  private selectedLength: StickLengthPreset = 'panjang';
  private selectedShape: StickShape = 'lurus';
  private wallMode: WallMode = 'lantai';

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
    this.ui.chkLenturan.addEventListener('change', () => {
      const on = this.ui.chkLenturan.checked;
      if (this.tested && this.lastDisplacements) {
        this.scene.setDeformation(this.lastDisplacements, on);
        this.refreshNodes();
        this.syncScene(true);
        this.flash(
          on
            ? 'Lenturan HIDUP — lidi nampak melentur selepas Uji.'
            : 'Lenturan MATI — warna tegasan sahaja.',
          '',
        );
      } else {
        this.flash(
          on
            ? 'Tunjuk lenturan akan aktif selepas Uji.'
            : 'Lenturan dimatikan.',
          '',
        );
      }
    });
    this.ui.loadSlider.addEventListener('input', () => {
      this.loadMagnitude = Number(this.ui.loadSlider.value);
      this.ui.loadVal.textContent = String(this.loadMagnitude);
      this.ui.loadSlider.setAttribute('aria-valuenow', String(this.loadMagnitude));
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
        if (
          raw !== 'lantai' &&
          raw !== 'kiri' &&
          raw !== 'kanan' &&
          raw !== 'melintang' &&
          raw !== 'merintang' &&
          raw !== 'auto'
        ) {
          return;
        }
        // Legacy alias: merintang → melintang
        this.wallMode = raw === 'merintang' ? 'melintang' : raw;
        this.stickyNode = null;
        this.scene.highlightNode(null);
        this.scene.setPreview(null, null, false);
        this.scene.setGhostNode(null);
        setActiveWall(this.ui, this.wallMode);
        this.scene.setWallMode(this.wallMode);
        this.refreshNodes();
        this.syncScene();
        const label =
          raw === 'lantai'
            ? 'Lantai — deck 12×7 (dinding disembunyikan)'
            : raw === 'kiri'
              ? 'Dinding kiri (lorong 1)'
              : raw === 'kanan'
                ? 'Dinding kanan (lorong 7)'
                : raw === 'melintang' || raw === 'merintang'
                  ? 'Melintang (Kiri↔Kanan) — klik nod pada mana-mana ketinggian, kemudian nod sepadan'
                  : 'Auto — dinding luar terdekat';
        this.flash(
          raw === 'melintang' || raw === 'merintang'
            ? `${label}. Satu lidi melintang merentas laluan Z — semua nod dinding boleh dipilih.`
            : raw === 'lantai'
              ? `${label}. + Base / tarik pin↔roller = lidi panjang. ${TIP_MS}`
              : `Fokus: ${label}. Lapisan lain redup.`,
          '',
        );
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
    if (this.wallMode === 'melintang' || this.wallMode === 'lantai') {
      return OUTER_LANE_KIRI;
    }
    if (this.wallMode === 'auto' && clientX != null && clientY != null) {
      const rect = this.ui.canvas.getBoundingClientRect();
      return this.scene.resolveWallFromClient(clientX, clientY, rect);
    }
    if (this.wallMode === 'kanan') return OUTER_LANE_KANAN;
    return OUTER_LANE_KIRI;
  }

  /** Nodes pickable on the active edit-focus layer only. */
  private pickableForMode(): NodeDef[] {
    const all = pickableNodes(this.nodes());
    if (this.wallMode === 'lantai') {
      return all.filter((n) => n.isDeck || Math.abs(n.y) < 1e-6);
    }
    // Wall / melintang: all XY joints (walls share XY); magnets declutter via scene.
    return all;
  }

  /** Members considered for delete / near-pick on the active layer. */
  private membersForActiveLayer(): MemberDef[] {
    switch (this.wallMode) {
      case 'lantai':
        return this.members.filter((m) => m.role === 'base');
      case 'kiri':
        return this.members.filter(
          (m) =>
            m.role !== 'transverse' &&
            m.role !== 'base' &&
            (m.zLane === OUTER_LANE_KIRI || m.zLane == null),
        );
      case 'kanan':
        return this.members.filter(
          (m) =>
            m.role !== 'transverse' &&
            m.role !== 'base' &&
            m.zLane === OUTER_LANE_KANAN,
        );
      case 'melintang':
        return this.members.filter((m) => m.role === 'transverse');
      default:
        return this.members;
    }
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
    const candidates = this.pickableForMode();
    // Lantai: stay on deck plane (y=0) for create/snap
    const planeWorld =
      this.wallMode === 'lantai' ? { x: world.x, y: 0 } : world;
    if (!from) {
      const near = this.scene.nearestNode(candidates, planeWorld, NODE_PICK_RADIUS);
      if (near) return near;
      // Melintang: only existing wall-grid nodes (all heights, both outer walls)
      if (this.wallMode === 'melintang') return null;
      if (!allowCreate) return null;
      if (this.wallMode === 'lantai') {
        // Deck edit: only snap to existing deck magnets — no free mid-air joints
        return this.scene.nearestNode(candidates, planeWorld, SOFT_SNAP * 1.5);
      }
      const { node, created } = findOrCreateNodeNear(
        this.gridNodes,
        this.freeNodes,
        this.apexNodes,
        planeWorld,
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
    const nearValid = this.scene.nearestNode(validExisting, planeWorld, NODE_PICK_RADIUS);
    if (nearValid) return nearValid;

    const nearAny = this.scene.nearestNode(
      candidates.filter((n) => n.id !== from.id),
      planeWorld,
      NODE_PICK_RADIUS,
    );
    if (nearAny) return nearAny;

    if (!allowCreate) return null;
    if (this.wallMode === 'lantai' || this.wallMode === 'melintang') return null;
    const { node, created } = findOrCreateNodeNear(
      this.gridNodes,
      this.freeNodes,
      this.apexNodes,
      planeWorld,
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
          } else if (this.wallMode === 'melintang') {
            // Preview pure cross-brace at sticky XY across the roadway
            this.scene.setPreview(
              { x: from.x, y: from.y },
              { x: from.x, y: from.y },
              this.canPlace(from.id, from.id),
              false,
            );
            this.scene.setGhostNode(null);
          } else {
            const snapped =
              this.wallMode === 'lantai'
                ? softSnapToGrid(world.x, 0)
                : softSnapToGrid(world.x, world.y);
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
            this.pickableForMode(),
            world,
            NODE_PICK_RADIUS,
          );
          this.scene.highlightNode(hover?.id ?? null);
          this.scene.setPreview(null, null, false);
          if (
            !hover &&
            this.mode === 'bina' &&
            this.wallMode !== 'melintang'
          ) {
            const g =
              this.wallMode === 'lantai'
                ? softSnapToGrid(world.x, 0)
                : softSnapToGrid(world.x, world.y);
            this.scene.setGhostNode(g);
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
      } else if (this.wallMode === 'melintang') {
        this.scene.setPreview(
          { x: this.dragFrom.x, y: this.dragFrom.y },
          { x: this.dragFrom.x, y: this.dragFrom.y },
          this.canPlace(this.dragFrom.id, this.dragFrom.id),
          false,
        );
        this.scene.setGhostNode(null);
      } else {
        const snapped =
          this.wallMode === 'lantai'
            ? softSnapToGrid(world.x, 0)
            : softSnapToGrid(world.x, world.y);
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
        this.pickableForMode(),
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
        // Melintang one-click helper: second click on same XY = pure cross-brace
        if (this.wallMode === 'melintang') {
          this.tryAddTransverse(clicked.id, clicked.id);
          this.stickyNode = null;
          this.scene.highlightNode(null);
          this.pendingCreated = null;
        } else {
          this.stickyNode = null;
          this.scene.highlightNode(null);
          this.discardPendingCreated();
        }
      } else {
        this.stickyNode = clicked;
        this.scene.highlightNode(clicked.id);
        this.pendingCreated = null; // keep free node as sticky start
        this.flash(
          this.wallMode === 'melintang'
            ? 'Nod dipilih — klik nod sepadan pada dinding lain (atau klik semula untuk melintang lurus Z).'
            : 'Nod dipilih — klik nod kedua (atau ruang kosong) untuk sambung lidi.',
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
    if (this.wallMode === 'melintang') {
      return !hasTransverse(
        this.members,
        n1,
        n2,
        OUTER_LANE_KIRI,
        OUTER_LANE_KANAN,
      );
    }
    if (this.wallMode === 'lantai') {
      // Deck focus: full abutment span → next base rail; otherwise refuse wall braces
      if (n1 === n2) return false;
      return isAbutmentDeckSpan(this.nodes(), n1, n2)
        ? nextFreeBaseLane(this.members) != null
        : false;
    }
    if (n1 === n2) return false;
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

  /** Place one Melintang stick Kiri(lane0) ↔ Kanan(lane6). Same XY allowed. */
  private tryAddTransverse(n1: number, n2: number): void {
    if (hasTransverse(this.members, n1, n2, OUTER_LANE_KIRI, OUTER_LANE_KANAN)) {
      this.flash('Melintang sudah wujud antara nod ini.', 'warn');
      return;
    }
    // Prefer near-matching XY; allow skewed braces but warn if far
    const a = findNodeById(this.nodes(), n1);
    const b = findNodeById(this.nodes(), n2);
    if (!a || !b) return;
    const dxy = Math.hypot(b.x - a.x, b.y - a.y);
    if (dxy > 2.5) {
      this.flash(
        'Nod terlalu jauh dalam XY — pilih nod sama/dekat pada dinding lain (atau klik semula nod yang sama).',
        'warn',
      );
      return;
    }
    this.pushUndo();
    const placed = addTransverseMember(
      this.members,
      n1,
      n2,
      OUTER_LANE_KIRI,
      OUTER_LANE_KANAN,
    );
    if (!placed) {
      this.undoStack.pop();
      this.flash('Gagal menambah melintang.', 'warn');
      return;
    }
    this.invalidateTest();
    this.syncScene();
    this.updateBaseCounter();
    const same = n1 === n2 || dxy < 1e-6;
    this.flash(
      same
        ? `Melintang ditambah merentas laluan (nod #${n1}). Dua dinding kini bersambung.`
        : `Melintang condong ditambah (#${n1}↔#${n2}). Ahli: ${this.members.length}.`,
      'ok',
    );
  }

  private tryAddMember(n1: number, n2: number): void {
    if (this.wallMode === 'melintang') {
      this.tryAddTransverse(n1, n2);
      return;
    }

    if (this.wallMode === 'lantai') {
      if (isAbutmentDeckSpan(this.nodes(), n1, n2)) {
        this.placeBaseRail();
        return;
      }
      this.flash(
        'Mod Lantai — guna + Base atau tarik pin↔roller untuk lidi panjang. Tukar ke Dinding kiri/kanan untuk brace.',
        'warn',
      );
      return;
    }

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
    const layerMembers = this.membersForActiveLayer();
    const pool = layerMembers.length ? layerMembers : this.members;
    const m = findMemberNearPoint(this.nodes(), pool, world.x, world.y, 0.28);
    if (!m) {
      this.flash('Tiada lidi pada lapisan aktif berhampiran.', 'warn');
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
    if (this.breakingInProgress && mode !== 'uji') {
      this.scene.cancelBreakAnims(true); // finish removal via callback
    }
    this.mode = mode;
    setActiveMode(this.ui, mode);
    this.stickyNode = null;
    this.scene.highlightNode(null);
    this.scene.setPreview(null, null, false);
    this.scene.setGhostNode(null);

    if (mode === 'bina') {
      this.invalidateTest();
      this.flash(
        'Mod Bina — Edit fokus: Lantai / Dinding kiri / Dinding kanan / Melintang.',
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
    this.scene.cancelBreakAnims(false);
    this.breakingInProgress = false;
    this.scene.clearPulse();

    // Legacy builds may have marked the second wall visualOnly — promote both walls.
    ensureWallMembersStructural(this.members);

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
      this.lastDisplacements = null;
      this.tested = false;
      this.scene.clearDeformation();
      this.syncScene();
      return;
    }

    // Default: one clear patah (worst stick only) — not a full cascade
    const prog = progressiveFailure(nodes, this.members, loads, {
      maxBreaks: 1,
      continuous: false,
    });

    // Keep first-step stress colours + displacements for lenturan display
    const first = prog.steps[0] ?? initial;
    const displayResults =
      first.members.length
        ? first.members
        : initial.members.length
          ? initial.members
          : prog.final.members;

    this.lastResults = displayResults;
    this.lastDisplacements = first.displacements;
    this.tested = true;

    const showLentur = this.ui.chkLenturan.checked;
    this.scene.setDeformation(this.lastDisplacements, showLentur);
    this.refreshNodes();
    this.syncScene(true);
    this.updateLoadArrow();

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
      const ids = broken.map((id) => `#${id}`).join(', ');
      msg = prog.collapsed
        ? `Runtuh! Lidi kritikal ${ids} patah — struktur tidak lagi berdiri.`
        : `Patah! Lidi kritikal ${ids} putus (merah). Lidi lain kekal — tekan Uji lagi untuk patah seterusnya.`;
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
      msg = `Lulus! Utilisasi maks u=${first.maxUtilization.toFixed(2)}.${showLentur ? ' (lidi melentur di bawah beban)' : ''}`;
    }

    // Pulse critical / broken members in the scene
    const pulseIds = broken.length > 0 ? broken.slice() : crit != null ? [crit] : [];
    if (pulseIds.length) this.scene.pulseMembers(pulseIds);

    renderResultPanel(this.ui.resultPanel, {
      tip: TIP_MS,
      statusHtml: msg,
      statusClass,
      meta: `Beban=${this.loadMagnitude} ↓. Kritikal: ${forceStr}. Base: ${countBaseRails(this.members)}/${BASE_RAIL_TARGET} (kongsi beban). Digugurkan: ${broken.length}.${showLentur ? ' Lenturan ON.' : ''}`,
    });

    // Break feedback: flash / snap / fall BEFORE removing from model
    if (broken.length > 0) {
      this.breakingInProgress = true;
      this.scene.animateBreaks(broken, () => {
        this.breakingInProgress = false;
        this.pushUndo();
        for (const id of broken) {
          // Whole Lengkung if a leg fails; otherwise single member
          removeMemberOrArch(this.members, this.apexNodes, id);
        }
        promoteBaseRails(this.members);
        pruneOrphanApexes(this.members, this.apexNodes);
        pruneOrphanFreeNodes(this.members, this.freeNodes);
        // Keep lenturan on remaining structure
        this.scene.setDeformation(this.lastDisplacements, this.ui.chkLenturan.checked);
        this.refreshNodes();
        this.syncScene(true);
        this.updateBaseCounter();
        this.scene.clearPulse();
      });
    }
  }

  private buildLoads(): Map<number, Vec2> {
    const loads = new Map<number, Vec2>();
    loads.set(this.loadNodeId, { x: 0, y: -this.loadMagnitude });
    return loads;
  }

  private invalidateTest(): void {
    this.scene.cancelBreakAnims(false);
    this.breakingInProgress = false;
    this.scene.clearPulse();
    this.scene.clearDeformation();
    this.tested = false;
    this.lastResults = null;
    this.lastDisplacements = null;
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
      meta: `Ahli: ${this.members.length} · Base: ${countBaseRails(this.members)}/${BASE_RAIL_TARGET} · Fokus: ${this.wallMode} · Lidi: ${this.lengthLabel()} · ${this.selectedShape === 'lengkung' ? 'Lengkung' : 'Lurus'} · Beban: ${this.loadMagnitude}`,
    });
  }

  private showIdleTip(): void {
    this.flash(
      'Uji: lidi melentur; patah nampak putus dulu, bukan hilang terus. + Base = deck.',
      '',
    );
  }

  private onResize(): void {
    const canvas = this.ui.canvas;
    const wrap = this.ui.canvasWrap;
    const w = Math.max(1, wrap.clientWidth);
    const h = Math.max(200, wrap.clientHeight);
    const pr = Math.min(devicePixelRatio, 2);
    canvas.width = Math.floor(w * pr);
    canvas.height = Math.floor(h * pr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    this.scene.resize(w, h);
  }
}
