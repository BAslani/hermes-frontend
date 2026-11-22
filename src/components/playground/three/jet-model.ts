import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { AirplaneModel } from "./airplane-model";

/**
 * The playground jet: a downloaded F-14 glTF model (see
 * public/models/CREDITS.md), loaded on first use. Until it has loaded,
 * `ready()` is false and the layer draws the built-in trainer instead.
 *
 * The file is in decimetres with x forward, y up and z to the right. Here it
 * is turned into the flight code's body frame (x forward, y left, z up,
 * metres) with the centre of gravity at the origin, 1.2 m ahead of the
 * file's origin. The wheel contact points in JET_GEAR
 * (src/lib/flight/airplane.ts) were measured off this file in the same way.
 *
 * The model has no separate control surfaces, so little on it moves: the
 * gear swaps between its "gear down" and "gear up" parts, and the outer wing
 * panels, which are part of the one airframe mesh, are picked out by shape
 * at load and turned about their pivots for the swing-wing sweep.
 */
export const JET_MODEL_URL = "/models/f-14_tomcat_-_fighter_jet_-_free.glb";

/** Pilot's eye in the body frame: the front seat, under the canopy. */
export const JET_EYE: [number, number, number] = [6.8, 0, 1.05];

export interface JetModel extends AirplaneModel {
  ready(): boolean;
}

/*
 * The swing wing, in the airframe mesh's own frame: decimetres, x forward,
 * y sideways (±97.7 at the tips), z up. The file has the wings spread (about
 * 20° of sweep); fully swept is about 68°, so the panels turn 48° about a
 * pivot at each root, just inside the glove.
 */
const WING_PIVOT = { x: 2, y: 25 };
const WING_TRAVEL = (48 * Math.PI) / 180;

/** Whether a vertex is on an outer wing panel, by where it is. */
function onWing(x: number, y: number, z: number) {
  if (x <= -20 || x >= 22) return false;
  const out = Math.abs(y);
  // Far out there is nothing but wing; nearer in, the panel is the low, thin
  // part outboard of the nacelles (the glove's pylons and missiles sit higher,
  // its underside lower).
  return out > 50 || (out > 22.8 && z < -2 && z > -4.8);
}

interface Wings {
  geometry: THREE.BufferGeometry;
  /** Vertices that move, their rest positions, normals and tangents, and their side (+1 or −1). */
  moving: number[];
  rest: Float32Array;
  restNormal: Float32Array | null;
  restTangent: Float32Array | null;
  side: Int8Array;
}

/**
 * Pick out the outer wing panels' vertices: those `onWing` says, plus the
 * inner corners of the long panel triangles that reach into the glove from
 * out along the wing.
 */
function findWings(geometry: THREE.BufferGeometry): Wings | null {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  if (!position || !index) return null;
  const n = position.count;
  const chosen = new Uint8Array(n);
  for (let i = 0; i < n; i++)
    if (onWing(position.getX(i), position.getY(i), position.getZ(i)))
      chosen[i] = 1;
  for (let t = 0; t < index.count; t += 3) {
    const corners = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
    if (corners.some((k) => chosen[k] === 1 && Math.abs(position.getY(k)) > 40))
      for (const k of corners)
        if (!chosen[k] && Math.abs(position.getY(k)) > 20) chosen[k] = 2;
  }
  const moving: number[] = [];
  for (let i = 0; i < n; i++) if (chosen[i]) moving.push(i);
  if (moving.length === 0) return null;
  const normal = geometry.getAttribute("normal");
  const tangent = geometry.getAttribute("tangent");
  const rest = new Float32Array(moving.length * 3);
  const restNormal = normal ? new Float32Array(moving.length * 3) : null;
  const restTangent = tangent ? new Float32Array(moving.length * 3) : null;
  const side = new Int8Array(moving.length);
  moving.forEach((k, m) => {
    rest.set([position.getX(k), position.getY(k), position.getZ(k)], m * 3);
    restNormal?.set([normal.getX(k), normal.getY(k), normal.getZ(k)], m * 3);
    restTangent?.set(
      [tangent.getX(k), tangent.getY(k), tangent.getZ(k)],
      m * 3,
    );
    side[m] = position.getY(k) >= 0 ? 1 : -1;
  });
  return { geometry, moving, rest, restNormal, restTangent, side };
}

/** Sweep the wings back by `sweep` (0 spread as modelled, 1 fully swept). */
function sweepWings(wings: Wings, sweep: number) {
  const { geometry, moving, rest, restNormal, restTangent, side } = wings;
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const tangent = geometry.getAttribute("tangent");
  const angle = sweep * WING_TRAVEL;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  moving.forEach((k, m) => {
    // Left and right turn opposite ways, both trailing edges going aft.
    const sn = s * side[m];
    const py = WING_PIVOT.y * side[m];
    const dx = rest[m * 3] - WING_PIVOT.x;
    const dy = rest[m * 3 + 1] - py;
    position.setXY(k, WING_PIVOT.x + dx * c - dy * sn, py + dx * sn + dy * c);
    if (restNormal) {
      const nx = restNormal[m * 3];
      const ny = restNormal[m * 3 + 1];
      normal.setXY(k, nx * c - ny * sn, nx * sn + ny * c);
    }
    if (restTangent) {
      const tx = restTangent[m * 3];
      const ty = restTangent[m * 3 + 1];
      tangent.setXY(k, tx * c - ty * sn, tx * sn + ty * c);
    }
  });
  position.needsUpdate = true;
  if (restNormal) normal.needsUpdate = true;
  if (restTangent) tangent.needsUpdate = true;
}

export function createJetModel(): JetModel {
  const root = new THREE.Group();
  const holder = new THREE.Group();
  // File → body frame: body x = 0.1 (fx − 12), body y = −0.1 fz, body z = 0.1 fy.
  holder.matrixAutoUpdate = false;
  holder.matrix.set(0.1, 0, 0, -1.2, 0, 0, -0.1, 0, 0, 0.1, 0, 0, 0, 0, 0, 1);
  root.add(holder);

  let loaded = false;
  let disposed = false;
  let gearOn: THREE.Object3D | null = null;
  let gearOff: THREE.Object3D | null = null;
  let canopy: THREE.Object3D | null = null;
  let wings: Wings | null = null;
  /** The sweep the wing vertices are at now. */
  let sweepShown = 0;
  const materials: THREE.Material[] = [];
  let opacity = 1;

  const applyOpacity = () => {
    for (const m of materials) {
      const glass = m.userData.glass as boolean | undefined;
      m.transparent = glass || opacity < 1;
      m.opacity = (glass ? (m.userData.baseOpacity as number) : 1) * opacity;
      m.depthWrite = !glass && opacity >= 1;
    }
  };

  new GLTFLoader().load(
    JET_MODEL_URL,
    (gltf) => {
      if (disposed) return;
      gltf.scene.traverse((object) => {
        if (object.name.startsWith("f14a-gearOn")) gearOn = object;
        if (object.name.startsWith("f14a-gearOff")) gearOff = object;
        if (object.name.startsWith("f14a-canopyFr")) canopy = object;
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (object.parent?.name.startsWith("f14a-airframe")) {
          wings = findWings(mesh.geometry);
          // Swept panels reach outside the bounds worked out at rest.
          mesh.frustumCulled = false;
        }
        for (const m of Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material]) {
          if (materials.includes(m)) continue;
          m.userData.glass = m.transparent;
          m.userData.baseOpacity = m.opacity;
          materials.push(m);
        }
      });
      holder.add(gltf.scene);
      applyOpacity();
      loaded = true;
    },
    undefined,
    () => {
      // Missing or broken file: the trainer keeps standing in.
    },
  );

  return {
    root,
    ready: () => loaded,
    pose({ gearDown = 1, wingSweep = 0 }) {
      if (gearOn) gearOn.visible = gearDown > 0.5;
      if (gearOff) gearOff.visible = gearDown <= 0.5;
      const sweep = Math.min(1, Math.max(0, wingSweep));
      if (wings && Math.abs(sweep - sweepShown) > 0.002) {
        sweepWings(wings, sweep);
        sweepShown = sweep;
      }
    },
    setCockpit(inside) {
      // From the front seat the canopy frame would sit right on the eye.
      if (canopy) canopy.visible = !inside;
    },
    setOpacity(next) {
      opacity = next;
      applyOpacity();
    },
    dispose() {
      disposed = true;
      root.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
      });
      for (const m of materials) {
        for (const value of Object.values(m))
          if (value instanceof THREE.Texture) value.dispose();
        m.dispose();
      }
    },
  };
}
