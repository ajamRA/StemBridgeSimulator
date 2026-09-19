import {
  COMPRESSION_CAPACITY,
  DEFAULT_LOAD,
  TENSION_CAPACITY,
} from '../engine/constants';
import { progressiveFailure } from '../engine/failure';
import {
  addArchMember,
  addMember,
  allNodes,
  cloneApexNodes,
  cloneMembers,
  findMemberNearPoint,
  findNodeById,
  hasArchBetween,
  hasMember,
  isAllowedMemberForLength,
  pickableNodes,
  pruneOrphanApexes,
  removeMemberById,
  removeMemberOrArch,
  resetMemberIds,
  type StickLengthPreset,
} from '../engine/model';
import { solveTruss } from '../engine/solver';
import type {
  GameMode,
  MemberDef,
  MemberResult,
  NodeDef,
  StickShape,
  Vec2,
} from '../engine/types';
import { createLevelState, defaultLevel } from '../levels';
import { BridgeScene } from '../scene/BridgeScene';
import {
  mountUI,
  renderResultPanel,
  setActiveLength,
  setActiveMode,
  setActiveShape,
  type UIHandles,
} from '../ui/dom';
import * as THREE from 'three';

/** Pixels of movement before a pointer gesture counts as orbit/drag (not a click). */
const CLICK_SLOP_PX = 6;

const TIP_MS =
  'Tip: Base: pilih Panjang. Sokongan: pilih Pendek. Lengkung sesuai untuk busur/arch di bahagian atas atau geladak (auto nod puncak + 2 ahli axial).';

interface BuildSnapshot {
  members: MemberDef[];
  apexes: NodeDef[];
}

export class Game {
  private ui: UIHandles;
  private scene: BridgeScene;
  /** Fixed snap-grid nodes (supports + deck). */
  private gridNodes: NodeDef[];
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
  private selectedLength: StickLengthPreset = 3;
  private selectedShape: StickShape = 'lurus';

  private dragFrom: NodeDef | null = null;
  private pointerDown = false;
  private interacting = false; // build/delete gesture — orbit locked
  private downClient: { x: number; y: number } | null = null;
  private stickyNode: NodeDef | null = null;
  private shiftHeld = false;

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

    this.refreshNodes();
    this.syncScene();
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
    return allNodes(this.gridNodes, this.apexNodes);
  }

  private refreshNodes(): void {
    this.scene.setNodes(this.nodes());
  }

  private bindUI(): void {
    this.ui.btnBina.addEventListener('click', () => this.setMode('bina'));
    this.ui.btnUji.addEventListener('click', () => this.runTest());
    this.ui.btnPadam.addEventListener('click', () => this.setMode('padam'));
    this.ui.btnUndo.addEventListener('click', () => this.undo());
    this.ui.btnReset.addEventListener('click', () => this.reset());
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
        else if (raw === '1' || raw === '2' || raw === '3') {
          this.selectedLength = Number(raw) as 1 | 2 | 3;
        } else return;
        setActiveLength(this.ui, this.selectedLength);
        this.flash(
          `Panjang lidi: ${this.lengthLabel()}. Base → Panjang, sokongan → Pendek.`,
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

  private lengthLabel(): string {
    switch (this.selectedLength) {
      case 1:
        return 'Pendek (1)';
      case 2:
        return 'Sederhana (2)';
      case 3:
        return 'Panjang (3)';
      default:
        return 'Auto';
    }
  }

  /** Shift+left-drag pans (standard OrbitControls companion to right-drag pan). */
  private applyShiftPan(): void {
    if (this.interacting) return;
    this.scene.controls.mouseButtons.LEFT = this.shiftHeld
      ? THREE.MOUSE.PAN
      : THREE.MOUSE.ROTATE;
  }

  /**
   * Snap only to pickable grid nodes. When `from` is set (second endpoint),
   * restrict to targets valid for the selected stick length.
   */
  private nearestBuildNode(world: Vec2, from: NodeDef | null): NodeDef | null {
    const candidates = pickableNodes(this.gridNodes);
    if (!from) {
      return this.scene.nearestNode(candidates, world);
    }
    const valid = candidates.filter(
      (n) =>
        n.id !== from.id &&
        isAllowedMemberForLength(
          this.gridNodes,
          from.id,
          n.id,
          this.selectedLength,
        ) &&
        !hasMember(this.members, from.id, n.id) &&
        !(
          this.selectedShape === 'lengkung' &&
          hasArchBetween(this.members, from.id, n.id)
        ),
    );
    return this.scene.nearestNode(valid, world, 0.65);
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

        if (e.button === 1 || e.button === 2) return;
        if (this.shiftHeld) return;

        const world = getPos(e);

        if (this.mode === 'padam') {
          this.interacting = true;
          this.scene.setOrbitEnabled(false);
          this.deleteAt(world);
          return;
        }

        if (this.mode === 'bina') {
          const node = this.nearestBuildNode(world, null);
          if (node) {
            this.interacting = true;
            this.scene.setOrbitEnabled(false);
            this.dragFrom = node;
            this.scene.highlightNode(node.id);
          }
        }
      },
      { capture: true },
    );

    canvas.addEventListener('pointermove', (e) => {
      if (!this.pointerDown) {
        const world = getPos(e);
        const from = this.stickyNode;
        const hover = this.nearestBuildNode(world, from);
        this.scene.highlightNode(hover?.id ?? this.stickyNode?.id ?? null);
        if (from && hover) {
          const valid = this.canPlace(from.id, hover.id);
          this.scene.setPreview(
            { x: from.x, y: from.y },
            { x: hover.x, y: hover.y },
            valid,
            this.selectedShape === 'lengkung',
          );
        } else if (!from) {
          this.scene.setPreview(null, null, false);
        }
        return;
      }

      if (!this.interacting || !this.dragFrom || this.mode !== 'bina') return;

      const world = getPos(e);
      const hover = this.nearestBuildNode(world, this.dragFrom);
      this.scene.highlightNode(hover?.id ?? this.dragFrom.id);

      if (hover) {
        const valid = this.canPlace(this.dragFrom.id, hover.id);
        this.scene.setPreview(
          { x: this.dragFrom.x, y: this.dragFrom.y },
          { x: hover.x, y: hover.y },
          valid,
          this.selectedShape === 'lengkung',
        );
      } else {
        this.scene.setPreview(null, null, false);
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

      if (!wasInteracting || this.mode !== 'bina' || !from || e.button !== 0) {
        return;
      }

      const moved =
        down != null &&
        Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX;

      const world = getPos(e);
      const to = this.nearestBuildNode(world, from);

      if (to && to.id !== from.id) {
        this.tryAddMember(from.id, to.id);
        this.stickyNode = null;
        this.scene.highlightNode(null);
        return;
      }

      // Short click on same node → two-click sticky workflow
      const same = this.nearestBuildNode(world, null);
      if (same && same.id === from.id && !moved) {
        if (this.stickyNode && this.stickyNode.id !== same.id) {
          this.tryAddMember(this.stickyNode.id, same.id);
          this.stickyNode = null;
          this.scene.highlightNode(null);
        } else if (this.stickyNode && this.stickyNode.id === same.id) {
          this.stickyNode = null;
          this.scene.highlightNode(null);
        } else {
          this.stickyNode = same;
          this.scene.highlightNode(same.id);
        }
      }
    });

    canvas.addEventListener('pointercancel', () => {
      this.pointerDown = false;
      this.dragFrom = null;
      this.downClient = null;
      this.interacting = false;
      this.scene.setOrbitEnabled(true);
      this.applyShiftPan();
      this.scene.setPreview(null, null, false);
    });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private canPlace(n1: number, n2: number): boolean {
    if (
      !isAllowedMemberForLength(
        this.gridNodes,
        n1,
        n2,
        this.selectedLength,
      )
    ) {
      return false;
    }
    if (this.selectedShape === 'lengkung') {
      return !hasArchBetween(this.members, n1, n2) && !hasMember(this.members, n1, n2);
    }
    return !hasMember(this.members, n1, n2);
  }

  private tryAddMember(n1: number, n2: number): void {
    if (
      !isAllowedMemberForLength(
        this.gridNodes,
        n1,
        n2,
        this.selectedLength,
      )
    ) {
      this.flash(
        `Panjang tidak sepadan dengan ${this.lengthLabel()} (atau pepenjuru tidak dibenarkan).`,
        'warn',
      );
      return;
    }

    if (this.selectedShape === 'lengkung') {
      if (hasArchBetween(this.members, n1, n2) || hasMember(this.members, n1, n2)) {
        this.flash('Busur / ahli sudah wujud pada nod ini.', 'warn');
        return;
      }
      this.pushUndo();
      const placed = addArchMember(
        this.gridNodes,
        this.apexNodes,
        this.members,
        n1,
        n2,
      );
      if (!placed) {
        this.undoStack.pop();
        this.flash('Gagal menambah lengkung.', 'warn');
        return;
      }
      this.invalidateTest();
      this.refreshNodes();
      this.syncScene();
      this.flash(
        `Lengkung ditambah (nod puncak + 2 ahli). Jumlah ahli: ${this.members.length}.`,
        'ok',
      );
      return;
    }

    if (hasMember(this.members, n1, n2)) {
      this.flash('Ahli sudah wujud.', 'warn');
      return;
    }
    this.pushUndo();
    addMember(this.members, n1, n2, { shape: 'lurus' });
    this.invalidateTest();
    this.syncScene();
    this.flash(
      `Lidi lurus ditambah pada kedua-dua sisi 3D (${this.members.length} ahli).`,
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
    this.invalidateTest();
    this.refreshNodes();
    this.syncScene();
    const arch = removed.some((r) => r.archGroupId != null);
    this.flash(
      arch ? 'Busur lengkung dipadam (kedua-dua kaki + puncak).' : 'Lidi dipadam (kedua-dua sisi).',
      'ok',
    );
  }

  private setMode(mode: GameMode): void {
    this.mode = mode;
    setActiveMode(this.ui, mode);
    this.stickyNode = null;
    this.scene.highlightNode(null);
    this.scene.setPreview(null, null, false);

    if (mode === 'bina') {
      this.invalidateTest();
      this.flash(
        'Mod Bina — klik dua nod (auto-cermin 3D). Seret kiri = orbit kamera.',
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
    if (!initial.ok && !initial.singular) {
      renderResultPanel(this.ui.resultPanel, {
        tip: TIP_MS,
        statusHtml: initial.message ?? 'Ujian gagal.',
        statusClass: 'bad',
      });
      this.lastResults = null;
      this.tested = false;
      this.syncScene();
      return;
    }

    const prog = progressiveFailure(nodes, this.members, loads);

    if (prog.removedIds.length > 0) {
      this.pushUndo();
      for (const id of prog.removedIds) {
        removeMemberById(this.members, id);
      }
      pruneOrphanApexes(this.members, this.apexNodes);
      this.refreshNodes();
    }

    this.lastResults = prog.final.ok
      ? prog.final.members
      : initial.members.length
        ? initial.members
        : prog.steps[0]?.members ?? [];
    this.tested = true;
    this.syncScene(true);
    this.updateLoadArrow();

    if (prog.final.singular || prog.collapsed) {
      renderResultPanel(this.ui.resultPanel, {
        tip: TIP_MS,
        statusHtml:
          prog.final.message ??
          'Struktur tidak stabil! Perlu segi tiga pada satah XY (brace Near↔Far hanya visual).',
        statusClass: 'bad',
        meta: `Ahli digugurkan: ${prog.removedIds.length}. Kapasiti: T=${TENSION_CAPACITY}, C=${COMPRESSION_CAPACITY}.`,
      });
      return;
    }

    if (!prog.final.ok) {
      renderResultPanel(this.ui.resultPanel, {
        tip: TIP_MS,
        statusHtml: prog.final.message ?? 'Ujian gagal.',
        statusClass: 'bad',
      });
      return;
    }

    const u = prog.final.maxUtilization;
    const crit = prog.final.criticalMemberId;
    const critRes = prog.final.members.find((m) => m.id === crit);
    const forceStr = critRes
      ? `${critRes.force >= 0 ? 'Tegangan' : 'Mampatan'} ${Math.abs(critRes.force).toFixed(1)}`
      : '—';

    let statusClass: 'ok' | 'warn' | 'bad' = 'ok';
    let msg = `Lulus! Utilisasi maks u=${u.toFixed(2)}`;
    if (prog.removedIds.length > 0 && u < 1) {
      statusClass = 'warn';
      msg = `Sesetengah ahli gagal lalu digugurkan. Baki u=${u.toFixed(2)}`;
    } else if (u >= 0.85) {
      statusClass = 'warn';
      msg = `Hampir had! u=${u.toFixed(2)} — kurangkan beban atau tambah ahli.`;
    }

    const firstFailed = prog.steps[0]?.members.some((m) => m.failed);
    if (firstFailed && prog.removedIds.length > 0) {
      statusClass = prog.collapsed ? 'bad' : 'warn';
    }

    renderResultPanel(this.ui.resultPanel, {
      tip: TIP_MS,
      statusHtml: msg,
      statusClass,
      meta: `Beban=${this.loadMagnitude} ↓ pada nod geladak. Kritikal: ${forceStr}. Langkah: ${prog.steps.length}. Fizik: DSM 2D (sisi cermin visual).`,
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
    this.invalidateTest();
    this.refreshNodes();
    this.flash('Undo berjaya.', 'ok');
  }

  private reset(): void {
    this.pushUndo();
    this.members = [];
    this.apexNodes = [];
    resetMemberIds();
    this.loadMagnitude = defaultLevel.defaultLoad;
    this.ui.loadSlider.value = String(this.loadMagnitude);
    this.ui.loadVal.textContent = String(this.loadMagnitude);
    this.invalidateTest();
    this.refreshNodes();
    this.setMode('bina');
    this.flash('Reset — mula bina semula.', 'ok');
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
      meta: `Ahli: ${this.members.length} · Lidi: ${this.lengthLabel()} · ${this.selectedShape === 'lengkung' ? 'Lengkung' : 'Lurus'} · Beban: ${this.loadMagnitude}`,
    });
  }

  private showIdleTip(): void {
    this.flash(
      'Mod Bina — klik dua nod (lidi cermin ke Near/Far). Pilih Panjang untuk base, Pendek untuk sokongan.',
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
