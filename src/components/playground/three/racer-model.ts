import * as THREE from "three";
import { RACER } from "@/lib/flight/fixed-wing";
import { type AirplaneModel, finDecal } from "./airplane-model";

/**
 * The "Shahin 141" racer: a low-poly, low-wing, single-seat aerobatic
 * monoplane built in code, in an amber race livery with 141 teal. No external
 * assets (see public/models/CREDITS.md).
 *
 * Body frame: x forward, y left, z up, metres, origin at the centre of
 * gravity. Wheel bottoms sit at z = −1.05 (mains) and −0.35 (tail wheel),
 * matching RACER_GEAR in src/lib/flight/airplane.ts.
 */

const WHITE = 0xf3f5f6;
const AMBER = 0xffa630;
const TEAL = 0x0e7f71;
const NAVY = 0x18222d;
const GLASS = 0x1d2a36;
const TYRE = 0x15181c;

/** Pilot's eye in the body frame, under the canopy. */
export const RACER_EYE: [number, number, number] = [-0.25, 0, 0.72];

export function createRacerModel(): AirplaneModel {
  const root = new THREE.Group();
  /** Hidden from the pilot's seat: canopy and the fuselage around it. */
  const cabin = new THREE.Group();
  root.add(cabin);
  const materials: THREE.Material[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const textures: THREE.Texture[] = [];

  const paint = (
    color: number,
    extra: THREE.MeshStandardMaterialParameters = {},
  ) => {
    const m = new THREE.MeshStandardMaterial({
      color,
      flatShading: true,
      roughness: 0.42,
      metalness: 0.12,
      ...extra,
    });
    materials.push(m);
    return m;
  };
  const white = paint(WHITE);
  const amber = paint(AMBER);
  const teal = paint(TEAL);
  const navy = paint(NAVY, { roughness: 0.7 });
  const glass = paint(GLASS, { roughness: 0.08, metalness: 0.55 });
  const tyre = paint(TYRE, { roughness: 0.9 });

  const mesh = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    parent: THREE.Object3D = root,
  ) => {
    geometries.push(geometry);
    const m = new THREE.Mesh(geometry, material);
    parent.add(m);
    return m;
  };
  const box = (
    x: number,
    y: number,
    z: number,
    material: THREE.Material,
    at: [number, number, number],
    parent?: THREE.Object3D,
  ) => {
    const m = mesh(new THREE.BoxGeometry(x, y, z), material, parent);
    m.position.set(...at);
    return m;
  };
  const rod = (
    from: [number, number, number],
    to: [number, number, number],
    radius: number,
    material: THREE.Material,
  ) => {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const m = mesh(
      new THREE.CylinderGeometry(radius, radius * 0.7, a.distanceTo(b), 6),
      material,
    );
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      b.clone().sub(a).normalize(),
    );
    return m;
  };
  const hull = (
    stations: [number, number][],
    material: THREE.Material,
    parent: THREE.Object3D,
  ) => {
    const g = new THREE.LatheGeometry(
      stations.map(([x, r]) => new THREE.Vector2(r, x)),
      12,
    );
    g.rotateZ(-Math.PI / 2);
    g.scale(1, 0.92, 1.1);
    return mesh(g, material, parent);
  };

  // Fuselage: white tail cone, amber cowl, a navy belly stripe.
  const shell = paint(WHITE, { side: THREE.DoubleSide });
  const cowl = paint(AMBER, { side: THREE.DoubleSide });
  hull(
    [
      [-4.75, 0.06],
      [-3.6, 0.19],
      [-2.0, 0.36],
      [-0.7, 0.5],
      [0.4, 0.53],
      [1.15, 0.5],
    ],
    shell,
    cabin,
  );
  hull(
    [
      [1.15, 0.5],
      [1.6, 0.44],
      [1.9, 0.32],
      [1.98, 0.18],
    ],
    cowl,
    root,
  );
  box(4.2, 0.12, 0.06, navy, [-1.7, 0.36, 0.05], cabin);
  box(4.2, 0.12, 0.06, navy, [-1.7, -0.36, 0.05], cabin);

  // Bubble canopy over the pilot, just behind the wing.
  const canopyGeometry = new THREE.SphereGeometry(
    0.5,
    14,
    10,
    0,
    Math.PI * 2,
    0,
    Math.PI / 2,
  );
  canopyGeometry.scale(1.7, 0.72, 0.62);
  const canopy = mesh(canopyGeometry, glass, cabin);
  canopy.position.set(-0.35, 0, 0.5);

  // Low wing with amber tips; a white top with a teal sweep.
  const wingZ = -0.35;
  const hinge = -0.55;
  box(1.45, 8.0, 0.16, white, [0.12, 0, wingZ]);
  box(0.5, 4.0, 0.02, teal, [0.35, 0, wingZ + 0.09]);
  for (const side of [1, -1])
    box(1.1, 0.42, 0.17, amber, [0.05, side * 3.8, wingZ]);

  const surface = (
    chord: number,
    span: number,
    thickness: number,
    material: THREE.Material,
    at: [number, number, number],
    vertical = false,
  ) => {
    const pivot = new THREE.Group();
    pivot.position.set(...at);
    root.add(pivot);
    if (vertical)
      box(chord, thickness, span, material, [-chord / 2, 0, 0], pivot);
    else box(chord, span, thickness, material, [-chord / 2, 0, 0], pivot);
    return pivot;
  };
  const aileronLeft = surface(0.36, 2.6, 0.09, amber, [hinge, 2.3, wingZ]);
  const aileronRight = surface(0.36, 2.6, 0.09, amber, [hinge, -2.3, wingZ]);

  // Tail.
  box(0.55, 2.9, 0.08, white, [-4.15, 0, 0.12]);
  const elevator = surface(0.42, 2.9, 0.06, amber, [-4.43, 0, 0.12]);
  box(0.85, 0.08, 1.05, teal, [-4.15, 0, 0.7]);
  const rudder = surface(0.46, 1.2, 0.06, amber, [-4.58, 0, 0.66], true);
  const decal = finDecal();
  if (decal) {
    textures.push(decal);
    const decalMaterial = new THREE.MeshBasicMaterial({
      map: decal,
      transparent: true,
      premultipliedAlpha: true,
    });
    materials.push(decalMaterial);
    for (const side of [1, -1]) {
      const d = mesh(new THREE.PlaneGeometry(0.66, 0.37), decalMaterial);
      d.position.set(-4.12, side * 0.043, 0.74);
      d.rotation.set(Math.PI / 2, side > 0 ? Math.PI : 0, 0);
    }
  }
  // Smoke nozzle under the tail.
  const nozzle = mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.3, 8), navy);
  nozzle.rotation.z = Math.PI / 2;
  nozzle.position.set(-4.7, 0, -0.02);

  // Spring-steel main legs with amber wheel pants, and a small tail wheel.
  for (const side of [1, -1]) {
    rod([0.45, side * 0.28, -0.4], [0.45, side * 0.95, -0.82], 0.045, white);
    const wheel = mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.13, 12), tyre);
    wheel.position.set(0.45, side * 0.95, -0.84);
    box(0.62, 0.17, 0.3, amber, [0.47, side * 0.95, -0.78]);
  }
  const tailWheel = mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.06, 10), tyre);
  tailWheel.position.set(-4.3, 0, -0.25);

  // Propeller: two long blades, a disc once it spins fast.
  const prop = new THREE.Group();
  prop.position.set(2.02, 0, 0);
  root.add(prop);
  const spinner = mesh(new THREE.ConeGeometry(0.19, 0.38, 12), amber, prop);
  spinner.rotation.z = -Math.PI / 2;
  spinner.position.x = 0.12;
  const blades = box(0.04, 2.0, 0.16, navy, [0, 0, 0], prop);
  const discMaterial = new THREE.MeshBasicMaterial({
    color: 0x1a1f25,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  materials.push(discMaterial);
  const disc = mesh(new THREE.CircleGeometry(1.0, 24), discMaterial, prop);
  disc.rotation.y = Math.PI / 2;
  disc.visible = false;

  let propAngle = 0;
  return {
    root,
    pose({ elevator: e, aileron: a, rudder: r, rpm, dt }) {
      elevator.rotation.y = e * RACER.elevatorMax;
      aileronLeft.rotation.y = -a * RACER.aileronMax;
      aileronRight.rotation.y = a * RACER.aileronMax;
      rudder.rotation.z = r * RACER.rudderMax;
      const fast = rpm > 1200;
      blades.visible = !fast;
      disc.visible = fast;
      propAngle =
        (propAngle + (Math.min(rpm, 900) / 60) * 2 * Math.PI * dt) %
        (2 * Math.PI);
      prop.rotation.x = propAngle;
    },
    setCockpit(inside) {
      cabin.visible = !inside;
    },
    setOpacity(opacity) {
      for (const m of materials) {
        if (m === discMaterial) continue;
        m.transparent = opacity < 1;
        m.opacity = opacity;
        m.depthWrite = opacity >= 1;
      }
    },
    dispose() {
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
    },
  };
}
