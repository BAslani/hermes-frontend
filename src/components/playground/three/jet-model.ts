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
 * The model has no separate control surfaces, so nothing on it moves except
 * the gear, which swaps between its "gear down" and "gear up" parts.
 */
export const JET_MODEL_URL = "/models/f-14_tomcat_-_fighter_jet_-_free.glb";

/** Pilot's eye in the body frame: the front seat, under the canopy. */
export const JET_EYE: [number, number, number] = [6.8, 0, 1.05];

export interface JetModel extends AirplaneModel {
  ready(): boolean;
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
    pose({ gearDown = 1 }) {
      if (gearOn) gearOn.visible = gearDown > 0.5;
      if (gearOff) gearOff.visible = gearDown <= 0.5;
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
