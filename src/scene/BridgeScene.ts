/**
 * True 3D Three.js bridge view (PerspectiveCamera + OrbitControls).
 *
 * PHYSICS NOTE (MVP): Direct Stiffness Method remains 2D axial-only on the
 * primary XY truss. Near/far Z planes are visual auto-mirrors of the same
 * members so students see a stick bridge in depth without 3D node picking.
 * Stress colours / Test / progressive failure still come from that 2D solve.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GRID, MAX_HEIGHT, SPAN, TRUSS_HALF_DEPTH } from '../engine/constants';
import { findNodeById, memberLength } from '../engine/model';
import { utilizationColor } from '../engine/solver';
import type { MemberDef, MemberResult, NodeDef, Vec2 } from '../engine/types';

const MEMBER_RADIUS = 0.06;
const TRANSVERSE_RADIUS = 0.045;
const NODE_RADIUS = 0.1;
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
  /** Mid build plane (z=0) — picking projects to XY; sticks auto-mirror to ±Z. */
  private buildPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

  private memberMeshes = new Map<number, { near: THREE.Mesh; far: THREE.Mesh }>();
  private nodeMeshes = new Map<number, { near: THREE.Mesh; far: THREE.Mesh }>();
  private transverseMeshes = new Map<number, THREE.Mesh>();

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
    // Default framing: slightly elevated 3/4 view so depth is obvious
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

  /** Temporarily lock orbit while the user is placing / deleting members. */
  setOrbitEnabled(enabled: boolean): void {
    this.controls.enabled = enabled;
  }

  private buildGround(): void {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x3e4a3a,
      roughness: 0.9,
      metalness: 0.05,
    });
    const ground = new THREE.Mesh(new THREE.BoxGeometry(SPAN + 6, 0.25, 6), mat);
    ground.position.set(SPAN / 2, -0.55, 0);
    ground.receiveShadow = true;
    this.root.add(ground);
    this.groundMesh = ground;

    // Soft river / gap under the span
    const water = new THREE.Mesh(
      new THREE.BoxGeometry(SPAN - 1.2, 0.08, 3.2),
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

    makePlaneGrid(Z_NEAR, 0.55);
    makePlaneGrid(Z_FAR, 0.4);

    // Deck snap strip between planes (helps read depth)
    const deckPts: THREE.Vector3[] = [];
    for (let x = 0; x <= SPAN; x++) {
      deckPts.push(new THREE.Vector3(x * GRID, 0, Z_NEAR));
      deckPts.push(new THREE.Vector3(x * GRID, 0, Z_FAR));
    }
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const z = Z_NEAR + (Z_FAR - Z_NEAR) * t;
      deckPts.push(new THREE.Vector3(0, 0, z));
      deckPts.push(new THREE.Vector3(SPAN * GRID, 0, z));
    }
    this.gridGroup.add(
      new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(deckPts),
        new THREE.LineBasicMaterial({
          color: 0x5a6a7c,
          transparent: true,
          opacity: 0.35,
        }),
      ),
    );
  }

  private buildAbutments(): void {
    while (this.abutmentGroup.children.length) {
      const c = this.abutmentGroup.children[0]!;
      this.abutmentGroup.remove(c);
    }

    const depth = TRUSS_HALF_DEPTH * 2 + 0.6;
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

    // Pin markers on both faces
    const pinMat = new THREE.MeshStandardMaterial({ color: 0xffca28 });
    for (const z of [Z_NEAR, Z_FAR]) {
      const pin = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.26, 3), pinMat);
      pin.rotation.z = Math.PI;
      pin.position.set(0, -0.02, z);
      pin.castShadow = true;
      this.abutmentGroup.add(pin);
    }

    // Roller markers on both faces
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
      else if (n.isDeck) color = 0xcfd8dc;

      const make = (z: number) => {
        const r = n.isApex ? NODE_RADIUS * 0.75 : NODE_RADIUS;
        const geo = new THREE.SphereGeometry(r, 12, 12);
        const mat = new THREE.MeshStandardMaterial({ color });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(n.x, n.y, z);
        mesh.userData.nodeId = n.id;
        mesh.castShadow = true;
        this.nodeGroup.add(mesh);
        return mesh;
      };

      this.nodeMeshes.set(n.id, { near: make(Z_NEAR), far: make(Z_FAR) });
    }
  }

  syncMembers(
    nodes: NodeDef[],
    members: MemberDef[],
    results: MemberResult[] | null,
    highlightFailed = false,
  ): void {
    const ids = new Set(members.map((m) => m.id));
    for (const [id, pair] of this.memberMeshes) {
      if (!ids.has(id)) {
        for (const mesh of [pair.near, pair.far]) {
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

      let color = 0xa1887f;
      const r = resultMap.get(m.id);
      if (r) {
        color = utilizationColor(r.utilization);
        if (highlightFailed && r.failed) color = 0x7f0000;
      }

      let pair = this.memberMeshes.get(m.id);
      if (!pair) {
        const make = () => {
          const geo = new THREE.CylinderGeometry(MEMBER_RADIUS, MEMBER_RADIUS, 1, 8);
          geo.rotateZ(Math.PI / 2);
          const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.userData.memberId = m.id;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          this.memberGroup.add(mesh);
          return mesh;
        };
        pair = { near: make(), far: make() };
        this.memberMeshes.set(m.id, pair);
      }

      for (const [mesh, z] of [
        [pair.near, Z_NEAR],
        [pair.far, Z_FAR],
      ] as const) {
        mesh.scale.set(L, 1, 1);
        mesh.position.set(mx, my, z);
        mesh.rotation.set(0, 0, angle);
        (mesh.material as THREE.MeshStandardMaterial).color.setHex(color);
      }
    }

    this.syncTransverse(nodes, members);
  }

  /**
   * Visual-only near↔far connectors at every node that participates in a member.
   * CRITICAL: these must NEVER be pushed into the 2D `members` list — they have
   * zero XY length and would make the DSM stiffness matrix singular.
   */
  private syncTransverse(nodes: NodeDef[], members: MemberDef[]): void {
    const used = new Set<number>();
    for (const m of members) {
      used.add(m.n1);
      used.add(m.n2);
    }
    // Always show transverse at supports for abutment context
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
        // Align cylinder along Z (default is Y)
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

    for (const z of [Z_NEAR, Z_FAR]) {
      let pts: THREE.Vector3[];
      if (curved) {
        // Quadratic Bezier through upward apex (matches Lengkung placement)
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
    // Cross preview on deck connection
    const crossGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(to.x, to.y, Z_NEAR),
      new THREE.Vector3(to.x, to.y, Z_FAR),
    ]);
    this.previewGroup.add(new THREE.Line(crossGeo, mat.clone()));
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
    // Show load on both faces + mid
    for (const z of [0, Z_NEAR * 0.5, Z_FAR * 0.5]) {
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
    for (const [nid, pair] of this.nodeMeshes) {
      const s = nid === id ? 1.45 : 1;
      pair.near.scale.setScalar(s);
      pair.far.scale.setScalar(s);
    }
  }

  /** Raycast to the mid XY build plane; sticks are auto-mirrored to near/far. */
  worldFromClient(clientX: number, clientY: number, rect: DOMRect): Vec2 {
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.buildPlane, hit)) {
      // Fallback: project along camera ray at origin distance
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
