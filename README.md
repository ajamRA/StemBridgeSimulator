# StemBridge Simulator — Jambatan Lidi

Educational MVP: build a **true 3D** stick (truss) bridge in Three.js, apply a deck load, and test it with a **Direct Stiffness Method** axial-only solver. Members are coloured by utilisation; overstressed sticks fail progressively.

Intended remote: `https://github.com/ajamRA/StemBridgeSimulator.git`  
*(Create the project locally first, then push when ready — this repo is not cloned automatically.)*

## Stack

- Vite + TypeScript
- Three.js **PerspectiveCamera** + **OrbitControls** (orbit / pan / zoom)
- Freer classroom build: soft-snap nodes, arbitrary angles, **7 parallel base rails**
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
npm test         # DSM + length/base-rail checks (vitest)
```

## Classroom workflow — 7 lidi panjang as base

Matches a real popsicle-stick / lidi challenge (reference patterns A–J):

1. Click **`+ Base (lidi panjang)`** up to **7** times — each click drops **one full-span stick** (left abutment → right) in the next free Z lane across the deck width.
2. Watch the counter: **`Base panjang: n/7`**.
3. Switch to **Pendek** (or Auto) and brace: verticals, diagonals, cross-braces between nodes — **any angle** is allowed when ends snap to nodes.
4. Optional: click empty space to place a **free joint** (soft grid magnet), then connect two nodes with Lurus / Lengkung.
5. **Uji** — DSM stress colours; overstressed sticks fail progressively.

Tip shown in-app: *“Susun 7 lidi panjang sebagai base, kemudian brace dengan pendek.”*

## 3D view

The canvas is a real 3D scene — left-drag to orbit, scroll to zoom, right-drag (or Shift+left-drag) to pan.

- **7 green deck lane guides** show where parallel base rails sit (Z lanes 0…6).
- Side-truss sticks still render on near/far faces with light transverse braces.
- Soft magnet dots on the mid plane; free joints appear teal.

## How to play

1. **Bina**
   - **`+ Base`** — one-click full-span Panjang rail (preferred for the 7-stick deck).
   - Or click two nodes / click-drag; **Panjang** allows chords up to the full span (10).
   - Click empty space → soft-snapped free node, then click a second node to connect.
   - **Lurus** vs **Lengkung** (Lengkung inserts an upward apex + two axial legs).
2. Supports: left **pin**, right **roller**, span 10.
3. Adjust **Beban** (vertical load on mid-span deck node).
4. **Uji** — sticks colour green → yellow → orange → red → dark red (fail).
5. **Padam** / **Undo** / **Reset** as needed.

## Stick length presets

| Preset | Meaning |
|--------|---------|
| **Pendek** | Short braces — length ≲ 1.75 |
| **Sederhana** | Medium — length ≲ 3.6 |
| **Panjang** | Long chords up to **full span** (one placement) |
| **Auto** | Any length between ~0.45 and span |

Angles are unrestricted (not only ortho / 45°) as long as both ends are nodes.

## Physics notes

| Constant | Value | Meaning |
|----------|------:|---------|
| `AREA` (A) | 1 | Relative cross-section |
| `E` | 2000 | Young's modulus (relative) |
| `TENSION_CAPACITY` | 50 | Max \|F\| in tension |
| `COMPRESSION_CAPACITY` | 30 | Max \|F\| in compression (lower — buckling) |
| `BASE_RAIL_TARGET` | 7 | Classroom parallel base count |

- **MVP physics = 2D axial DSM** on the primary XY truss.
- **Multi-rail deck is approximate:** only the **first** base rail is structural in `K`; the other parallel lanes are `visualOnly` (same XY would otherwise duplicate stiffness). Side braces / free nodes still enter the solve normally. Near/far mirrors and transverse Z braces remain visual.
- Axial truss members only (no bending).
- Utilisation `u = |F| / capacity`. Fail when `u ≥ 1`.

Sanity test: symmetric two-bar truss vs analytical `F = P/√2` — see `src/engine/solver.test.ts`.  
Base-rail + freer length tests — see `src/engine/model.length.test.ts`.

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

- Physics is still planar axial DSM; multi-rail base is visual-first (one structural chord).
- Free nodes live in XY; Z lanes are for base rails only (not full free 3D picking).
- Single load point (mid-span deck); no multi-load patterns yet.
- Progressive failure removes all `u≥1` members each step (no timed animation).
