/**
 * Melintang picking: side camera sits at z≈0 with look-at also at z=0, so the
 * mid-span build plane is coplanar with the view ray (degenerate). Raycast both
 * outer wall planes instead — every grid height on lane 0 and 6 is pickable.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { OUTER_LANES, laneZ, MAX_HEIGHT, GRID, SPAN } from '../engine/constants';
import { gridYValues } from '../engine/grid';

function hitNearestOuterWall(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
): { x: number; y: number; lane: number } | null {
  const ray = new THREE.Ray(origin, direction.clone().normalize());
  let bestDist = Infinity;
  let best: { x: number; y: number; lane: number } | null = null;
  const candidate = new THREE.Vector3();
  for (const lane of OUTER_LANES) {
    const z = laneZ(lane);
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z);
    if (!ray.intersectPlane(plane, candidate)) continue;
    const d = ray.origin.distanceTo(candidate);
    if (d >= 0 && d < bestDist) {
      bestDist = d;
      best = { x: candidate.x, y: candidate.y, lane };
    }
  }
  return best;
}

describe('Melintang dual-wall plane picking', () => {
  it('can aim at every grid height on both outer walls', () => {
    const cam = new THREE.Vector3(SPAN / 2 + 9, MAX_HEIGHT * GRID + 3.5, 0);
    for (const lane of OUTER_LANES) {
      const z = laneZ(lane);
      for (const y of gridYValues()) {
        const target = new THREE.Vector3(SPAN / 2, y, z);
        const dir = target.clone().sub(cam).normalize();
        const hit = hitNearestOuterWall(cam, dir);
        expect(hit).not.toBeNull();
        expect(hit!.lane).toBe(lane);
        expect(hit!.y).toBeCloseTo(y, 5);
        expect(hit!.x).toBeCloseTo(SPAN / 2, 5);
      }
    }
  });

  it('prefers the nearer of the two outer walls', () => {
    const cam = new THREE.Vector3(SPAN / 2 + 9, 1.5, 0);
    const nearLane = OUTER_LANES[0]!;
    const target = new THREE.Vector3(SPAN / 2, 1, laneZ(nearLane));
    const hit = hitNearestOuterWall(cam, target.clone().sub(cam));
    expect(hit?.lane).toBe(nearLane);
  });
});
