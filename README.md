# StemBridge Simulator — Jambatan Lidi

Educational MVP: build a **true 3D** stick (truss) bridge in Three.js, apply a deck load, and test it with a **Direct Stiffness Method** axial-only solver. Members are coloured by utilisation; overstressed sticks fail progressively.

Intended remote: `https://github.com/ajamRA/StemBridgeSimulator.git`  
*(Create the project locally first, then push when ready — this repo is not cloned automatically.)*

## Stack

- Vite + TypeScript
- Three.js **PerspectiveCamera** + **OrbitControls** (orbit / pan / zoom)
- Dual truss planes (near/far) with auto-mirrored sticks + transverse deck braces
- Plain HTML/CSS overlay (Malay-first UI)
- Custom 2D truss DSM solver (no Rapier/Cannon)

## Install & run

```bash
cd StemBridgeSimulator
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

```bash
npm run build    # production build
npm run preview  # preview build
npm test         # DSM sanity checks (vitest)
```

## 3D view

The canvas is a real 3D scene — left-drag to orbit around the bridge, scroll to zoom, right-drag (or Shift+left-drag) to pan.

- **Near** and **Far** truss planes are separated in Z (`TRUSS_HALF_DEPTH`).
- Building is still simple: pick nodes on the XY snap grid; each stick is **auto-mirrored** to both faces and connected by transverse braces so students get a 3D stick-bridge look without complex 3D node picking.
- Snap grids are drawn on both truss planes plus a light deck strip between them.

## How to play

1. **Bina** — click two grid nodes (or click-drag) to place a stick. Use the **Lidi** picker (Pendek / Sederhana / Panjang / Auto) so base chords are Panjang and bracing is Pendek; **Lurus** vs **Lengkung** (Lengkung inserts an upward apex node + two axial legs so the arch carries load in the 2D DSM). One placement builds **both** sides.
2. Supports: left **pin**, right **roller**, span 10. Yellow pin / blue rollers on abutments.
3. Adjust **Beban** (vertical load on mid-span deck node).
4. **Uji** — solve; sticks colour green → yellow → orange → red → dark red (fail). Failed members are removed and the structure is re-solved.
5. **Padam** / **Undo** / **Reset** as needed.
6. Camera: left-drag orbit, scroll zoom, right-drag or Shift+left pan.

If the stiffness matrix is singular, the panel says the structure is unstable — add triangles/bracing.

## Physics notes

| Constant | Value | Meaning |
|----------|------:|---------|
| `AREA` (A) | 1 | Relative cross-section |
| `E` | 2000 | Young's modulus (relative) |
| `TENSION_CAPACITY` | 50 | Max \|F\| in tension |
| `COMPRESSION_CAPACITY` | 30 | Max \|F\| in compression (lower — buckling) |

- **MVP physics = 2D axial DSM** on the primary XY truss (applied conceptually to each mirrored side). Out-of-plane / torsion is not solved; Near/Far auto-mirror and transverse Z braces are **visual only** and are never assembled into `K` (zero XY length would make the matrix singular).
- Axial truss members only (no bending).
- Assemble global `K`, apply BCs (pin: ux=uy=0; roller: uy=0), solve `Ku=F`, recover member forces.
- Utilisation `u = |F| / capacity`. Fail when `u ≥ 1`.

Sanity test: symmetric two-bar truss vs analytical `F = P/√2` — see `src/engine/solver.test.ts`.

## Project layout

```
src/
  engine/   nodes, members, DSM solver, progressive failure
  scene/    Three.js perspective bridge view + OrbitControls
  ui/       Malay toolbar + result panel
  levels/   default span-10 level
  game/     input + mode controller
```

## Known limitations

- Physics is still planar axial DSM (mirrored sides share the same forces / colours).
- No true 3D node picking or independent near/far editing (auto-mirror for classroom simplicity).
- Single load point (mid-span deck); no multi-load patterns yet.
- Progressive failure removes all `u≥1` members each step (no timed animation).
