import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { AirplaneModel } from "./airplane-model";

/**
 * The playground helicopter: a downloaded rescue helicopter glTF model (see
 * public/models/CREDITS.md), loaded on first use; `ready()` is false until
 * then and nothing is drawn.
 *
 * The file's meshes are split by material, not by part, so the main rotor is
 * not a part of its own. It is cut out on load: every triangle wholly above
 * the mast line (and within the blades' reach of the hub) belongs to the rotor, and goes
 * into a mesh of its own that spins about the mast. The tail has an enclosed
 * fan, so nothing else turns.
 *
 * File axes (inside its own root): x across, y along (nose −y), z up, scaled
 * so the rotor is 1.656 units across. Scaled by 6.16 the rotor is the class's
 * 10.2 m. Placed so the centre of gravity (under the mast, a little above the
 * cabin floor) sits at the body frame's origin; the skid contact points in
 * src/lib/flight/helicopter.ts were measured off the file the same way.
 */
export const HELI_MODEL_URL = "/models/rescue_helicopter.glb";

const SCALE = 6.16;
/**
 * Rotor hub in the file's own coordinates: midway between the blade tips
 * across (both at y −0.120) and on the plane fitted through the blades
 * (level within 0.1°, so the mast is vertical). An earlier guess at y −0.092,
 * 17 cm off at full size, made the rotor wobble round in a circle.
 */
const HUB: [number, number, number] = [0, -0.12, 0.2745];
/** Centre of gravity in the file's own coordinates: under the mast. */
const CG: [number, number, number] = [0, -0.12, -0.09];
/** Triangles wholly above this (file z) and within the blade radius of the hub are rotor. */
const ROTOR_CUT_Z = 0.235;
const ROTOR_RADIUS = 0.84;

/**
 * The cockpit camera: the model has no cabin interior worth sitting in, so
 * the view is from just ahead of the windscreen at the pilots' eye height,
 * looking over the nose with the rotor overhead.
 */
export const HELI_EYE: [number, number, number] = [3.08, 0, 0.92];

export interface HeliModel extends AirplaneModel {
  ready(): boolean;
}

export function createHeliModel(): HeliModel {
  const root = new THREE.Group();
  // File → body frame: body x = −s (fy − cy), body y = s fx, body z = s (fz − cz).
  // (The file's own root node turns its axes first; this matrix undoes that
  // too, so it is built from the raw mesh coordinates below.)
  const raw = new THREE.Group();
  raw.matrixAutoUpdate = false;
  raw.matrix.set(
    0,
    -SCALE,
    0,
    SCALE * CG[1],
    SCALE,
    0,
    0,
    0,
    0,
    0,
    SCALE,
    -SCALE * CG[2],
    0,
    0,
    0,
    1,
  );
  root.add(raw);

  const rotor = new THREE.Group();
  rotor.position.set(...HUB);
  raw.add(rotor);
  const discMaterial = new THREE.MeshBasicMaterial({
    color: 0x1a1f25,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.83, 48), discMaterial);
  disc.position.z = 0.012;
  rotor.add(disc);

  let loaded = false;
  let disposed = false;
  const geometries: THREE.BufferGeometry[] = [disc.geometry];
  const materials: THREE.Material[] = [discMaterial];
  let angle = 0;

  new GLTFLoader().load(
    HELI_MODEL_URL,
    (gltf) => {
      if (disposed) return;
      const meshes: THREE.Mesh[] = [];
      gltf.scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh) meshes.push(mesh);
      });
      for (const mesh of meshes) {
        const geometry = mesh.geometry;
        const position = geometry.getAttribute("position");
        const index = geometry.getIndex();
        if (!index) continue;
        const body: number[] = [];
        const blades: number[] = [];
        for (let t = 0; t < index.count; t += 3) {
          const a = index.getX(t);
          const b = index.getX(t + 1);
          const c = index.getX(t + 2);
          // The tail fin's tip also rises above the cut, but lies beyond the blades' reach.
          const above = [a, b, c].every(
            (v) =>
              position.getZ(v) > ROTOR_CUT_Z &&
              Math.hypot(position.getX(v) - HUB[0], position.getY(v) - HUB[1]) <
                ROTOR_RADIUS,
          );
          (above ? blades : body).push(a, b, c);
        }
        const material = Array.isArray(mesh.material)
          ? mesh.material[0]
          : mesh.material;
        if (!materials.includes(material)) materials.push(material);
        // The body keeps the original geometry with fewer triangles.
        geometry.setIndex(body);
        const bodyMesh = new THREE.Mesh(geometry, material);
        raw.add(bodyMesh);
        geometries.push(geometry);
        if (blades.length) {
          const spin = geometry.clone();
          spin.setIndex(blades);
          spin.translate(-HUB[0], -HUB[1], -HUB[2]);
          rotor.add(new THREE.Mesh(spin, material));
          geometries.push(spin);
        }
      }
      loaded = true;
    },
    undefined,
    () => {
      // Missing or broken file: nothing to draw.
    },
  );

  return {
    root,
    ready: () => loaded,
    pose({ rpm, dt }) {
      // rpm is rotor speed in %. Shown slowed down (at real speed it would
      // only strobe), with a faint disc once it is up to speed.
      const share = Math.max(0, rpm) / 100;
      angle =
        (angle + Math.min(share, 1) * 2 * Math.PI * 2.2 * dt) % (2 * Math.PI);
      rotor.rotation.z = -angle;
      discMaterial.opacity =
        0.12 * THREE.MathUtils.clamp((share - 0.6) / 0.3, 0, 1);
    },
    setCockpit() {
      /* the cabin stays: it frames the view */
    },
    setOpacity() {
      /* never a ghost */
    },
    dispose() {
      disposed = true;
      geometries.forEach((g) => g.dispose());
      for (const m of materials) {
        for (const value of Object.values(m))
          if (value instanceof THREE.Texture) value.dispose();
        m.dispose();
      }
    },
  };
}
