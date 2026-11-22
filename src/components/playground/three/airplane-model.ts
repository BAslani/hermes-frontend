import * as THREE from "three";
import { TRAINER } from "@/lib/flight/fixed-wing";

/**
 * The "Rokh 141" trainer: a low-poly, high-wing, four-seat single built in
 * code, in the 141 livery. No external assets (see public/models/CREDITS.md).
 *
 * Built in the flight code's body frame: x forward, y left, z up, metres,
 * origin at the centre of gravity. Wheel bottoms sit at z = −1.16, matching
 * the landing-gear contact points in src/lib/flight/airplane.ts.
 */

const WHITE = 0xf3f5f6;
const TEAL = 0x0e7f71;
const BRIGHT = 0x2cc4ae;
const DARK = 0x18222d;
const GLASS = 0x22303d;
const TYRE = 0x15181c;

export interface AirplaneModel {
  root: THREE.Group;
  /** Deflect the surfaces (inputs −1…1 as the physics uses them) and spin the propeller. */
  pose(state: {
    elevator: number;
    aileron: number;
    rudder: number;
    /** Degrees. */
    flaps: number;
    rpm: number;
    /** Seconds since the last frame. */
    dt: number;
    /** Retractable gear: 1 down, 0 up. Ignored by fixed gear. */
    gearDown?: number;
    /** Swing wings: 0 spread, 1 fully swept back. Ignored by fixed wings. */
    wingSweep?: number;
  }): void;
  /** From the pilot's seat the cabin shell is hidden, so only the nose, wing and struts frame the view. */
  setCockpit(inside: boolean): void;
  /** Translucent copy, for a ghost. */
  setOpacity(opacity: number): void;
  dispose(): void;
}

export function createAirplaneModel(): AirplaneModel {
  const root = new THREE.Group();
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
      roughness: 0.55,
      metalness: 0.08,
      ...extra,
    });
    materials.push(m);
    return m;
  };
  const white = paint(WHITE);
  const teal = paint(TEAL);
  const bright = paint(BRIGHT);
  const dark = paint(DARK, { roughness: 0.8 });
  const glass = paint(GLASS, { roughness: 0.15, metalness: 0.4 });
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
  /** A rod between two points. */
  const rod = (
    from: [number, number, number],
    to: [number, number, number],
    radius: number,
    material: THREE.Material,
  ) => {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const m = mesh(
      new THREE.CylinderGeometry(radius, radius, a.distanceTo(b), 6),
      material,
    );
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      b.clone().sub(a).normalize(),
    );
    return m;
  };
  /** A body of revolution along x from [x, radius] stations, tail to nose, a little taller than wide. */
  const hull = (
    stations: [number, number][],
    material: THREE.Material,
    parent: THREE.Object3D,
  ) => {
    const g = new THREE.LatheGeometry(
      stations.map(([x, r]) => new THREE.Vector2(r, x)),
      10,
    );
    g.rotateZ(-Math.PI / 2); // the lathe's axis (y) becomes forward (x)
    g.scale(1, 1, 1.12);
    return mesh(g, material, parent);
  };

  // Fuselage: tail cone and cabin in white, engine cowl in teal. Double-sided,
  // so it is lit correctly whichever way the lathe winds its faces.
  const shell = paint(WHITE, { side: THREE.DoubleSide });
  const cowl = paint(TEAL, { side: THREE.DoubleSide });
  hull(
    [
      [-4.9, 0.07],
      [-3.8, 0.19],
      [-2.2, 0.37],
      [-0.8, 0.58],
      [0, 0.62],
      [0.6, 0.6],
      [1.05, 0.55],
    ],
    shell,
    cabin,
  );
  hull(
    [
      [1.05, 0.55],
      [1.45, 0.47],
      [1.72, 0.33],
      [1.78, 0.2],
    ],
    cowl,
    root,
  );
  box(0.02, 0.5, 0.05, bright, [1.06, 0, 0.3], root); // a thin bright line where cowl meets cabin
  // Windows: a dark band proud of the cabin sides, and a raked windscreen.
  box(1.35, 1.27, 0.38, glass, [0.2, 0, 0.5], cabin);
  const screen = box(0.5, 1.05, 0.06, glass, [1.0, 0, 0.6], cabin);
  screen.rotation.y = -0.9;

  // Wing, on top of the cabin, with teal tips.
  const hinge = -0.3;
  const wingZ = 0.92;
  box(1.25, 9.9, 0.17, white, [hinge + 0.625, 0, wingZ]);
  for (const side of [1, -1]) {
    box(1.25, 0.5, 0.17, teal, [hinge + 0.625, side * 5.2, wingZ]);
    rod(
      [0.35, side * 0.55, -0.35],
      [0.35, side * 2.4, wingZ - 0.08],
      0.035,
      white,
    );
  }

  /** A hinged surface: a group at the hinge line with the panel trailing behind it. */
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
  const flapLeft = surface(0.36, 2.1, 0.1, white, [hinge, 1.8, wingZ - 0.02]);
  const flapRight = surface(0.36, 2.1, 0.1, white, [hinge, -1.8, wingZ - 0.02]);
  const aileronLeft = surface(0.36, 2.05, 0.1, bright, [
    hinge,
    3.92,
    wingZ - 0.02,
  ]);
  const aileronRight = surface(0.36, 2.05, 0.1, bright, [
    hinge,
    -3.92,
    wingZ - 0.02,
  ]);

  // Tail.
  box(0.6, 3.3, 0.09, white, [-4.3, 0, 0.18]);
  const elevator = surface(0.42, 3.3, 0.07, bright, [-4.6, 0, 0.18]);
  box(0.85, 0.08, 1.35, teal, [-4.2, 0, 0.9]);
  const rudder = surface(0.42, 1.35, 0.06, teal, [-4.62, 0, 0.9], true);
  // "141" on both sides of the fin.
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
      const d = mesh(new THREE.PlaneGeometry(0.72, 0.4), decalMaterial);
      d.position.set(-4.2, side * 0.043, 0.95);
      d.rotation.set(Math.PI / 2, side > 0 ? Math.PI : 0, 0);
    }
  }

  // Landing gear.
  for (const side of [1, -1]) {
    rod([-0.4, side * 0.45, -0.45], [-0.4, side * 1.25, -0.93], 0.05, white);
    const wheel = mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.16, 12), tyre);
    wheel.position.set(-0.4, side * 1.25, -0.94);
  }
  rod([1.25, 0, -0.35], [1.25, 0, -0.95], 0.04, dark);
  const noseWheel = mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.13, 12), tyre);
  noseWheel.position.set(1.25, 0, -0.96);

  // Propeller: two blades, replaced by a faint disc once it spins fast.
  const prop = new THREE.Group();
  prop.position.set(1.84, 0, 0);
  root.add(prop);
  const spinner = mesh(new THREE.ConeGeometry(0.17, 0.3, 10), white, prop);
  spinner.rotation.z = -Math.PI / 2;
  spinner.position.x = 0.1;
  const blades = box(0.04, 1.9, 0.15, dark, [0, 0, 0], prop);
  const discMaterial = new THREE.MeshBasicMaterial({
    color: 0x1a1f25,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  materials.push(discMaterial);
  const disc = mesh(new THREE.CircleGeometry(0.95, 24), discMaterial, prop);
  disc.rotation.y = Math.PI / 2;
  disc.visible = false;

  let propAngle = 0;
  return {
    root,
    pose({ elevator: e, aileron: a, rudder: r, flaps, rpm, dt }) {
      // A panel trails behind its hinge, so a positive turn about the left axis lifts its trailing edge.
      elevator.rotation.y = e * TRAINER.elevatorMax;
      aileronLeft.rotation.y = -a * TRAINER.aileronMax;
      aileronRight.rotation.y = a * TRAINER.aileronMax;
      rudder.rotation.z = r * TRAINER.rudderMax;
      flapLeft.rotation.y = flapRight.rotation.y =
        -THREE.MathUtils.degToRad(flaps);
      const fast = rpm > 1100;
      blades.visible = !fast;
      disc.visible = fast;
      // Shown slowed down: at real speed the blades would only strobe.
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

/** White "141" on a transparent background. */
export function finDecal(): THREE.CanvasTexture | null {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 144;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.font = "800 110px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("141", 128, 78);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.premultiplyAlpha = true;
  return texture;
}
