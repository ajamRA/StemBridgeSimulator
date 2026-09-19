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
  BASE_RAIL_TARGET,
  DECK_POINTS,
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
import type { WallMode } from '../engine/types';
import { findNodeById, memberLength } from '../engine/model';
import { utilizationColor } from '../engine/solver';
import type { MemberDef, MemberResult, NodeDef, Vec2 } from '../engine/types';

const MEMBER_RADIUS = 0.055;
const BASE_RADIUS = 0.048;
const TRANSVERSE_RADIUS = 0.04;
const NODE_RADIUS = 0.09;
const Z_NEAR = TRUSS_HALF_DEPTH;
const Z_FAR = -TRUSS_HALF_DEPTH;

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
  /** Advanced: duplicate side-truss to both outer walls + transverse braces. Default OFF. */
  private autoMirrorDepth = false;
  /** Through-truss side: kiri=lane0, kanan=lane6, auto=nearest outer. */
  private wallMode: WallMode = 'kiri';
  private activeWallLane: number = OUTER_LANE_KIRI;

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

  setWallMode(mode: WallMode): void {
    this.wallMode = mode;
    if (mode === 'kiri') this.activeWallLane = OUTER_LANE_KIRI;
    else if (mode === 'kanan') this.activeWallLane = OUTER_LANE_KANAN;
    this.syncBuildPlane();
    this.buildGrid();
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
    const z = laneZ(this.activeWallLane);
    this.buildPlane.set(new THREE.Vector3(0, 0, 1), -z);
  }

  private wallZsForMember(zLane?: number): number[] {
    if (this.autoMirrorDepth) {
      return [laneZ(OUTER_LANE_KIRI), laneZ(OUTER_LANE_KANAN)];
    }
    const lane = zLane != null && isOuterLane(zLane) ? zLane : this.activeWallLane;
    return [laneZ(lane)];
  }

  private clearTransverse(): void {
    for (const [, mesh] of this.transverseMeshes) {
      this.transverseGroup.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.transverseMeshes.clear();
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

    // Deck roadway: 7 parallel base lines (middle = laluan, outer = dinding)
    const roadPts: THREE.Vector3[] = [];
    const wallPts: THREE.Vector3[] = [];
    for (let lane = 0; lane < BASE_RAIL_TARGET; lane++) {
      const z = laneZ(lane);
      const pair = [
        new THREE.Vector3(0, 0.02, z),
        new THREE.Vector3(SPAN * GRID, 0.02, z),
      ];
      if (isOuterLane(lane)) wallPts.push(...pair);
      else roadPts.push(...pair);
    }
    this.gridGroup.add(
      new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(roadPts),
        new THREE.LineBasicMaterial({
          color: 0x90caf9,
          transparent: true,
          opacity: 0.4,
        }),
      ),
    );
    this.gridGroup.add(
      new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(wallPts),
        new THREE.LineBasicMaterial({
          color: 0xffb74d,
          transparent: true,
          opacity: 0.75,
        }),
      ),
    );

    // 12×7 deck magnets — outer lanes "dinding truss", middle "laluan"
    const magnetGeo = new THREE.SphereGeometry(0.08, 10, 10);
    const roadMat = new THREE.MeshStandardMaterial({
      color: 0xbbdefb,
      emissive: 0x1565c0,
      emissiveIntensity: 0.08,
      transparent: true,
      opacity: 0.7,
      roughness: 0.55,
    });
    const wallDeckMat = new THREE.MeshStandardMaterial({
      color: 0xffe0b2,
      emissive: 0xe65100,
      emissiveIntensity: 0.18,
      transparent: true,
      opacity: 0.95,
      roughness: 0.5,
    });
    for (let xi = 0; xi < DECK_POINTS; xi++) {
      const x = xi * GRID;
      for (let lane = 0; lane < BASE_RAIL_TARGET; lane++) {
        const outer = isOuterLane(lane);
        const mesh = new THREE.Mesh(magnetGeo, outer ? wallDeckMat : roadMat);
        mesh.position.set(x, 0.04, laneZ(lane));
        mesh.userData.deckMagnet = true;
        mesh.userData.xIndex = xi;
        mesh.userData.zLane = lane;
        mesh.userData.laneRole = outer ? 'dinding' : 'laluan';
        this.gridGroup.add(mesh);
      }
    }

    // Vertical snap grids / height points ONLY on outer walls (no mid-plane cage)
    const heightGeo = new THREE.SphereGeometry(0.07, 10, 10);
    const heightMatIdle = new THREE.MeshStandardMaterial({
      color: 0xffcc80,
      emissive: 0xbf360c,
      emissiveIntensity: 0.12,
      transparent: true,
      opacity: 0.85,
      roughness: 0.5,
    });
    const heightMatActive = new THREE.MeshStandardMaterial({
      color: 0xfff176,
      emissive: 0xf57f17,
      emissiveIntensity: 0.35,
      transparent: true,
      opacity: 0.98,
      roughness: 0.4,
    });
    for (const lane of OUTER_LANES) {
      const z = laneZ(lane);
      const active = lane === this.activeWallLane;
      const mat = active ? heightMatActive : heightMatIdle;
      // Vertical guide lines
      const vPts: THREE.Vector3[] = [];
      for (let xi = 0; xi < DECK_POINTS; xi++) {
        const x = xi * GRID;
        vPts.push(new THREE.Vector3(x, 0, z));
        vPts.push(new THREE.Vector3(x, MAX_HEIGHT * GRID, z));
      }
      // Horizontal levels on this wall
      for (let yi = 1; yi <= MAX_HEIGHT; yi++) {
        const y = yi * GRID;
        vPts.push(new THREE.Vector3(0, y, z));
        vPts.push(new THREE.Vector3(SPAN * GRID, y, z));
      }
      this.gridGroup.add(
        new THREE.LineSegments(
          new THREE.BufferGeometry().setFromPoints(vPts),
          new THREE.LineBasicMaterial({
            color: active ? 0xffee58 : 0xffa726,
            transparent: true,
            opacity: active ? 0.55 : 0.28,
          }),
        ),
      );
      for (let yi = 1; yi <= MAX_HEIGHT; yi++) {
        const y = yi * GRID;
        for (let xi = 0; xi < DECK_POINTS; xi++) {
          const mesh = new THREE.Mesh(heightGeo, mat);
          mesh.position.set(xi * GRID, y, z);
          mesh.userData.wallMagnet = true;
          mesh.userData.zLane = lane;
          mesh.userData.yIndex = yi;
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
      const zs =
        n.support !== 'none' || this.autoMirrorDepth
          ? [laneZ(OUTER_LANE_KIRI), laneZ(OUTER_LANE_KANAN)]
          : [laneZ(this.activeWallLane)];

      for (const z of zs) {
        const geo = new THREE.SphereGeometry(r, 12, 12);
        const mat = new THREE.MeshStandardMaterial({
          color,
          transparent: zs.length === 1,
          opacity: zs.length === 1 ? 0.85 : 1,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(n.x, n.y, z);
        mesh.userData.nodeId = n.id;
        mesh.castShadow = true;
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
        for (const mesh of meshes) {
          this.memberGroup.remove(mesh);
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        }
        this.archMeshes.delete(gid);
      }
    }

    const archLegIds = new Set<number>();
    for (const [gid, g] of archGroups) {
      for (const leg of g.legs) archLegIds.add(leg.id);
      const [c1, c2] = g.chord;
      const a = findNodeById(nodes, c1);
      const b = findNodeById(nodes, c2);
      if (!a || !b) continue;
      const endIds = new Set([c1, c2]);
      const apexId = g.legs
        .flatMap((l) => [l.n1, l.n2])
        .find((id) => !endIds.has(id));
      const apex = apexId != null ? findNodeById(nodes, apexId) : undefined;
      if (!apex) continue;

      // Quadratic Bezier through ends with apex as curve midpoint
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const ctrl = {
        x: 2 * apex.x - mid.x,
        y: 2 * apex.y - mid.y,
      };

      let color = g.role === 'base' ? 0xc8a882 : 0xa1887f;
      // Colour by worst utilization of the two legs
      for (const leg of g.legs) {
        const rr = resultMap.get(leg.id);
        if (rr) {
          color = utilizationColor(rr.utilization);
          if (highlightFailed && rr.failed) color = 0x7f0000;
        }
      }

      const isBase = g.role === 'base' && g.zLane != null;
      const zs = isBase ? [laneZ(g.zLane!)] : this.wallZsForMember(g.zLane);
      const radius = isBase ? BASE_RADIUS : MEMBER_RADIUS;

      let meshes = this.archMeshes.get(gid);
      const needRebuild =
        !meshes ||
        meshes.length !== zs.length ||
        meshes.some((mesh) => mesh.userData.archKey !== `${apex.x.toFixed(3)},${apex.y.toFixed(3)}`);
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
          mesh.userData.archKey = `${apex.x.toFixed(3)},${apex.y.toFixed(3)}`;
          mesh.userData.memberId = g.legs[0]!.id;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          this.memberGroup.add(mesh);
          return mesh;
        });
        this.archMeshes.set(gid, meshes);
      } else {
        for (const mesh of meshes!) {
          (mesh.material as THREE.MeshStandardMaterial).color.setHex(color);
        }
      }
    }

    // --- Straight members (skip arch legs — already drawn as smooth tubes) ---
    const straightIds = new Set(
      members.filter((m) => m.archGroupId == null).map((m) => m.id),
    );
    for (const [id, meshes] of this.memberMeshes) {
      if (!straightIds.has(id)) {
        for (const mesh of meshes) {
          this.memberGroup.remove(mesh);
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        }
        this.memberMeshes.delete(id);
      }
    }

    for (const m of members) {
      if (m.archGroupId != null) continue;
      const a = findNodeById(nodes, m.n1)!;
      const b = findNodeById(nodes, m.n2)!;
      const L = memberLength(nodes, m);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);

      let color = m.role === 'base' ? 0xc8a882 : 0xa1887f;
      const r = resultMap.get(m.id);
      if (r) {
        color = utilizationColor(r.utilization);
        if (highlightFailed && r.failed) color = 0x7f0000;
      }

      const isBase = m.role === 'base' && m.zLane != null;
      const zs = isBase ? [laneZ(m.zLane!)] : this.wallZsForMember(m.zLane);
      const radius = isBase ? BASE_RADIUS : MEMBER_RADIUS;

      let meshes = this.memberMeshes.get(m.id);
      if (!meshes || meshes.length !== zs.length) {
        if (meshes) {
          for (const mesh of meshes) {
            this.memberGroup.remove(mesh);
            mesh.geometry.dispose();
            (mesh.material as THREE.Material).dispose();
          }
        }
        meshes = zs.map(() => {
          const geo = new THREE.CylinderGeometry(radius, radius, 1, 8);
          geo.rotateZ(Math.PI / 2);
          const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.userData.memberId = m.id;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          this.memberGroup.add(mesh);
          return mesh;
        });
        this.memberMeshes.set(m.id, meshes);
      }

      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i]!;
        const z = zs[i]!;
        mesh.scale.set(L, 1, 1);
        mesh.position.set(mx, my, z);
        mesh.rotation.set(0, 0, angle);
        (mesh.material as THREE.MeshStandardMaterial).color.setHex(color);
      }
    }

    void archLegIds;
    this.syncTransverse(nodes, members);
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

    for (const [id, mesh] of this.transverseMeshes) {
      if (!used.has(id)) {
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

      let mesh = this.transverseMeshes.get(id);
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
        this.transverseGroup.add(mesh);
        this.transverseMeshes.set(id, mesh);
      }

      mesh.scale.set(1, 1, depth);
      mesh.position.set(n.x, n.y, 0);
    }
  }

  setPreview(
    from: Vec2 | null,
    to: Vec2 | null,
    valid: boolean,
    curved = false,
  ): void {
    while (this.previewGroup.children.length) {
      const c = this.previewGroup.children[0]!;
      this.previewGroup.remove(c);
      if (c instanceof THREE.Line) {
        c.geometry.dispose();
        (c.material as THREE.Material).dispose();
      }
    }
    if (!from || !to) return;

    const color = valid ? 0x4fc3f7 : 0xef5350;
    const mat = new THREE.LineBasicMaterial({ color });

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
    mesh.position.set(pos.x, pos.y, laneZ(this.activeWallLane));
    mesh.userData.ghost = true;
    this.previewGroup.add(mesh);
  }

  worldFromClient(clientX: number, clientY: number, rect: DOMRect): Vec2 {
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = new THREE.Vector3();
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

  render(): void {
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
