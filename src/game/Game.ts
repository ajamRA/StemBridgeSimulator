import {
  COMPRESSION_CAPACITY,
  DEFAULT_LOAD,
  TENSION_CAPACITY,
} from '../engine/constants';
import { progressiveFailure } from '../engine/failure';
import {
  addMember,
  cloneMembers,
  findMemberNearPoint,
  findNodeById,
  hasMember,
  isAllowedMember,
  removeMemberById,
  resetMemberIds,
} from '../engine/model';
import { solveTruss } from '../engine/solver';
import type { GameMode, MemberDef, MemberResult, NodeDef, Vec2 } from '../engine/types';
import { createLevelState, defaultLevel } from '../levels';
import { BridgeScene } from '../scene/BridgeScene';
import {
  mountUI,
  renderResultPanel,
  setActiveMode,
  type UIHandles,
} from '../ui/dom';
import * as THREE from 'three';

/** Pixels of movement before a pointer gesture counts as orbit/drag (not a click). */
const CLICK_SLOP_PX = 6;

export class Game {
  private ui: UIHandles;
  private scene: BridgeScene;
  private nodes: NodeDef[];
  private members: MemberDef[] = [];
  private undoStack: MemberDef[][] = [];
  private mode: GameMode = 'bina';
  private loadNodeId: number;
  private loadMagnitude = DEFAULT_LOAD;
  private lastResults: MemberResult[] | null = null;
  private tested = false;

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
    this.nodes = state.nodes;
    this.members = state.members;
    this.loadNodeId = state.loadNodeId;
    this.loadMagnitude = state.loadMagnitude;
    this.ui.loadSlider.value = String(this.loadMagnitude);
    this.ui.loadVal.textContent = String(this.loadMagnitude);

    this.scene.setNodes(this.nodes);
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

  /** Shift+left-drag pans (standard OrbitControls companion to right-drag pan). */
  private applyShiftPan(): void {
    if (this.interacting) return;
    this.scene.controls.mouseButtons.LEFT = this.shiftHeld
      ? THREE.MOUSE.PAN
      : THREE.MOUSE.ROTATE;
  }

  private bindPointer(): void {
    const canvas = this.ui.canvas;

    const getPos = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return this.scene.worldFromClient(e.clientX, e.clientY, rect);
    };

    // capture:true so we can lock OrbitControls before it sees the same event
    canvas.addEventListener(
      'pointerdown',
      (e) => {
        canvas.setPointerCapture(e.pointerId);
        this.pointerDown = true;
        this.downClient = { x: e.clientX, y: e.clientY };

        // Right / middle: let OrbitControls pan/dolly alone
        if (e.button === 1 || e.button === 2) {
          return;
        }

        // Shift+left is pan via OrbitControls
        if (this.shiftHeld) {
          return;
        }

        const world = getPos(e);

        if (this.mode === 'padam') {
          this.interacting = true;
          this.scene.setOrbitEnabled(false);
          this.deleteAt(world);
          return;
        }

        if (this.mode === 'bina') {
          const node = this.scene.nearestNode(this.nodes, world);
          if (node) {
            // Lock orbit so left-drag places a stick instead of rotating
            this.interacting = true;
            this.scene.setOrbitEnabled(false);
            this.dragFrom = node;
            this.scene.highlightNode(node.id);
          }
          // else: empty space → OrbitControls orbits with left-drag
        }
      },
      { capture: true },
    );

    canvas.addEventListener('pointermove', (e) => {
      if (!this.pointerDown) {
        const world = getPos(e);
        const hover = this.scene.nearestNode(this.nodes, world);
        this.scene.highlightNode(hover?.id ?? this.stickyNode?.id ?? null);
        return;
      }

      if (!this.interacting || !this.dragFrom || this.mode !== 'bina') return;

      const world = getPos(e);
      const hover = this.scene.nearestNode(this.nodes, world);
      this.scene.highlightNode(hover?.id ?? this.dragFrom.id);

      if (hover) {
        const valid =
          isAllowedMember(this.nodes, this.dragFrom.id, hover.id) &&
          !hasMember(this.members, this.dragFrom.id, hover.id);
        this.scene.setPreview(
          { x: this.dragFrom.x, y: this.dragFrom.y },
          { x: hover.x, y: hover.y },
          valid,
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
      const to = this.scene.nearestNode(this.nodes, world);

      if (to && to.id !== from.id) {
        // Drag-release onto second node (or click-drag)
        this.tryAddMember(from.id, to.id);
        this.stickyNode = null;
        this.scene.highlightNode(null);
        return;
      }

      // Short click on same node → two-click sticky workflow
      if (to && to.id === from.id && !moved) {
        if (this.stickyNode && this.stickyNode.id !== to.id) {
          this.tryAddMember(this.stickyNode.id, to.id);
          this.stickyNode = null;
          this.scene.highlightNode(null);
        } else if (this.stickyNode && this.stickyNode.id === to.id) {
          this.stickyNode = null;
          this.scene.highlightNode(null);
        } else {
          this.stickyNode = to;
          this.scene.highlightNode(to.id);
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

  private tryAddMember(n1: number, n2: number): void {
    if (!isAllowedMember(this.nodes, n1, n2)) {
      this.flash('Panjang lidi tidak dibenarkan (1–3 unit / pepenjuru).', 'warn');
      return;
    }
    if (hasMember(this.members, n1, n2)) {
      this.flash('Ahli sudah wujud.', 'warn');
      return;
    }
    this.pushUndo();
    addMember(this.members, n1, n2);
    this.invalidateTest();
    this.syncScene();
    this.flash(
      `Lidi ditambah pada kedua-dua sisi 3D (${this.members.length} ahli).`,
      'ok',
    );
  }

  private deleteAt(world: Vec2): void {
    const m = findMemberNearPoint(this.nodes, this.members, world.x, world.y, 0.28);
    if (!m) {
      this.flash('Tiada lidi berhampiran.', 'warn');
      return;
    }
    this.pushUndo();
    removeMemberById(this.members, m.id);
    this.invalidateTest();
    this.syncScene();
    this.flash('Lidi dipadam (kedua-dua sisi).', 'ok');
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

    const loads = this.buildLoads();
    const initial = solveTruss(this.nodes, this.members, loads);
    if (!initial.ok && !initial.singular) {
      renderResultPanel(this.ui.resultPanel, {
        tip: defaultLevel.tipMs,
        statusHtml: initial.message ?? 'Ujian gagal.',
        statusClass: 'bad',
      });
      this.lastResults = null;
      this.tested = false;
      this.syncScene();
      return;
    }

    const prog = progressiveFailure(this.nodes, this.members, loads);

    if (prog.removedIds.length > 0) {
      this.pushUndo();
      for (const id of prog.removedIds) {
        removeMemberById(this.members, id);
      }
    }

    this.lastResults = prog.final.ok
      ? prog.final.members
      : initial.members.length
        ? initial.members
        : prog.steps[0]?.members ?? [];
    this.tested = true;
    this.syncScene(true);
    this.updateLoadArrow();

    const tip = defaultLevel.tipMs;
    if (prog.final.singular || prog.collapsed) {
      renderResultPanel(this.ui.resultPanel, {
        tip,
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
        tip,
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
      tip,
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
    this.undoStack.push(cloneMembers(this.members));
    if (this.undoStack.length > 50) this.undoStack.shift();
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) {
      this.flash('Tiada tindakan untuk undo.', 'warn');
      return;
    }
    this.members = prev;
    this.invalidateTest();
    this.flash('Undo berjaya.', 'ok');
  }

  private reset(): void {
    this.pushUndo();
    this.members = [];
    resetMemberIds();
    this.loadMagnitude = defaultLevel.defaultLoad;
    this.ui.loadSlider.value = String(this.loadMagnitude);
    this.ui.loadVal.textContent = String(this.loadMagnitude);
    this.invalidateTest();
    this.setMode('bina');
    this.flash('Reset — mula bina semula.', 'ok');
  }

  private syncScene(highlightFailed = false): void {
    this.scene.syncMembers(
      this.nodes,
      this.members,
      this.tested ? this.lastResults : null,
      highlightFailed,
    );
    this.updateLoadArrow();
  }

  private updateLoadArrow(): void {
    const node = findNodeById(this.nodes, this.loadNodeId);
    this.scene.setLoadArrow(node, this.loadMagnitude, true);
  }

  private flash(msg: string, cls: 'ok' | 'warn' | 'bad' | ''): void {
    renderResultPanel(this.ui.resultPanel, {
      tip: defaultLevel.tipMs,
      statusHtml: msg,
      statusClass: cls,
      meta: `Ahli: ${this.members.length} · Beban: ${this.loadMagnitude} · Kamera: orbit 3D`,
    });
  }

  private showIdleTip(): void {
    this.flash(
      'Mod Bina — klik dua nod (lidi cermin ke Near/Far). Seret kiri = orbit, skrol = zum, kanan = pan.',
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
