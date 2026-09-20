/**
 * True 3D Three.js bridge view (PerspectiveCamera + OrbitControls).
 *
 * PHYSICS NOTE (MVP): Direct Stiffness Method remains 2D axial-only on the
 * primary XY truss. Deck base rails use Z lanes (up to 7 parallel lidi panjang);
 * only the first structural base chord enters the DSM — extra lanes are visual.
 *
 * DEFAULT UX: one placed member = one cylinder on the active outer wall
 * (lane 0 Kiri / lane 6 Kanan). Middle lanes stay clear roadway.
 * Optional advanced "auto-mirror depth" duplicates side-truss sticks to
 * both outer walls + transverse braces — OFF by default.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  GRID,
  laneZ,
  MAX_HEIGHT,
  OUTER_LANE_KANAN,
  OUTER_LANE_KIRI,
  OUTER_LANES,
  isOuterLane,
  SPAN,
  TRUSS_HALF_DEPTH,
} from '../engine/constants';
import {
  deckLaneSegmentPairs,
  deckMagnetPositions,
  wallGridSegmentPairs,
  wallMagnetPositions,
} from '../engine/grid';
import type { LayerVisibility, WallMode } from '../engine/types';
import { findNodeById } from '../engine/model';
import { utilizationColor } from '../engine/solver';
import type { MemberDef, MemberResult, NodeDef, Vec2 } from '../engine/types';

const MEMBER_RADIUS = 0.055;
const BASE_RADIUS = 0.048;
const TRANSVERSE_RADIUS = 0.04;
const NODE_RADIUS = 0.09;
const Z_NEAR = TRUSS_HALF_DEPTH;
const Z_FAR = -TRUSS_HALF_DEPTH;
/** Inactive layer fade (declutter). Active layer stays 1. */
const LAYER_FADED = 0.15;
const LAYER_SOFT = 0.35;


interface BreakAnim {
  /** Falling / fading clones — never touch length scale of live sticks. */
  clones: THREE.Mesh[];
  /** Live meshes left full-size until model removal. */
  originals: THREE.Mesh[];
  t0: number;
  duration: number;
  startPos: THREE.Vector3[];
  startQuat: THREE.Quaternion[];
}

export class BridgeScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly scene: THREE.Scene;
  private root: THREE.Group;
  private gridGroup: THREE.Group;
  private nodeGroup: THREE.Group;
  private memberGroup: THREE.Group;
  private transverseGroup: THREE.Group;
  private previewGroup: THREE.Group;
  private loadArrow: THREE.Group;
  private abutmentGroup: THREE.Group;
  private groundMesh: THREE.Mesh | null = null;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  /** Active outer-wall build plane — picking projects to that wall's XY. */
  private buildPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -laneZ(OUTER_LANE_KIRI));

  private memberMeshes = new Map<number, THREE.Mesh[]>();
  /** Smooth Lengkung tubes keyed by archGroupId (legs stay in members for DSM). */
  private archMeshes = new Map<number, THREE.Mesh[]>();
  private nodeMeshes = new Map<number, THREE.Mesh[]>();
  private transverseMeshes = new Map<number, THREE.Mesh>();
  /** Amplified Uji displacements — sticks sag/bend until Reset/Bina. */
  private displacements: Map<number, Vec2> | null = null;
  private showDeformation = false;
  private readonly deformScale = 35;
  private readonly deformClamp = 1.15;
  /** Break / pulse feedback */
  private breakAnims: BreakAnim[] = [];
  private pulseIds = new Set<number>();
  private pulseT = 0;
  private breakDoneCb: (() => void) | null = null;
  /** Advanced: duplicate side-truss to both outer walls + transverse braces. Default OFF. */
  private autoMirrorDepth = false;
  /** Through-truss side: kiri=lane0, kanan=lane6, auto=nearest outer. */
  private wallMode: WallMode = 'lantai';
  private activeWallLane: number = OUTER_LANE_KIRI;
  /** Per-layer opacity for decluttered edit focus. */
  private layerVis: LayerVisibility = {
    deck: 1,
    wallKiri: LAYER_FADED,
    wallKanan: LAYER_FADED,
    transverse: LAYER_FADED,
  };

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x1a2332, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x1a2332, 28, 55);

    const lookAt = new THREE.Vector3(SPAN / 2, 0.35, 0);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    this.camera.position.set(SPAN / 2 + 5.5, MAX_HEIGHT + 3.2, 12);
    this.camera.lookAt(lookAt);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(lookAt);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 40;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
    this.controls.update();

    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    const dir = new THREE.DirectionalLight(0xfff5e6, 0.95);
    dir.position.set(6, 14, 10);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 40;
    dir.shadow.camera.left = -8;
    dir.shadow.camera.right = 18;
    dir.shadow.camera.top = 12;
    dir.shadow.camera.bottom = -6;
    const fill = new THREE.DirectionalLight(0x90caf9, 0.35);
    fill.position.set(-8, 6, -6);
    this.scene.add(ambient, dir, fill);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.gridGroup = new THREE.Group();
    this.nodeGroup = new THREE.Group();
    this.memberGroup = new THREE.Group();
    this.transverseGroup = new THREE.Group();
    this.abutmentGroup = new THREE.Group();
    this.loadArrow = new THREE.Group();
    this.previewGroup = new THREE.Group();
    this.root.add(
      this.gridGroup,
      this.abutmentGroup,
      this.memberGroup,
      this.transverseGroup,
      this.nodeGroup,
      this.loadArrow,
      this.previewGroup,
    );

    this.buildGround();
    this.buildGrid();
    this.buildAbutments();
  }

  setOrbitEnabled(enabled: boolean): void {
    this.controls.enabled = enabled;
  }

  /**
   * When true, non-base members render on near+far planes and syncTransverse
   * adds cross connectors (box look). Default false = one stick only.
   */
  setAutoMirrorDepth(enabled: boolean): void {
    this.autoMirrorDepth = enabled;
    if (!enabled) this.clearTransverse();
  }

  getAutoMirrorDepth(): boolean {
    return this.autoMirrorDepth;
  }


  /** Amplify solver displacements for classroom visibility (scale × clamp). */
  private amplifyDisp(d: Vec2 | undefined): Vec2 {
    if (!d) return { x: 0, y: 0 };
    let dx = d.x * this.deformScale;
    let dy = d.y * this.deformScale;
    const mag = Math.hypot(dx, dy);
    if (mag > this.deformClamp && mag > 1e-12) {
      const s = this.deformClamp / mag;
      dx *= s;
      dy *= s;
    }
    return { x: dx, y: dy };
  }

  /** Node XY after optional Uji deformation. */
  private displacedXY(n: NodeDef): Vec2 {
    if (!this.showDeformation || !this.displacements) {
      return { x: n.x, y: n.y };
    }
    const a = this.amplifyDisp(this.displacements.get(n.id));
    return { x: n.x + a.x, y: n.y + a.y };
  }

  setDeformation(displacements: Map<number, Vec2> | null, enabled: boolean): void {
    this.displacements = displacements;
    this.showDeformation = enabled && displacements != null && displacements.size > 0;
  }

  clearDeformation(): void {
    this.displacements = null;
    this.showDeformation = false;
  }

  getShowDeformation(): boolean {
    return this.showDeformation;
  }

  /** Pulse / highlight members (critical or about-to-break) until clearPulse. */
  pulseMembers(ids: number[]): void {
    this.pulseIds = new Set(ids);
    this.pulseT = 0;
  }

  clearPulse(): void {
    if (this.pulseIds.size) {
      const reset = (mesh: THREE.Mesh) => {
        if (mesh.userData.breaking) return;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (mat.emissive) {
          mat.emissive.setHex(0x000000);
          mat.emissiveIntensity = 0;
        }
      };
      for (const [, meshes] of this.memberMeshes) for (const m of meshes) reset(m);
      for (const [, meshes] of this.archMeshes) for (const m of meshes) reset(m);
      for (const [, mesh] of this.transverseMeshes) reset(mesh);
    }
    this.pulseIds.clear();
  }

  /**
   * Snap / crack / fall for failing sticks (~0.6s).
   * Animates a *clone* (flash red, opacity, slight drop/tumble).
   * Never multiplies the live cylinder length scale — remaining sticks stay full size.
   * Original mesh is hidden until Game removes it from the model.
   */
  animateBreaks(memberIds: number[], onDone: () => void): void {
    this.cancelBreakAnims(false);
    const idSet = new Set(memberIds);
    const meshSet = new Set<THREE.Mesh>();
    for (const id of memberIds) {
      const ms = this.memberMeshes.get(id);
      if (ms) for (const m of ms) meshSet.add(m);
      const t = this.transverseMeshes.get(id);
      if (t) meshSet.add(t);
    }
    // Arch tube: break whole curve if any leg fails
    for (const [, archMs] of this.archMeshes) {
      for (const mesh of archMs) {
        const legs = mesh.userData.archLegIds as number[] | undefined;
        const mid = mesh.userData.memberId as number | undefined;
        if ((mid != null && idSet.has(mid)) || (legs && legs.some((lid) => idSet.has(lid)))) {
          meshSet.add(mesh);
        }
      }
    }

    const meshes = [...meshSet];
    if (meshes.length === 0) {
      onDone();
      return;
    }

    const now = performance.now();
    const duration = 600;
    const clones: THREE.Mesh[] = [];
    const originals: THREE.Mesh[] = [];
    const startPos: THREE.Vector3[] = [];
    const startQuat: THREE.Quaternion[] = [];

    for (const mesh of meshes) {
      const parent = mesh.parent;
      if (!parent) continue;

      // Deep-clone material so flash/opacity never touches the live stick mats
      const srcMat = mesh.material as THREE.MeshStandardMaterial;
      const cloneMat = srcMat.clone();
      cloneMat.color.setHex(0x7f0000);
      cloneMat.emissive = new THREE.Color(0xff1744);
      cloneMat.emissiveIntensity = 0.9;
      cloneMat.transparent = true;
      cloneMat.opacity = 1;
      cloneMat.depthWrite = false;

      const clone = mesh.clone(false);
      clone.geometry = mesh.geometry; // share geo; disposed only with original
      clone.material = cloneMat;
      clone.position.copy(mesh.position);
      clone.quaternion.copy(mesh.quaternion);
      // Preserve full length scale (cylinder uses scale.x = L)
      clone.scale.copy(mesh.scale);
      clone.userData.breakClone = true;
      clone.castShadow = false;
      parent.add(clone);

      // Leave original full-size but hidden until model removal
      mesh.userData.breaking = true;
      mesh.visible = false;

      clones.push(clone);
      originals.push(mesh);
      startPos.push(clone.position.clone());
      startQuat.push(clone.quaternion.clone());
    }

    if (clones.length === 0) {
      onDone();
      return;
    }

    this.breakAnims.push({
      clones,
      originals,
      t0: now,
      duration,
      startPos,
      startQuat,
    });
    this.breakDoneCb = onDone;
    this.pulseMembers(memberIds);
  }

  private disposeBreakClone(clone: THREE.Mesh): void {
    clone.parent?.remove(clone);
    const mat = clone.material as THREE.Material;
    mat.dispose();
    // geometry is shared with the original — do not dispose
  }

  cancelBreakAnims(invokeCb: boolean): void {
    for (const anim of this.breakAnims) {
      for (const clone of anim.clones) this.disposeBreakClone(clone);
      for (const mesh of anim.originals) {
        mesh.userData.breaking = false;
        // Remnant will be disposed on next syncMembers after model removal
        mesh.visible = true;
      }
    }
    this.breakAnims = [];
    const cb = this.breakDoneCb;
    this.breakDoneCb = null;
    if (invokeCb && cb) cb();
  }

  private tickBreakAnims(now: number): void {
    if (this.breakAnims.length === 0) return;
    let allDone = true;
    for (const anim of this.breakAnims) {
      const t = Math.min(1, (now - anim.t0) / anim.duration);
      // ease-in
      const e = t * t;
      for (let i = 0; i < anim.clones.length; i++) {
        const clone = anim.clones[i]!;
        const sp = anim.startPos[i]!;
        const sq = anim.startQuat[i]!;
        const mat = clone.material as THREE.MeshStandardMaterial;
        // Flash then fade — do NOT shrink scale (would destroy cylinder length)
        mat.emissiveIntensity = 0.9 * (1 - e) + 0.12;
        mat.opacity = 1 - e * 0.75;
        clone.position.set(sp.x, sp.y - 0.65 * e, sp.z + 0.08 * e);
        const tumble = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(0.4 * e, 0.2 * e, 0.55 * e),
        );
        clone.quaternion.copy(sq).multiply(tumble);
      }
      if (t < 1) allDone = false;
    }
    if (allDone) {
      // Brief remnant then finish
      const oldest = this.breakAnims[0]!;
      if (now - oldest.t0 < oldest.duration + 160) return;
      for (const anim of this.breakAnims) {
        for (const clone of anim.clones) this.disposeBreakClone(clone);
        for (const mesh of anim.originals) {
          mesh.userData.breaking = false;
          mesh.visible = false;
        }
      }
      this.breakAnims = [];
      const cb = this.breakDoneCb;
      this.breakDoneCb = null;
      if (cb) cb();
    }
  }

  private tickPulse(dt: number): void {
    if (this.pulseIds.size === 0) return;
    this.pulseT += dt;
    const wave = 0.5 + 0.5 * Math.sin(this.pulseT * 8);
    const apply = (mesh: THREE.Mesh, id: number) => {
      if (!this.pulseIds.has(id) && !(mesh.userData.archLegIds as number[] | undefined)?.some((x) => this.pulseIds.has(x))) {
        return;
      }
      if (mesh.userData.breaking) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.emissive = new THREE.Color(0xb71c1c);
      mat.emissiveIntensity = 0.25 + 0.55 * wave;
    };
    for (const [id, meshes] of this.memberMeshes) {
      for (const mesh of meshes) apply(mesh, id);
    }
    for (const [, meshes] of this.archMeshes) {
      for (const mesh of meshes) {
        const mid = mesh.userData.memberId as number;
        apply(mesh, mid);
        const legs = mesh.userData.archLegIds as number[] | undefined;
        if (legs) for (const lid of legs) apply(mesh, lid);
      }
    }
    for (const [id, mesh] of this.transverseMeshes) {
      if (mesh.userData.storedTransverse) apply(mesh, id);
    }
  }


  setWallMode(mode: WallMode): void {
    this.wallMode = mode;
    if (mode === 'kiri') this.activeWallLane = OUTER_LANE_KIRI;
    else if (mode === 'kanan') this.activeWallLane = OUTER_LANE_KANAN;
    else if (mode === 'melintang' || mode === 'lantai') {
      // Lantai: mid-span build plane. Melintang: picking uses both outer wall planes (see worldFromClient).
      this.activeWallLane = OUTER_LANE_KIRI;
    }
    this.layerVis = this.visibilityForMode(mode);
    this.syncBuildPlane();
    this.buildGrid();
    this.frameCameraForMode(mode);
    this.applyLayerOpacityToExisting();
  }

  getLayerVisibility(): LayerVisibility {
    return { ...this.layerVis };
  }

  /** Is a Z lane part of the active edit-focus layer? */
  isLaneActive(lane: number): boolean {
    if (this.wallMode === 'lantai') return true; // deck uses all lanes
    if (this.wallMode === 'kiri') return lane === OUTER_LANE_KIRI;
    if (this.wallMode === 'kanan') return lane === OUTER_LANE_KANAN;
    if (this.wallMode === 'melintang') return isOuterLane(lane);
    return isOuterLane(lane);
  }

  private visibilityForMode(mode: WallMode): LayerVisibility {
    switch (mode) {
      case 'lantai':
        return {
          deck: 1,
          wallKiri: LAYER_FADED,
          wallKanan: LAYER_FADED,
          transverse: LAYER_FADED,
        };
      case 'kiri':
        return {
          deck: LAYER_SOFT,
          wallKiri: 1,
          wallKanan: LAYER_FADED,
          transverse: LAYER_FADED,
        };
      case 'kanan':
        return {
          deck: LAYER_SOFT,
          wallKiri: LAYER_FADED,
          wallKanan: 1,
          transverse: LAYER_FADED,
        };
      case 'melintang':
        // Both outer walls pickable at every height (lane 0 & 6).
        // Opacity ≥ 0.9 keeps node/magnet meshes raycast-enabled.
        return {
          deck: LAYER_SOFT,
          wallKiri: 0.95,
          wallKanan: 0.95,
          transverse: 1,
        };
      default:
        // auto — both walls usable
        return { deck: LAYER_SOFT, wallKiri: 1, wallKanan: 1, transverse: LAYER_FADED };
    }
  }

  /** Nudge camera toward the active edit plane (gentle, keeps orbit usable). */
  private frameCameraForMode(mode: WallMode): void {
    const lookAt = new THREE.Vector3(SPAN / 2, mode === 'lantai' ? 0.1 : 0.55, 0);
    let pos: THREE.Vector3;
    switch (mode) {
      case 'lantai':
        pos = new THREE.Vector3(SPAN / 2 + 1.5, MAX_HEIGHT + 7.5, 9);
        break;
      case 'kiri':
        pos = new THREE.Vector3(SPAN / 2 + 4, MAX_HEIGHT + 2.8, laneZ(OUTER_LANE_KIRI) + 9);
        break;
      case 'kanan':
        pos = new THREE.Vector3(SPAN / 2 + 4, MAX_HEIGHT + 2.8, laneZ(OUTER_LANE_KANAN) - 9);
        break;
      case 'melintang':
        pos = new THREE.Vector3(SPAN / 2 + 9, MAX_HEIGHT + 3.5, 0);
        break;
      default:
        pos = new THREE.Vector3(SPAN / 2 + 5.5, MAX_HEIGHT + 3.2, 12);
    }
    this.camera.position.copy(pos);
    this.controls.target.copy(lookAt);
    this.controls.update();
  }

  getWallMode(): WallMode {
    return this.wallMode;
  }

  getActiveWallLane(): number {
    return this.activeWallLane;
  }

  /** Resolve Auto wall from a client ray; also refreshes build plane. */
  resolveWallFromClient(clientX: number, clientY: number, rect: DOMRect): number {
    if (this.wallMode !== 'auto') {
      this.syncBuildPlane();
      return this.activeWallLane;
    }
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    let bestLane = this.activeWallLane;
    let bestAbs = Infinity;
    for (const lane of OUTER_LANES) {
      const z = laneZ(lane);
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z);
      const hit = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(plane, hit)) {
        const d = this.raycaster.ray.origin.distanceTo(hit);
        if (d < bestAbs) {
          bestAbs = d;
          bestLane = lane;
        }
      }
    }
    if (bestLane !== this.activeWallLane) {
      this.activeWallLane = bestLane;
      this.syncBuildPlane();
      this.buildGrid();
    } else {
      this.syncBuildPlane();
    }
    return bestLane;
  }

  private syncBuildPlane(): void {
    const z =
      this.wallMode === 'melintang' || this.wallMode === 'lantai'
        ? 0
        : laneZ(this.activeWallLane);
    this.buildPlane.set(new THREE.Vector3(0, 0, 1), -z);
  }


  /**
   * Look up utilization for a member; if missing (legacy visualOnly twin),
   * copy from a matching XY member that has solver results.
   */
  private resultForMember(
    m: MemberDef,
    members: MemberDef[],
    resultMap: Map<number, MemberResult>,
  ): MemberResult | undefined {
    const direct = resultMap.get(m.id);
    if (direct) return direct;
    // Mirror colours from parallel wall / same-chord structural twin
    for (const other of members) {
      if (other.id === m.id) continue;
      if (other.role === 'transverse') continue;
      const sameEnds =
        (other.n1 === m.n1 && other.n2 === m.n2) ||
        (other.n1 === m.n2 && other.n2 === m.n1);
      if (!sameEnds) continue;
      const r = resultMap.get(other.id);
      if (r) return r;
    }
    return undefined;
  }

  private wallZsForMember(zLane?: number): number[] {
    if (this.autoMirrorDepth) {
      return [laneZ(OUTER_LANE_KIRI), laneZ(OUTER_LANE_KANAN)];
    }
    if (this.wallMode === 'melintang') {
      const lane = zLane != null && isOuterLane(zLane) ? zLane : this.activeWallLane;
      return [laneZ(lane)];
    }
    const lane = zLane != null && isOuterLane(zLane) ? zLane : this.activeWallLane;
    return [laneZ(lane)];
  }

  /** Opacity for a member based on edit-focus layer. */
  private opacityForMember(m: { role?: string; zLane?: number }): number {
    if (m.role === 'transverse') return this.layerVis.transverse;
    if (m.role === 'base') return this.layerVis.deck;
    const lane = m.zLane;
    if (lane === OUTER_LANE_KANAN) return this.layerVis.wallKanan;
    if (lane === OUTER_LANE_KIRI) return this.layerVis.wallKiri;
    // Untagged side member → active wall (or fade both when on lantai)
    if (this.wallMode === 'lantai') return LAYER_FADED;
    if (this.wallMode === 'kanan') return this.layerVis.wallKanan;
    if (this.wallMode === 'kiri') return this.layerVis.wallKiri;
    return Math.max(this.layerVis.wallKiri, this.layerVis.wallKanan);
  }

  private applyOpacityToMesh(mesh: THREE.Mesh, opacity: number): void {
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const active = opacity >= 0.9;
    mat.transparent = opacity < 0.99;
    mat.opacity = opacity;
    mat.depthWrite = active;
    mesh.visible = opacity > 0.05;
    // Inactive layers: not pickable via raycast
    mesh.raycast = active ? THREE.Mesh.prototype.raycast : () => {};
  }

  /** Re-apply layer opacity after mode switch without full member rebuild. */
  private applyLayerOpacityToExisting(): void {
    for (const [, meshes] of this.memberMeshes) {
      for (const mesh of meshes) {
        const op = this.opacityForMember({
          role: mesh.userData.memberRole as string | undefined,
          zLane: mesh.userData.zLane as number | undefined,
        });
        mesh.userData.layerOpacity = op;
        this.applyOpacityToMesh(mesh, op);
      }
    }
    for (const [, meshes] of this.archMeshes) {
      for (const mesh of meshes) {
        const op = this.opacityForMember({
          role: mesh.userData.memberRole as string | undefined,
          zLane: mesh.userData.zLane as number | undefined,
        });
        mesh.userData.layerOpacity = op;
        this.applyOpacityToMesh(mesh, op);
      }
    }
    for (const [, mesh] of this.transverseMeshes) {
      const op = this.layerVis.transverse;
      mesh.userData.layerOpacity = op;
      this.applyOpacityToMesh(mesh, op);
    }
    for (const [, meshes] of this.nodeMeshes) {
      for (const mesh of meshes) {
        const layer = mesh.userData.layer as string | undefined;
        let op = 1;
        if (layer === 'wallKiri') op = this.layerVis.wallKiri;
        else if (layer === 'wallKanan') op = this.layerVis.wallKanan;
        else if (layer === 'deck') op = this.layerVis.deck;
        else {
          op = Math.max(
            this.layerVis.wallKiri,
            this.layerVis.wallKanan,
            this.layerVis.deck,
          );
        }
        this.applyOpacityToMesh(mesh, op);
      }
    }
  }

  private clearTransverse(): void {
    // Only clear auto-mirror visuals — keep stored Melintang members.
    for (const [id, mesh] of this.transverseMeshes) {
      if (mesh.userData.storedTransverse) continue;
      this.transverseGroup.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      this.transverseMeshes.delete(id);
    }
  }

  private buildGround(): void {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x3e4a3a,
      roughness: 0.9,
      metalness: 0.05,
    });
    const ground = new THREE.Mesh(new THREE.BoxGeometry(SPAN + 6, 0.25, 7), mat);
    ground.position.set(SPAN / 2, -0.55, 0);
    ground.receiveShadow = true;
    this.root.add(ground);
    this.groundMesh = ground;

    const water = new THREE.Mesh(
      new THREE.BoxGeometry(SPAN - 1.2, 0.08, 3.6),
      new THREE.MeshStandardMaterial({
        color: 0x1565c0,
        roughness: 0.35,
        metalness: 0.2,
        transparent: true,
        opacity: 0.55,
      }),
    );
    water.position.set(SPAN / 2, -0.42, 0);
    this.root.add(water);
  }

  private buildGrid(): void {
    while (this.gridGroup.children.length) {
      const c = this.gridGroup.children[0]!;
      this.gridGroup.remove(c);
      if (c instanceof THREE.LineSegments || c instanceof THREE.Mesh) {
        (c as THREE.Mesh).geometry?.dispose();
        const mat = (c as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else (mat as THREE.Material)?.dispose();
      }
    }

    const deckOp = this.layerVis.deck;
    const showDeck = deckOp > 0.05;
    const showWallKiri = this.layerVis.wallKiri > 0.05;
    const showWallKanan = this.layerVis.wallKanan > 0.05;

    const toVec3 = (p: { x: number; y: number; z: number }) =>
      new THREE.Vector3(p.x, p.y, p.z);

    // Deck roadway guides + magnets — exact createGridNodes / laneZ coords (no Y offset)
    if (showDeck) {
      const { road, wall } = deckLaneSegmentPairs();
      this.gridGroup.add(
        new THREE.LineSegments(
          new THREE.BufferGeometry().setFromPoints(road.map(toVec3)),
          new THREE.LineBasicMaterial({
            color: 0x90caf9,
            transparent: true,
            opacity: 0.4 * deckOp,
          }),
        ),
      );
      this.gridGroup.add(
        new THREE.LineSegments(
          new THREE.BufferGeometry().setFromPoints(wall.map(toVec3)),
          new THREE.LineBasicMaterial({
            color: 0xffb74d,
            transparent: true,
            opacity: 0.75 * deckOp,
          }),
        ),
      );

      const magnetGeo = new THREE.SphereGeometry(0.08, 10, 10);
      const roadMat = new THREE.MeshStandardMaterial({
        color: 0xbbdefb,
        emissive: 0x1565c0,
        emissiveIntensity: 0.08,
        transparent: true,
        opacity: 0.7 * deckOp,
        roughness: 0.55,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      const wallDeckMat = new THREE.MeshStandardMaterial({
        color: 0xffe0b2,
        emissive: 0xe65100,
        emissiveIntensity: 0.18,
        transparent: true,
        opacity: 0.95 * deckOp,
        roughness: 0.5,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      for (const p of deckMagnetPositions()) {
        const outer = isOuterLane(p.lane);
        const mesh = new THREE.Mesh(magnetGeo, outer ? wallDeckMat : roadMat);
        mesh.position.set(p.x, p.y, p.z);
        mesh.userData.deckMagnet = true;
        mesh.userData.layer = 'deck';
        mesh.userData.xIndex = Math.round(p.x / GRID);
        mesh.userData.zLane = p.lane;
        mesh.userData.laneRole = outer ? 'dinding' : 'laluan';
        mesh.visible = deckOp >= 0.5;
        this.gridGroup.add(mesh);
      }
    }

    // Wall wireframes + height magnets from the SAME vertex list as createGridNodes
    const heightGeo = new THREE.SphereGeometry(0.07, 10, 10);
    for (const lane of OUTER_LANES) {
      const isKiri = lane === OUTER_LANE_KIRI;
      const wallOp = isKiri ? this.layerVis.wallKiri : this.layerVis.wallKanan;
      if (wallOp < 0.35) continue;
      if (isKiri && !showWallKiri) continue;
      if (!isKiri && !showWallKanan) continue;

      const active = wallOp >= 0.9;
      const heightMat = new THREE.MeshStandardMaterial({
        color: active ? 0xfff176 : 0xffcc80,
        emissive: active ? 0xf57f17 : 0xbf360c,
        emissiveIntensity: active ? 0.35 : 0.12,
        transparent: true,
        opacity: (active ? 0.98 : 0.85) * Math.max(wallOp, LAYER_FADED),
        roughness: active ? 0.4 : 0.5,
      });

      // Wireframe from wallGridSegmentPairs (same vertices as magnets / nodes).
      // Only one focused wall at a time in auto/kiri/kanan — dual cages at an angle
      // look like a half-cell shift (parallax). Melintang: faint on both.
      const drawWire =
        this.wallMode === 'melintang'
          ? wallOp >= 0.35
          : this.wallMode === 'auto'
            ? lane === this.activeWallLane
            : active;
      if (drawWire) {
        const vPts = wallGridSegmentPairs(lane).map(toVec3);
        this.gridGroup.add(
          new THREE.LineSegments(
            new THREE.BufferGeometry().setFromPoints(vPts),
            new THREE.LineBasicMaterial({
              color: active ? 0xffee58 : 0xffa726,
              transparent: true,
              opacity: (active ? 0.55 : 0.22) * wallOp,
            }),
          ),
        );
      }

      const showMagnets = wallOp >= 0.5;
      if (showMagnets) {
        for (const p of wallMagnetPositions(lane)) {
          // Deck row already has deck magnets when deck is visible; still place
          // wall magnets at y=0 so every wall vertex is occupied when walls focus.
          if (p.y === 0 && showDeck && deckOp >= 0.5) continue;
          const mesh = new THREE.Mesh(heightGeo, heightMat);
          mesh.position.set(p.x, p.y, p.z);
          mesh.userData.wallMagnet = true;
          mesh.userData.layer = isKiri ? 'wallKiri' : 'wallKanan';
          mesh.userData.zLane = lane;
          mesh.userData.yIndex = Math.round(p.y / GRID);
          this.gridGroup.add(mesh);
        }
      }
    }
  }

  private buildAbutments(): void {
    while (this.abutmentGroup.children.length) {
      const c = this.abutmentGroup.children[0]!;
      this.abutmentGroup.remove(c);
    }

    const depth = TRUSS_HALF_DEPTH * 2 + 0.7;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x6d4c41,
      roughness: 0.85,
    });

    const left = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.7, depth), mat);
    left.position.set(0, -0.35, 0);
    left.castShadow = true;
    left.receiveShadow = true;

    const right = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.7, depth), mat);
    right.position.set(SPAN, -0.35, 0);
    right.castShadow = true;
    right.receiveShadow = true;
    this.abutmentGroup.add(left, right);

    const pinMat = new THREE.MeshStandardMaterial({ color: 0xffca28 });
    for (const z of [Z_NEAR, Z_FAR]) {
      const pin = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.26, 3), pinMat);
      pin.rotation.z = Math.PI;
      pin.position.set(0, -0.02, z);
      pin.castShadow = true;
      this.abutmentGroup.add(pin);
    }

    const rollerMat = new THREE.MeshStandardMaterial({ color: 0x90caf9 });
    for (const z of [Z_NEAR, Z_FAR]) {
      for (const ox of [-0.12, 0.12]) {
        const c = new THREE.Mesh(
          new THREE.CylinderGeometry(0.07, 0.07, 0.14, 16),
          rollerMat,
        );
        c.rotation.x = Math.PI / 2;
        c.position.set(SPAN + ox, -0.08, z);
        c.castShadow = true;
        this.abutmentGroup.add(c);
      }
    }
  }

  setNodes(nodes: NodeDef[]): void {
    while (this.nodeGroup.children.length) {
      const c = this.nodeGroup.children[0] as THREE.Mesh;
      this.nodeGroup.remove(c);
      c.geometry?.dispose();
      (c.material as THREE.Material)?.dispose();
    }
    this.nodeMeshes.clear();

    for (const n of nodes) {
      // Apex is physics-only (Lengkung legs); visible stick is a smooth tube.
      if (n.isApex) continue;
      // Deck + wall height magnets already drawn in buildGrid.
      if (n.isDeck && !n.isFree && n.support === 'none') continue;
      // Fixed upper grid joints are visual magnets on outer walls only.
      if (!n.isFree && !n.isApex && n.support === 'none' && !n.isDeck) continue;

      let color = 0xb0bec5;
      if (n.support === 'pin') color = 0xffca28;
      else if (n.support === 'roller') color = 0x90caf9;
      else if (n.isFree) color = 0x80cbc4;

      const meshes: THREE.Mesh[] = [];
      const r = n.isFree ? NODE_RADIUS * 0.85 : NODE_RADIUS * 1.05;

      // Supports / free joints live on outer walls — never mid-roadway z=0.
      // Lantai: deck-level nodes at mid Z; walls: active wall (or both for melintang).
      let zs: number[];
      let layers: string[];
      if (n.isDeck && this.wallMode === 'lantai') {
        zs = [0];
        layers = ['deck'];
      } else if (
        n.support !== 'none' ||
        this.autoMirrorDepth ||
        this.wallMode === 'melintang'
      ) {
        zs = [laneZ(OUTER_LANE_KIRI), laneZ(OUTER_LANE_KANAN)];
        layers = ['wallKiri', 'wallKanan'];
      } else if (this.wallMode === 'lantai') {
        zs = [0];
        layers = ['deck'];
      } else {
        zs = [laneZ(this.activeWallLane)];
        layers = [
          this.activeWallLane === OUTER_LANE_KANAN ? 'wallKanan' : 'wallKiri',
        ];
      }

      for (let i = 0; i < zs.length; i++) {
        const z = zs[i]!;
        const layer = layers[i]!;
        let op = 1;
        if (layer === 'wallKiri') op = this.layerVis.wallKiri;
        else if (layer === 'wallKanan') op = this.layerVis.wallKanan;
        else op = this.layerVis.deck;
        const geo = new THREE.SphereGeometry(r, 12, 12);
        const mat = new THREE.MeshStandardMaterial({
          color,
          transparent: op < 0.99,
          opacity: op * (zs.length === 1 ? 0.85 : 1),
        });
        const mesh = new THREE.Mesh(geo, mat);
        const p = this.displacedXY(n);
        mesh.position.set(p.x, p.y, z);
        mesh.userData.nodeId = n.id;
        mesh.userData.layer = layer;
        mesh.castShadow = op >= 0.9;
        mesh.visible = op > 0.05;
        // Melintang needs both walls pickable at every height — never disable raycast.
        if (op < 0.9 && this.wallMode !== 'melintang') mesh.raycast = () => {};
        this.nodeGroup.add(mesh);
        meshes.push(mesh);
      }
      this.nodeMeshes.set(n.id, meshes);
    }
  }

  syncMembers(
    nodes: NodeDef[],
    members: MemberDef[],
    results: MemberResult[] | null,
    highlightFailed = false,
  ): void {
    const resultMap = new Map(results?.map((r) => [r.id, r]) ?? []);
    const deform = this.showDeformation;

    // --- Lengkung: one smooth Bezier tube per arch group (hide sharp ∧ legs) ---
    const archGroups = new Map<
      number,
      { legs: MemberDef[]; chord: [number, number]; zLane?: number; role?: string }
    >();
    for (const m of members) {
      if (m.archGroupId == null || !m.archChord) continue;
      let g = archGroups.get(m.archGroupId);
      if (!g) {
        g = { legs: [], chord: m.archChord, zLane: m.zLane, role: m.role };
        archGroups.set(m.archGroupId, g);
      }
      g.legs.push(m);
      if (m.zLane != null) g.zLane = m.zLane;
      if (m.role) g.role = m.role;
    }

    const liveArch = new Set(archGroups.keys());
    for (const [gid, meshes] of this.archMeshes) {
      if (!liveArch.has(gid)) {
        const keep: THREE.Mesh[] = [];
        for (const mesh of meshes) {
          if (mesh.userData.breaking) {
            keep.push(mesh);
            continue;
          }
          this.memberGroup.remove(mesh);
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        }
        if (keep.length) this.archMeshes.set(gid, keep);
        else this.archMeshes.delete(gid);
      }
    }

    const archLegIds = new Set<number>();
    for (const [gid, g] of archGroups) {
      for (const leg of g.legs) archLegIds.add(leg.id);
      const [c1, c2] = g.chord;
      const aNode = findNodeById(nodes, c1);
      const bNode = findNodeById(nodes, c2);
      if (!aNode || !bNode) continue;
      const endIds = new Set([c1, c2]);
      const apexId = g.legs
        .flatMap((l) => [l.n1, l.n2])
        .find((id) => !endIds.has(id));
      const apexNode = apexId != null ? findNodeById(nodes, apexId) : undefined;
      if (!apexNode) continue;

      const a = this.displacedXY(aNode);
      const b = this.displacedXY(bNode);
      const apex = this.displacedXY(apexNode);

      // Quadratic Bezier through displaced ends with apex as curve midpoint
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const ctrl = {
        x: 2 * apex.x - mid.x,
        y: 2 * apex.y - mid.y,
      };

      let color = g.role === 'base' ? 0xc8a882 : 0xa1887f;
      // Colour by worst utilization of the two legs (mirror twin if needed)
      for (const leg of g.legs) {
        const rr = this.resultForMember(leg, members, resultMap);
        if (rr) {
          color = utilizationColor(rr.utilization);
          if (highlightFailed && rr.failed) color = 0x7f0000;
        }
      }

      const isBase = g.role === 'base' && g.zLane != null;
      const zs = isBase ? [laneZ(g.zLane!)] : this.wallZsForMember(g.zLane);
      const radius = isBase ? BASE_RADIUS : MEMBER_RADIUS;

      let meshes = this.archMeshes.get(gid);
      // Skip geometry updates while a break anim owns these meshes
      if (meshes?.some((mesh) => mesh.userData.breaking)) continue;

      const archKey = `${a.x.toFixed(3)},${a.y.toFixed(3)},${apex.x.toFixed(3)},${apex.y.toFixed(3)},${b.x.toFixed(3)},${b.y.toFixed(3)},${deform ? 1 : 0}`;
      const needRebuild =
        !meshes ||
        meshes.length !== zs.length ||
        meshes.some((mesh) => mesh.userData.archKey !== archKey);
      if (needRebuild) {
        if (meshes) {
          for (const mesh of meshes) {
            this.memberGroup.remove(mesh);
            mesh.geometry.dispose();
            (mesh.material as THREE.Material).dispose();
          }
        }
        meshes = zs.map((z) => {
          const curve = new THREE.QuadraticBezierCurve3(
            new THREE.Vector3(a.x, a.y, z),
            new THREE.Vector3(ctrl.x, ctrl.y, z),
            new THREE.Vector3(b.x, b.y, z),
          );
          const geo = new THREE.TubeGeometry(curve, 24, radius, 8, false);
          const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.65 });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.userData.archGroupId = gid;
          mesh.userData.archKey = archKey;
          mesh.userData.memberId = g.legs[0]!.id;
          mesh.userData.archLegIds = g.legs.map((l) => l.id);
          mesh.userData.memberRole = g.role;
          mesh.userData.zLane = g.zLane;
          const archOp = this.opacityForMember({
            role: g.role,
            zLane: g.zLane,
          });
          mesh.userData.layerOpacity = archOp;
          this.applyOpacityToMesh(mesh, archOp);
          mesh.castShadow = archOp >= 0.9;
          mesh.receiveShadow = true;
          this.memberGroup.add(mesh);
          return mesh;
        });
        this.archMeshes.set(gid, meshes);
      } else {
        const archOp = this.opacityForMember({ role: g.role, zLane: g.zLane });
        for (const mesh of meshes!) {
          (mesh.material as THREE.MeshStandardMaterial).color.setHex(color);
          mesh.userData.archLegIds = g.legs.map((l) => l.id);
          mesh.userData.layerOpacity = archOp;
          this.applyOpacityToMesh(mesh, archOp);
        }
      }
    }

    // --- Straight members (skip arch legs — already drawn as smooth tubes) ---
    const straightIds = new Set(
      members
        .filter((m) => m.archGroupId == null && m.role !== 'transverse')
        .map((m) => m.id),
    );
    for (const [id, meshes] of this.memberMeshes) {
      if (!straightIds.has(id)) {
        const keep: THREE.Mesh[] = [];
        for (const mesh of meshes) {
          if (mesh.userData.breaking) {
            keep.push(mesh);
            continue;
          }
          this.memberGroup.remove(mesh);
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        }
        if (keep.length) this.memberMeshes.set(id, keep);
        else this.memberMeshes.delete(id);
      }
    }

    for (const m of members) {
      if (m.archGroupId != null) continue;
      if (m.role === 'transverse') continue; // rendered in syncStoredTransverse
      const aNode = findNodeById(nodes, m.n1)!;
      const bNode = findNodeById(nodes, m.n2)!;
      const a = this.displacedXY(aNode);
      const b = this.displacedXY(bNode);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1e-6;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const angle = Math.atan2(dy, dx);

      let color = m.role === 'base' ? 0xc8a882 : 0xa1887f;
      const r = this.resultForMember(m, members, resultMap);
      if (r) {
        color = utilizationColor(r.utilization);
        if (highlightFailed && r.failed) color = 0x7f0000;
      }

      const isBase = m.role === 'base' && m.zLane != null;
      const zs = isBase ? [laneZ(m.zLane!)] : this.wallZsForMember(m.zLane);
      const radius = isBase ? BASE_RADIUS : MEMBER_RADIUS;

      // Extra mid bow under load (visible lenturan) from amplified uy + compression
      let bow = 0;
      if (deform) {
        const d1 = this.amplifyDisp(this.displacements?.get(m.n1));
        const d2 = this.amplifyDisp(this.displacements?.get(m.n2));
        const avgSag = -((d1.y + d2.y) / 2); // downward positive sag
        const compBoost = r && r.force < 0 ? 0.12 * Math.min(1, r.utilization) : 0.03;
        bow = Math.min(0.4, Math.max(0, avgSag * 0.35) + compBoost);
      }

      let meshes = this.memberMeshes.get(m.id);
      if (meshes?.some((mesh) => mesh.userData.breaking)) continue;

      const deformKey = deform ? `t:${bow.toFixed(3)}` : 'cyl';
      const needRebuild =
        !meshes ||
        meshes.length !== zs.length ||
        meshes.some((mesh) => mesh.userData.deformKey !== deformKey);

      if (needRebuild) {
        if (meshes) {
          for (const mesh of meshes) {
            this.memberGroup.remove(mesh);
            mesh.geometry.dispose();
            (mesh.material as THREE.Material).dispose();
          }
        }
        meshes = zs.map((z) => {
          let mesh: THREE.Mesh;
          if (deform) {
            // Tube along displaced ends with slight mid sag (looks bent)
            const nx = L > 1e-9 ? -dy / L : 0;
            const ny = L > 1e-9 ? dx / L : 1;
            // Prefer bow toward gravity (down)
            const sign = ny >= 0 ? -1 : 1;
            const ctrl = new THREE.Vector3(
              mx + nx * bow * 0.15,
              my - bow + ny * bow * 0.05 * sign,
              z,
            );
            const curve = new THREE.QuadraticBezierCurve3(
              new THREE.Vector3(a.x, a.y, z),
              ctrl,
              new THREE.Vector3(b.x, b.y, z),
            );
            const geo = new THREE.TubeGeometry(curve, 16, radius, 8, false);
            const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
            mesh = new THREE.Mesh(geo, mat);
          } else {
            const geo = new THREE.CylinderGeometry(radius, radius, 1, 8);
            geo.rotateZ(Math.PI / 2);
            const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
            mesh = new THREE.Mesh(geo, mat);
          }
          mesh.userData.memberId = m.id;
          mesh.userData.memberRole = m.role;
          mesh.userData.zLane = m.zLane;
          mesh.userData.deformKey = deformKey;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          this.memberGroup.add(mesh);
          return mesh;
        });
        this.memberMeshes.set(m.id, meshes);
      }

      if (!meshes) continue;

      const memOp = this.opacityForMember(m);
      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i]!;
        if (mesh.userData.breaking) continue;
        const z = zs[i]!;
        if (deform) {
          // TubeGeometry already sits in world segment space between displaced ends
          mesh.position.set(0, 0, 0);
          mesh.rotation.set(0, 0, 0);
          mesh.scale.set(1, 1, 1);
        } else {
          // Cylinder unit length along X — scale.x MUST stay endpoint distance L
          mesh.scale.set(L, 1, 1);
          mesh.position.set(mx, my, z);
          mesh.rotation.set(0, 0, angle);
        }
        (mesh.material as THREE.MeshStandardMaterial).color.setHex(color);
        mesh.userData.memberRole = m.role;
        mesh.userData.zLane = m.zLane;
        mesh.userData.deformKey = deformKey;
        mesh.userData.layerOpacity = memOp;
        this.applyOpacityToMesh(mesh, memOp);
      }

      // If deformed tube ends changed, rebuild geometry in place
      if (deform && meshes[0] && meshes[0].userData.geomKey !== `${a.x.toFixed(3)},${b.x.toFixed(3)},${a.y.toFixed(3)},${b.y.toFixed(3)},${bow.toFixed(3)}`) {
        const geomKey = `${a.x.toFixed(3)},${b.x.toFixed(3)},${a.y.toFixed(3)},${b.y.toFixed(3)},${bow.toFixed(3)}`;
        for (let i = 0; i < meshes.length; i++) {
          const mesh = meshes[i]!;
          const z = zs[i]!;
          const nx = L > 1e-9 ? -dy / L : 0;
          const ny = L > 1e-9 ? dx / L : 1;
          const sign = ny >= 0 ? -1 : 1;
          const ctrl = new THREE.Vector3(
            mx + nx * bow * 0.15,
            my - bow + ny * bow * 0.05 * sign,
            z,
          );
          const curve = new THREE.QuadraticBezierCurve3(
            new THREE.Vector3(a.x, a.y, z),
            ctrl,
            new THREE.Vector3(b.x, b.y, z),
          );
          mesh.geometry.dispose();
          mesh.geometry = new THREE.TubeGeometry(curve, 16, radius, 8, false);
          mesh.userData.geomKey = geomKey;
          mesh.position.set(0, 0, 0);
          mesh.rotation.set(0, 0, 0);
          mesh.scale.set(1, 1, 1);
        }
      }
    }

    void archLegIds;
    this.syncStoredTransverse(nodes, members, resultMap, highlightFailed);
    this.syncTransverse(nodes, members);
  }

  /**
   * Stored Melintang members: cylinder from (x1,y1,zFrom) → (x2,y2,zTo).
   * Keyed in transverseMeshes with negative ids to avoid clashing with auto-mirror.
   */
  private syncStoredTransverse(
    nodes: NodeDef[],
    members: MemberDef[],
    resultMap: Map<number, MemberResult>,
    highlightFailed: boolean,
  ): void {
    const live = new Set<number>();
    for (const m of members) {
      if (m.role !== 'transverse') continue;
      if (m.zLaneFrom == null || m.zLaneTo == null) continue;
      const aNode = findNodeById(nodes, m.n1);
      const bNode = findNodeById(nodes, m.n2);
      if (!aNode || !bNode) continue;
      live.add(m.id);
      const a = this.displacedXY(aNode);
      const b = this.displacedXY(bNode);

      const z0 = laneZ(m.zLaneFrom);
      const z1 = laneZ(m.zLaneTo);
      const p0 = new THREE.Vector3(a.x, a.y, z0);
      const p1 = new THREE.Vector3(b.x, b.y, z1);
      const mid = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
      const dir = new THREE.Vector3().subVectors(p1, p0);
      const L = dir.length();
      if (L < 1e-9) continue;

      let color = 0x8d6e63;
      const rr = resultMap.get(m.id);
      if (rr) {
        color = utilizationColor(rr.utilization);
        if (highlightFailed && rr.failed) color = 0x7f0000;
      }

      let mesh = this.transverseMeshes.get(m.id);
      if (mesh?.userData.breaking) continue;
      if (!mesh) {
        const geo = new THREE.CylinderGeometry(
          TRANSVERSE_RADIUS,
          TRANSVERSE_RADIUS,
          1,
          8,
        );
        // Default cylinder is Y-up; orient via quaternion below.
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
        mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.memberId = m.id;
        mesh.userData.storedTransverse = true;
        this.transverseGroup.add(mesh);
        this.transverseMeshes.set(m.id, mesh);
      }

      // Cylinder default is Y-up — scale.y is length between displaced ends
      mesh.scale.set(1, L, 1);
      mesh.position.copy(mid);
      mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        dir.clone().normalize(),
      );
      (mesh.material as THREE.MeshStandardMaterial).color.setHex(color);
      mesh.userData.layerOpacity = this.layerVis.transverse;
      if (!mesh.userData.breaking) {
        this.applyOpacityToMesh(mesh, this.layerVis.transverse);
      }
    }

    for (const [id, mesh] of this.transverseMeshes) {
      if (!mesh.userData.storedTransverse) continue;
      if (!live.has(id)) {
        if (mesh.userData.breaking) continue;
        this.transverseGroup.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        this.transverseMeshes.delete(id);
      }
    }
  }

  /**
   * Visual-only near↔far connectors at nodes that participate in side-truss
   * members (not base-only). Never enters the 2D members list.
   * Gated by autoMirrorDepth — OFF by default so one stick ≠ kotak.
   */
  private syncTransverse(nodes: NodeDef[], members: MemberDef[]): void {
    if (!this.autoMirrorDepth) {
      this.clearTransverse();
      return;
    }
    const used = new Set<number>();
    for (const m of members) {
      if (m.role === 'base') continue;
      used.add(m.n1);
      used.add(m.n2);
    }
    for (const n of nodes) {
      if (n.support !== 'none') used.add(n.id);
    }

    const autoKey = (nid: number) => -(nid + 1); // negative keys — never clash with member ids

    for (const [id, mesh] of this.transverseMeshes) {
      if (mesh.userData.storedTransverse) continue;
      const nid = -id - 1;
      if (!used.has(nid)) {
        this.transverseGroup.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        this.transverseMeshes.delete(id);
      }
    }

    const depth = TRUSS_HALF_DEPTH * 2;
    for (const id of used) {
      const n = findNodeById(nodes, id);
      if (!n) continue;
      const key = autoKey(id);

      let mesh = this.transverseMeshes.get(key);
      if (!mesh) {
        const geo = new THREE.CylinderGeometry(
          TRANSVERSE_RADIUS,
          TRANSVERSE_RADIUS,
          1,
          8,
        );
        geo.rotateX(Math.PI / 2);
        const mat = new THREE.MeshStandardMaterial({
          color: n.isDeck ? 0x8d6e63 : 0xa1887f,
          roughness: 0.75,
        });
        mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.userData.autoMirrorTransverse = true;
        this.transverseGroup.add(mesh);
        this.transverseMeshes.set(key, mesh);
      }

      mesh.scale.set(1, 1, depth);
      const pn = this.displacedXY(n);
      mesh.position.set(pn.x, pn.y, 0);
    }
  }

  setPreview(
    from: Vec2 | null,
    to: Vec2 | null,
    valid: boolean,
    curved = false,
    opts?: { transverse?: boolean },
  ): void {
    while (this.previewGroup.children.length) {
      const c = this.previewGroup.children[0]!;
      this.previewGroup.remove(c);
      if (c instanceof THREE.Line) {
        c.geometry.dispose();
        (c.material as THREE.Material).dispose();
      } else if (c instanceof THREE.Mesh) {
        c.geometry.dispose();
        (c.material as THREE.Material).dispose();
      }
    }
    if (!from || !to) return;

    const color = valid ? 0x4fc3f7 : 0xef5350;
    const mat = new THREE.LineBasicMaterial({ color });

    // Melintang: preview line across the roadway gap in Z
    if (opts?.transverse || this.wallMode === 'melintang') {
      const pts = [
        new THREE.Vector3(from.x, from.y, laneZ(OUTER_LANE_KIRI)),
        new THREE.Vector3(to.x, to.y, laneZ(OUTER_LANE_KANAN)),
      ];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      this.previewGroup.add(new THREE.Line(geo, mat));
      return;
    }

    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const rise = Math.min(1, Math.max(0.5, len * 0.35));
    let px = -dy / len;
    let py = dx / len;
    if (py < 0) {
      px = -px;
      py = -py;
    }
    const apex =
      Math.abs(dy) < 1e-9 || py < 0.25
        ? { x: mx, y: my + rise }
        : { x: mx + px * rise, y: my + py * rise };

    // Single stick on active outer wall; advanced mirror shows both walls.
    const previewZs = this.wallZsForMember(this.activeWallLane);
    for (const z of previewZs) {
      let pts: THREE.Vector3[];
      if (curved) {
        pts = [];
        const steps = 12;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const u = 1 - t;
          const x = u * u * from.x + 2 * u * t * apex.x + t * t * to.x;
          const y = u * u * from.y + 2 * u * t * apex.y + t * t * to.y;
          pts.push(new THREE.Vector3(x, y, z));
        }
      } else {
        pts = [
          new THREE.Vector3(from.x, from.y, z),
          new THREE.Vector3(to.x, to.y, z),
        ];
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      this.previewGroup.add(new THREE.Line(geo, mat));
    }
  }

  setLoadArrow(node: NodeDef | undefined, magnitude: number, visible: boolean): void {
    while (this.loadArrow.children.length) {
      const c = this.loadArrow.children[0]!;
      this.loadArrow.remove(c);
      if (c instanceof THREE.Mesh) {
        c.geometry.dispose();
        (c.material as THREE.Material).dispose();
      }
    }
    if (!visible || !node) return;

    const len = 0.4 + Math.min(magnitude / 40, 1.2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xef5350 });
    const loadZs = this.autoMirrorDepth
      ? [0, laneZ(OUTER_LANE_KIRI) * 0.5, laneZ(OUTER_LANE_KANAN) * 0.5]
      : [0];
    for (const z of loadZs) {
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, len, 8), mat);
      shaft.position.set(node.x, node.y - len / 2 - 0.2, z);
      shaft.castShadow = true;
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.22, 12), mat);
      head.rotation.z = Math.PI;
      head.position.set(node.x, node.y - len - 0.3, z);
      head.castShadow = true;
      this.loadArrow.add(shaft, head);
    }
  }

  highlightNode(id: number | null): void {
    for (const [nid, meshes] of this.nodeMeshes) {
      const s = nid === id ? 1.45 : 1;
      for (const mesh of meshes) mesh.scale.setScalar(s);
    }
  }

  /** Ghost node preview where a free joint would be created. */
  setGhostNode(pos: Vec2 | null): void {
    const existing = this.previewGroup.children.find((c) => c.userData.ghost);
    if (existing) {
      this.previewGroup.remove(existing);
      if (existing instanceof THREE.Mesh) {
        existing.geometry.dispose();
        (existing.material as THREE.Material).dispose();
      }
    }
    if (!pos) return;
    const geo = new THREE.SphereGeometry(NODE_RADIUS * 0.9, 10, 10);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x4fc3f7,
      transparent: true,
      opacity: 0.55,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const gz =
      this.wallMode === 'lantai'
        ? 0
        : laneZ(this.activeWallLane);
    mesh.position.set(pos.x, this.wallMode === 'lantai' ? 0 : pos.y, gz);
    mesh.userData.ghost = true;
    this.previewGroup.add(mesh);
  }

  worldFromClient(clientX: number, clientY: number, rect: DOMRect): Vec2 {
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = new THREE.Vector3();

    // Melintang camera sits near z≈0 looking along the roadway; the mid-span
    // build plane (z=0) is nearly parallel to the view ray, so hits break and
    // only some heights work. Raycast both outer wall planes instead and map
    // to XY — every grid height on lane 0 and lane 6 is pickable.
    if (this.wallMode === 'melintang') {
      let bestDist = Infinity;
      let bestLane = this.activeWallLane;
      const candidate = new THREE.Vector3();
      for (const lane of OUTER_LANES) {
        const z = laneZ(lane);
        const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z);
        if (!this.raycaster.ray.intersectPlane(plane, candidate)) continue;
        const d = this.raycaster.ray.origin.distanceTo(candidate);
        if (d >= 0 && d < bestDist) {
          bestDist = d;
          bestLane = lane;
          hit.copy(candidate);
        }
      }
      if (bestDist < Infinity) {
        this.activeWallLane = bestLane;
        return { x: hit.x, y: hit.y };
      }
    }

    if (!this.raycaster.ray.intersectPlane(this.buildPlane, hit)) {
      const dir = this.raycaster.ray.direction.clone();
      const t = -this.raycaster.ray.origin.z / (dir.z || 1e-6);
      hit.copy(this.raycaster.ray.origin).addScaledVector(dir, t);
    }
    return { x: hit.x, y: hit.y };
  }

  nearestNode(nodes: NodeDef[], world: Vec2, maxDist = 0.5): NodeDef | null {
    let best: NodeDef | null = null;
    let bestD = maxDist;
    for (const n of nodes) {
      const d = Math.hypot(n.x - world.x, n.y - world.y);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
  }

  private _lastTick = performance.now();

  render(): void {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this._lastTick) / 1000);
    this._lastTick = now;
    this.tickBreakAnims(now);
    this.tickPulse(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.controls.dispose();
    this.renderer.dispose();
    if (this.groundMesh) {
      this.groundMesh.geometry.dispose();
      (this.groundMesh.material as THREE.Material).dispose();
    }
  }
}
