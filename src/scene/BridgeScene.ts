/**
 * True 3D Three.js bridge view (PerspectiveCamera + OrbitControls).
 *
 * PHYSICS NOTE (MVP): Direct Stiffness Method remains 2D axial-only on the
 * primary XY truss. Deck base rails use Z lanes (up to 7 parallel lidi panjang);
 * only the first structural base chord enters the DSM — extra lanes are visual.
 *
 * DEFAULT UX: one placed member = one cylinder (mid-plane / its Z lane).
 * Optional advanced "auto-mirror depth" duplicates side-truss sticks to
 * near+far and adds transverse braces (creates a box look) — OFF by default.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  BASE_RAIL_TARGET,
  GRID,
  laneZ,
  MAX_HEIGHT,
  SPAN,
  TRUSS_HALF_DEPTH,
} from '../engine/constants';
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
  /** Mid build plane (z=0) — picking projects to XY. */
  private buildPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

  private memberMeshes = new Map<number, THREE.Mesh[]>();
  private nodeMeshes = new Map<number, THREE.Mesh[]>();
  private transverseMeshes = new Map<number, THREE.Mesh>();
  /** Advanced: duplicate side-truss to near/far + transverse braces. Default OFF. */
  private autoMirrorDepth = false;

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

    const lookAt = new THREE.Vector3(SPAN / 2, MAX_HEIGHT / 2 + 0.2, 0);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    this.camera.position.set(SPAN / 2 + 6.5, MAX_HEIGHT + 4.5, 11);
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
      if (c instanceof THREE.LineSegments) {
        c.geometry.dispose();
        (c.material as THREE.Material).dispose();
      }
    }

    const makePlaneGrid = (z: number, opacity: number) => {
      const mat = new THREE.LineBasicMaterial({
        color: 0x3a4a5c,
        transparent: true,
        opacity,
      });
      const pts: THREE.Vector3[] = [];
      for (let x = 0; x <= SPAN; x++) {
        pts.push(new THREE.Vector3(x * GRID, 0, z));
        pts.push(new THREE.Vector3(x * GRID, MAX_HEIGHT * GRID, z));
      }
      for (let y = 0; y <= MAX_HEIGHT; y++) {
        pts.push(new THREE.Vector3(0, y * GRID, z));
        pts.push(new THREE.Vector3(SPAN * GRID, y * GRID, z));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      this.gridGroup.add(new THREE.LineSegments(geo, mat));
    };

    makePlaneGrid(Z_NEAR, 0.45);
    makePlaneGrid(Z_FAR, 0.32);

    // Soft magnet dots on mid plane (lighter — freer placement)
    const midPts: THREE.Vector3[] = [];
    for (let x = 0; x <= SPAN; x++) {
      for (let y = 0; y <= MAX_HEIGHT; y++) {
        const s = 0.06;
        midPts.push(new THREE.Vector3(x * GRID - s, y * GRID, 0));
        midPts.push(new THREE.Vector3(x * GRID + s, y * GRID, 0));
        midPts.push(new THREE.Vector3(x * GRID, y * GRID - s, 0));
        midPts.push(new THREE.Vector3(x * GRID, y * GRID + s, 0));
      }
    }
    this.gridGroup.add(
      new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(midPts),
        new THREE.LineBasicMaterial({
          color: 0x5a6a7c,
          transparent: true,
          opacity: 0.28,
        }),
      ),
    );

    // 7 deck lane guides (classroom parallel base rails)
    const deckPts: THREE.Vector3[] = [];
    for (let lane = 0; lane < BASE_RAIL_TARGET; lane++) {
      const z = laneZ(lane);
      deckPts.push(new THREE.Vector3(0, 0.01, z));
      deckPts.push(new THREE.Vector3(SPAN * GRID, 0.01, z));
    }
    for (let x = 0; x <= SPAN; x += 2) {
      deckPts.push(new THREE.Vector3(x * GRID, 0.01, Z_NEAR));
      deckPts.push(new THREE.Vector3(x * GRID, 0.01, Z_FAR));
    }
    this.gridGroup.add(
      new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(deckPts),
        new THREE.LineBasicMaterial({
          color: 0x81c784,
          transparent: true,
          opacity: 0.4,
        }),
      ),
    );
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
      let color = 0xb0bec5;
      if (n.support === 'pin') color = 0xffca28;
      else if (n.support === 'roller') color = 0x90caf9;
      else if (n.isApex) color = 0xce93d8;
      else if (n.isFree) color = 0x80cbc4;
      else if (n.isDeck) color = 0xcfd8dc;

      const meshes: THREE.Mesh[] = [];
      const r = n.isApex ? NODE_RADIUS * 0.75 : n.isFree ? NODE_RADIUS * 0.85 : NODE_RADIUS;

      // Default: single mid-plane joint. Advanced mirror: also show near/far faces.
      const zs =
        this.autoMirrorDepth && (n.support !== 'none' || n.isFree || n.isApex)
          ? [0, Z_NEAR * 0.85, Z_FAR * 0.85]
          : [0];

      for (const z of zs) {
        const geo = new THREE.SphereGeometry(r, 12, 12);
        const mat = new THREE.MeshStandardMaterial({
          color,
          transparent: zs.length === 1,
          opacity: zs.length === 1 ? 0.55 : 1,
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
    const ids = new Set(members.map((m) => m.id));
    for (const [id, meshes] of this.memberMeshes) {
      if (!ids.has(id)) {
        for (const mesh of meshes) {
          this.memberGroup.remove(mesh);
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        }
        this.memberMeshes.delete(id);
      }
    }

    const resultMap = new Map(results?.map((r) => [r.id, r]) ?? []);

    for (const m of members) {
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
      // Base: its Z lane only. Normal: mid-plane unless advanced auto-mirror.
      const zs = isBase
        ? [laneZ(m.zLane!)]
        : this.autoMirrorDepth
          ? [Z_NEAR, Z_FAR]
          : [0];
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

    // Single stick preview by default; advanced mirror shows near+far+mid.
    const previewZs = this.autoMirrorDepth ? [Z_NEAR, Z_FAR, 0] : [0];
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
    const loadZs = this.autoMirrorDepth ? [0, Z_NEAR * 0.5, Z_FAR * 0.5] : [0];
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
    mesh.position.set(pos.x, pos.y, 0);
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
