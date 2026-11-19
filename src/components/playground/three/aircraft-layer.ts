import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import * as THREE from "three";
import type { Mat3 } from "@/lib/flight/camera";
import { cross, type Quat, rotate, type Vec3 } from "@/lib/flight/vec";
import { DAY_LIGHT, type SceneLight } from "../time-of-day";
import { type AirplaneModel, createAirplaneModel } from "./airplane-model";
import {
  aimLights,
  createLights,
  createSmokeCloud,
  disposeSmoke,
  drawSmoke,
  place,
} from "./eye-space";
import { createHeliModel, type HeliModel } from "./heli-model";
import { createJetModel, type JetModel } from "./jet-model";
import { createRacerModel } from "./racer-model";

/**
 * Draws the aircraft, and the race gates and ghost around it, with three.js
 * inside MapLibre's own WebGL context (a custom layer, MapLibre 6
 * `CustomLayerInterface`). Two passes:
 *
 * 1. World objects (gates, ghost) share the terrain's depth buffer, so a
 *    mountain hides a gate behind it. MapLibre draws the terrain and 3D
 *    custom layers into the same depth range (`getDepthModeFor3D`), and
 *    three.js never changes gl.depthRange, so all this pass needs is
 *    MapLibre's own perspective: same field of view and the near and far
 *    planes it reports, converted from its pixel units to metres.
 * 2. The player's aircraft, after clearing depth, with its own near plane
 *    (15 cm): it is always the nearest thing, and from the cockpit its
 *    nose is closer than any near plane MapLibre could use.
 *
 * The view rotation is the one MapLibre uses (`eyeMatrix` in
 * src/lib/flight/camera.ts). Everything is camera-relative: the caller hands
 * over offsets from the camera in metres, computed in float64, so the GPU
 * only ever sees small numbers and nothing jitters.
 */

export interface AircraftView {
  /** East-north-up to eye space, from the angles the map camera was given. */
  eye: Mat3;
  /** Aircraft centre of gravity minus camera position, east-north-up, metres. */
  offset: Vec3;
  /** Body to world. */
  orientation: Quat;
  /** The map's vertical field of view, degrees. */
  fov: number;
  cockpit: boolean;
  surfaces: { elevator: number; aileron: number; rudder: number };
  flaps: number;
  rpm: number;
  dt: number;
  /** MapLibre's pixels per metre at the camera, to read its near and far planes in metres. */
  pixelsPerMeter: number;
  /** Which airframe to draw. */
  model: "trainer" | "racer" | "jet" | "heli";
  /** Retractable gear position, 1 down, 0 up. */
  gearDown: number;
  /** Sun and sky; daylight when absent. */
  light?: SceneLight;
  world?: WorldView;
}

export type GateLook = "next" | "after" | "later" | "hidden";

export interface WorldView {
  gates: { offset: Vec3; normal: Vec3; radius: number; look: GateLook }[];
  ghost: { offset: Vec3; orientation: Quat } | null;
  /** Seconds, for the pulsing of the next gate. */
  time: number;
  /** A gate just passed (or missed) flashing outwards; age 0 → 1. */
  bursts: {
    offset: Vec3;
    normal: Vec3;
    radius: number;
    age: number;
    missed: boolean;
  }[];
  /** Smoke puffs: camera-relative positions (xyz per puff) and ages 0 → 1. */
  smoke: { offsets: Float32Array; ages: Float32Array; count: number } | null;
  /** Missions: landing zones on the ground (centre offset, radius), the current one highlighted. */
  pads?: { offset: Vec3; radius: number; active: boolean }[];
  /** Missions: a light beam rising from the current target, on the ground. */
  beacon?: Vec3 | null;
  /** Missions: people waiting (feet on the ground) or riding the hoist. */
  people?: Vec3[];
  /** Missions: the hoist cable, from the hoist arm down to the hook. */
  cable?: { from: Vec3; to: Vec3 } | null;
  /** Missions: orange marker smoke at the target, drifting with the wind. */
  markerSmoke?: {
    offsets: Float32Array;
    ages: Float32Array;
    count: number;
  } | null;
  /** Storm: falling snow around the camera. `camera` is its position in the local frame. */
  snow?: { intensity: number; wind: Vec3; camera: Vec3; time: number } | null;
  /** Avalanche: big rolling snow puffs, camera-relative. */
  avalanche?: {
    offsets: Float32Array;
    ages: Float32Array;
    count: number;
  } | null;
}

/** Most avalanche puffs drawn at once. */
export const MAX_AVALANCHE_PUFFS = 900;
/** Snowflakes at full intensity, and the box around the camera they fill, metres. */
const SNOWFLAKES = 3500;
const SNOW_BOX: Vec3 = [140, 140, 90];
/** Flakes fall this fast through the air, m/s. */
const SNOW_FALL = 1.4;

/** Most marker smoke puffs drawn at once. */
export const MAX_MARKER_PUFFS = 240;
/** People drawn at once. */
const MAX_PEOPLE = 4;

/** Gate colours: the next one hot amber, the one after teal, the rest faint. */
const GATE_STYLE: Record<
  Exclude<GateLook, "hidden">,
  { color: number; core: number; glow: number }
> = {
  next: { color: 0xffb547, core: 1, glow: 0.45 },
  after: { color: 0x2cc4ae, core: 0.75, glow: 0.18 },
  later: { color: 0xdfeaf5, core: 0.3, glow: 0 },
};
/** Ring tube thickness, metres: thick enough to read from a kilometre away. */
const TUBE = 2.2;
/** Height of the light beam above the next gate, metres. */
const BEAM_HEIGHT = 400;

export interface AircraftLayer {
  layer: CustomLayerInterface;
  /** The view to draw on the next map frame; null hides everything. */
  show(view: AircraftView | null): void;
}

interface GateMeshes {
  group: THREE.Group;
  core: THREE.Mesh;
  glow: THREE.Mesh;
  radius: number;
}

/** Most smoke puffs drawn at once. */
export const MAX_PUFFS = 640;
/** Bursts drawn at once. */
const MAX_BURSTS = 3;

const SNOW_VERTEX = /* glsl */ `
  uniform float scale;
  void main() {
    vec4 eye = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(0.12 * scale / -eye.z, 1.2, 7.0);
    gl_Position = projectionMatrix * eye;
  }
`;
const SNOW_FRAGMENT = /* glsl */ `
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float alpha = smoothstep(1.0, 0.2, d) * 0.85;
    if (alpha < 0.02) discard;
    gl_FragColor = vec4(1.0, 1.0, 1.0, alpha);
  }
`;

export function createAircraftLayer(id: string): AircraftLayer {
  let renderer: THREE.WebGLRenderer | null = null;
  let model: AirplaneModel | null = null;
  let trainer: AirplaneModel | null = null;
  let racer: AirplaneModel | null = null;
  /** Loaded the first time the jet is chosen: an 8 MB file nobody else needs. */
  let jet: JetModel | null = null;
  /** Loaded the first time the helicopter is flown. */
  let heli: HeliModel | null = null;
  let ghost: AirplaneModel | null = null;
  let view: AircraftView | null = null;
  let canvas: HTMLCanvasElement | null = null;

  const aircraftScene = new THREE.Scene();
  const aircraftLights = createLights(aircraftScene);
  const worldScene = new THREE.Scene();
  const worldLights = createLights(worldScene);

  const aircraftCamera = new THREE.PerspectiveCamera(37, 1, 0.15, 4000);
  const worldCamera = new THREE.PerspectiveCamera(37, 1, 1, 100_000);

  /* Gates: shared geometry per radius, shared materials per look. */
  const ringGeometries = new Map<
    number,
    { core: THREE.TorusGeometry; glow: THREE.TorusGeometry }
  >();
  const ringGeometry = (radius: number) => {
    let g = ringGeometries.get(radius);
    if (!g) {
      // The ring's inside edge sits at `radius`.
      g = {
        core: new THREE.TorusGeometry(radius + TUBE, TUBE, 10, 72),
        glow: new THREE.TorusGeometry(radius + TUBE, TUBE * 2.6, 10, 72),
      };
      ringGeometries.set(radius, g);
    }
    return g;
  };
  const coreMaterials = {} as Record<
    keyof typeof GATE_STYLE,
    THREE.MeshBasicMaterial
  >;
  const glowMaterials = {} as Record<
    keyof typeof GATE_STYLE,
    THREE.MeshBasicMaterial
  >;
  for (const look of Object.keys(GATE_STYLE) as (keyof typeof GATE_STYLE)[]) {
    const style = GATE_STYLE[look];
    coreMaterials[look] = new THREE.MeshBasicMaterial({
      color: style.color,
      transparent: style.core < 1,
      opacity: style.core,
    });
    glowMaterials[look] = new THREE.MeshBasicMaterial({
      color: style.color,
      transparent: true,
      opacity: style.glow,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }
  const beamGeometry = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true);
  beamGeometry.translate(0, 0.5, 0);
  const beamMaterial = new THREE.MeshBasicMaterial({
    color: GATE_STYLE.next.color,
    transparent: true,
    opacity: 0.16,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(beamGeometry, beamMaterial);
  beam.matrixAutoUpdate = false;
  worldScene.add(beam);
  const gates: GateMeshes[] = [];

  // Bursts: a ring flashing outwards from a gate just passed (amber) or missed (red).
  const BURST_COLOUR = {
    passed: new THREE.Color(0xffd27a),
    missed: new THREE.Color(0xff4d4d),
  };
  const burstGeometry = new THREE.TorusGeometry(1, 0.06, 8, 72);
  const bursts = Array.from({ length: MAX_BURSTS }, () => {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const b = new THREE.Mesh(burstGeometry, material);
    b.matrixAutoUpdate = false;
    b.visible = false;
    worldScene.add(b);
    return b;
  });

  // Smoke: soft round points, sized in metres. One cloud for trails, one for marker smoke.
  const smokeCloud = (max: number, colour: number, size = 1) =>
    createSmokeCloud(worldScene, max, colour, size);
  const trailSmoke = smokeCloud(MAX_PUFFS, 0xf4f1ea);
  const markerSmoke = smokeCloud(MAX_MARKER_PUFFS, 0xff7a2a);
  const avalancheCloud = smokeCloud(MAX_AVALANCHE_PUFFS, 0xf2f5f8, 3.2);

  // Snow: fixed random spots in a box, carried by the wind and wrapped round the camera.
  const flakeSeeds = new Float32Array(SNOWFLAKES * 3);
  for (let i = 0; i < SNOWFLAKES; i++) {
    flakeSeeds[i * 3] = Math.random() * SNOW_BOX[0];
    flakeSeeds[i * 3 + 1] = Math.random() * SNOW_BOX[1];
    flakeSeeds[i * 3 + 2] = Math.random() * SNOW_BOX[2];
  }
  const snowGeometry = new THREE.BufferGeometry();
  const snowPositions = new THREE.BufferAttribute(
    new Float32Array(SNOWFLAKES * 3),
    3,
  );
  snowPositions.setUsage(THREE.DynamicDrawUsage);
  snowGeometry.setAttribute("position", snowPositions);
  const snowMaterial = new THREE.ShaderMaterial({
    vertexShader: SNOW_VERTEX,
    fragmentShader: SNOW_FRAGMENT,
    uniforms: { scale: { value: 500 } },
    transparent: true,
    depthWrite: false,
  });
  const snow = new THREE.Points(snowGeometry, snowMaterial);
  snow.matrixAutoUpdate = false;
  snow.frustumCulled = false;
  snow.visible = false;
  worldScene.add(snow);
  // Mission markers.
  const padGeometry = new THREE.RingGeometry(0.86, 1, 64);
  const padMaterials = {
    active: new THREE.MeshBasicMaterial({
      color: 0xffb547,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
    idle: new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  };
  const pads: THREE.Mesh[] = [];
  const beacon = new THREE.Mesh(beamGeometry, beamMaterial.clone());
  (beacon.material as THREE.MeshBasicMaterial).color.set(0xff7a2a);
  (beacon.material as THREE.MeshBasicMaterial).opacity = 0.22;
  beacon.matrixAutoUpdate = false;
  beacon.visible = false;
  worldScene.add(beacon);
  // People: an orange-vested figure, built standing on its feet at the origin.
  const personParts = {
    body: new THREE.CapsuleGeometry(0.24, 0.9, 4, 10),
    head: new THREE.SphereGeometry(0.15, 10, 8),
    vest: new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.6 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xd8b48f, roughness: 0.8 }),
  };
  personParts.body.rotateX(Math.PI / 2);
  personParts.body.translate(0, 0, 0.7);
  personParts.head.translate(0, 0, 1.55);
  const people = Array.from({ length: MAX_PEOPLE }, () => {
    const figure = new THREE.Group();
    figure.add(
      new THREE.Mesh(personParts.body, personParts.vest),
      new THREE.Mesh(personParts.head, personParts.skin),
    );
    figure.matrixAutoUpdate = false;
    figure.visible = false;
    worldScene.add(figure);
    return figure;
  });
  const cableGeometry = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  cableGeometry.translate(0, 0.5, 0);
  const cableMaterial = new THREE.MeshBasicMaterial({ color: 0x222222 });
  const cable = new THREE.Mesh(cableGeometry, cableMaterial);
  cable.matrixAutoUpdate = false;
  cable.visible = false;
  worldScene.add(cable);
  const hookGeometry = new THREE.SphereGeometry(0.18, 8, 6);
  const hook = new THREE.Mesh(
    hookGeometry,
    new THREE.MeshStandardMaterial({ color: 0xffc400, roughness: 0.5 }),
  );
  hook.matrixAutoUpdate = false;
  hook.visible = false;
  worldScene.add(hook);

  const gateMeshes = (index: number, radius: number): GateMeshes => {
    const existing = gates[index];
    if (existing && existing.radius === radius) return existing;
    if (existing) worldScene.remove(existing.group);
    const geometry = ringGeometry(radius);
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    const core = new THREE.Mesh(geometry.core, coreMaterials.later);
    const glow = new THREE.Mesh(geometry.glow, glowMaterials.later);
    group.add(core, glow);
    worldScene.add(group);
    const made = { group, core, glow, radius };
    gates[index] = made;
    return made;
  };

  const drawWorld = (
    world: WorldView,
    current: AircraftView,
    args: CustomRenderMethodInput,
  ) => {
    if (!renderer || !canvas) return;
    const { eye } = current;
    let nextGate: { offset: Vec3; radius: number } | null = null;

    world.gates.forEach((gate, index) => {
      const meshes = gateMeshes(index, gate.radius);
      meshes.group.visible = gate.look !== "hidden";
      if (gate.look === "hidden") return;
      meshes.core.material = coreMaterials[gate.look];
      meshes.glow.material = glowMaterials[gate.look];
      // Torus axis (z) along the flying direction; x across, y up (right-handed).
      const up: Vec3 = [0, 0, 1];
      place(
        meshes.group,
        eye,
        cross(up, gate.normal),
        up,
        gate.normal,
        gate.offset,
      );
      if (gate.look === "next") nextGate = gate;
    });
    for (let i = world.gates.length; i < gates.length; i++)
      gates[i].group.visible = false;

    const pulse = 0.5 + 0.5 * Math.sin(world.time * 5);
    glowMaterials.next.opacity = GATE_STYLE.next.glow * (0.6 + 0.4 * pulse);
    beam.visible = nextGate !== null;
    if (nextGate) {
      const g = nextGate as { offset: Vec3; radius: number };
      const r = g.radius * 0.18;
      // A thin beam rising from the top of the ring. The cylinder stands
      // along its local y, so local y becomes world up, scaled to the height.
      const base: Vec3 = [
        g.offset[0],
        g.offset[1],
        g.offset[2] + g.radius + TUBE * 2,
      ];
      place(beam, eye, [r, 0, 0], [0, 0, BEAM_HEIGHT], [0, -r, 0], base);
    }

    bursts.forEach((mesh, i) => {
      const burst = world.bursts[i];
      mesh.visible = Boolean(burst);
      if (!burst) return;
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.color.copy(BURST_COLOUR[burst.missed ? "missed" : "passed"]);
      material.opacity = (1 - burst.age) ** 1.5;
      const r = (burst.radius + TUBE) * (1 + burst.age * 1.4);
      const n = burst.normal;
      const across = cross([0, 0, 1], n);
      place(
        mesh,
        eye,
        [across[0] * r, across[1] * r, 0],
        [0, 0, r],
        [n[0] * r, n[1] * r, n[2] * r],
        burst.offset,
      );
    });

    // Pixels per metre at one metre away: half the drawing buffer's height over tan(fov / 2).
    const pixelScale =
      canvas.height / 2 / Math.tan((current.fov * Math.PI) / 360);
    drawSmoke(trailSmoke, world.smoke, eye, pixelScale);
    drawSmoke(markerSmoke, world.markerSmoke, eye, pixelScale);
    drawSmoke(avalancheCloud, world.avalanche, eye, pixelScale);

    snow.visible = Boolean(world.snow && world.snow.intensity > 0.02);
    if (world.snow && snow.visible) {
      const { wind, camera, time, intensity } = world.snow;
      const drift: Vec3 = [wind[0] * time, wind[1] * time, -SNOW_FALL * time];
      const out = snowPositions.array as Float32Array;
      const wrap = (v: number, box: number) =>
        (((v % box) + box) % box) - box / 2;
      const count = Math.round(SNOWFLAKES * Math.min(1, intensity));
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < 3; k++)
          out[i * 3 + k] = wrap(
            flakeSeeds[i * 3 + k] + drift[k] - camera[k],
            SNOW_BOX[k],
          );
      }
      snowPositions.needsUpdate = true;
      snowGeometry.setDrawRange(0, count);
      place(snow, eye, [1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]);
      snowMaterial.uniforms.scale.value = pixelScale;
    }

    // Landing zones, lying on the ground (half a metre up, so the terrain does not swallow them).
    const padList = world.pads ?? [];
    while (pads.length < padList.length) {
      const mesh = new THREE.Mesh(padGeometry, padMaterials.idle);
      mesh.matrixAutoUpdate = false;
      worldScene.add(mesh);
      pads.push(mesh);
    }
    pads.forEach((mesh, i) => {
      const pad = padList[i];
      mesh.visible = Boolean(pad);
      if (!pad) return;
      mesh.material = pad.active ? padMaterials.active : padMaterials.idle;
      const r = pad.radius;
      place(
        mesh,
        eye,
        [r, 0, 0],
        [0, r, 0],
        [0, 0, 1],
        [pad.offset[0], pad.offset[1], pad.offset[2] + 0.5],
      );
    });
    beacon.visible = Boolean(world.beacon);
    if (world.beacon)
      place(beacon, eye, [2.2, 0, 0], [0, 0, 300], [0, -2.2, 0], world.beacon);

    people.forEach((figure, i) => {
      const at = world.people?.[i];
      figure.visible = Boolean(at);
      if (at) place(figure, eye, [1, 0, 0], [0, 1, 0], [0, 0, 1], at);
    });

    cable.visible = hook.visible = Boolean(world.cable);
    if (world.cable) {
      const { from, to } = world.cable;
      const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
      const r = 0.035;
      // The cylinder stands along its local y: y spans the cable, x and z are its thickness.
      const across =
        Math.hypot(d[0], d[1]) > 1e-6
          ? cross(d, [0, 0, 1])
          : ([1, 0, 0] as Vec3);
      const al = Math.hypot(...across) || 1;
      const x: Vec3 = [
        (across[0] / al) * r,
        (across[1] / al) * r,
        (across[2] / al) * r,
      ];
      const z0 = cross(x, d);
      const zl = Math.hypot(...z0) || 1;
      const z: Vec3 = [(z0[0] / zl) * r, (z0[1] / zl) * r, (z0[2] / zl) * r];
      place(cable, eye, x, d, z, from);
      place(hook, eye, [1, 0, 0], [0, 1, 0], [0, 0, 1], to);
    }

    if (ghost) {
      ghost.root.visible = world.ghost !== null;
      if (world.ghost) {
        const q = world.ghost.orientation;
        place(
          ghost.root,
          eye,
          rotate(q, [1, 0, 0]),
          rotate(q, [0, 1, 0]),
          rotate(q, [0, 0, 1]),
          world.ghost.offset,
        );
        ghost.pose({
          elevator: 0,
          aileron: 0,
          rudder: 0,
          flaps: 0,
          rpm: 2400,
          dt: current.dt,
        });
      }
    }

    // MapLibre's perspective, in metres: depth values then match the terrain's.
    worldCamera.fov = current.fov;
    worldCamera.aspect = canvas.width / canvas.height;
    worldCamera.near = args.nearZ / current.pixelsPerMeter;
    worldCamera.far = args.farZ / current.pixelsPerMeter;
    worldCamera.updateProjectionMatrix();
    aimLights(eye, worldLights, current.light ?? DAY_LIGHT);
    renderer.render(worldScene, worldCamera);
  };

  const layer: CustomLayerInterface = {
    id,
    type: "custom",
    renderingMode: "3d",

    onAdd(map: MapLibreMap, gl: WebGL2RenderingContext) {
      canvas = map.getCanvas();
      renderer = new THREE.WebGLRenderer({
        canvas,
        context: gl,
        antialias: true,
      });
      // MapLibre owns the frame: never clear its colour, never resize its canvas.
      renderer.autoClear = false;
      trainer = createAirplaneModel();
      racer = createRacerModel();
      for (const m of [trainer, racer]) {
        m.root.matrixAutoUpdate = false;
        m.root.visible = false;
        aircraftScene.add(m.root);
      }
      model = trainer;
      // The ghost is always the race plane: only races leave one.
      ghost = createRacerModel();
      ghost.root.matrixAutoUpdate = false;
      ghost.setOpacity(0.38);
      ghost.root.visible = false;
      worldScene.add(ghost.root);
    },

    onRemove() {
      if (heli) {
        aircraftScene.remove(heli.root);
        heli.dispose();
        heli = null;
      }
      if (jet) {
        aircraftScene.remove(jet.root);
        jet.dispose();
        jet = null;
      }
      for (const m of [trainer, racer]) {
        if (!m) continue;
        aircraftScene.remove(m.root);
        m.dispose();
      }
      if (ghost) worldScene.remove(ghost.root);
      ghost?.dispose();
      burstGeometry.dispose();
      for (const b of bursts) (b.material as THREE.Material).dispose();
      snowGeometry.dispose();
      snowMaterial.dispose();
      for (const cloud of [trailSmoke, markerSmoke, avalancheCloud])
        disposeSmoke(cloud);
      padGeometry.dispose();
      padMaterials.active.dispose();
      padMaterials.idle.dispose();
      (beacon.material as THREE.Material).dispose();
      personParts.body.dispose();
      personParts.head.dispose();
      personParts.vest.dispose();
      personParts.skin.dispose();
      cableGeometry.dispose();
      cableMaterial.dispose();
      hookGeometry.dispose();
      (hook.material as THREE.Material).dispose();
      for (const g of ringGeometries.values()) {
        g.core.dispose();
        g.glow.dispose();
      }
      ringGeometries.clear();
      for (const m of [
        ...Object.values(coreMaterials),
        ...Object.values(glowMaterials),
        beamMaterial,
      ])
        m.dispose();
      beamGeometry.dispose();
      // Not renderer.dispose(): that would lose the context MapLibre is still using.
      renderer?.renderLists.dispose();
      renderer = null;
      model = null;
      trainer = null;
      racer = null;
      ghost = null;
    },

    render(_gl, args) {
      if (!renderer || !trainer || !racer || !canvas || !view) return;
      const current = view;
      if (current.model === "jet" && !jet) {
        jet = createJetModel();
        jet.root.matrixAutoUpdate = false;
        aircraftScene.add(jet.root);
      }
      if (current.model === "heli" && !heli) {
        heli = createHeliModel();
        heli.root.matrixAutoUpdate = false;
        aircraftScene.add(heli.root);
      }
      // The jet's file may still be loading: the trainer stands in until it is
      // there. The helicopter has no stand-in: nothing is drawn until it loads.
      model =
        current.model === "racer"
          ? racer
          : current.model === "jet" && jet?.ready()
            ? jet
            : current.model === "heli"
              ? heli
              : trainer;
      trainer.root.visible = model === trainer;
      racer.root.visible = model === racer;
      if (jet) jet.root.visible = model === jet;
      if (heli) heli.root.visible = model === heli && heli.ready();
      const { eye, offset, orientation } = current;

      renderer.resetState();
      renderer.setViewport(0, 0, canvas.width, canvas.height);

      // Pass 1: gates and ghost, depth-tested against the terrain.
      if (current.world) drawWorld(current.world, current, args);

      // Pass 2: the player's aircraft (none while the helicopter's file loads).
      if (!model) {
        renderer.resetState();
        return;
      }
      aircraftCamera.fov = current.fov;
      aircraftCamera.aspect = canvas.width / canvas.height;
      // Far enough for an aircraft some way off (a co-op partner), not just one's own.
      aircraftCamera.far = Math.max(4000, Math.hypot(...offset) * 1.5);
      aircraftCamera.updateProjectionMatrix();
      place(
        model.root,
        eye,
        rotate(orientation, [1, 0, 0]),
        rotate(orientation, [0, 1, 0]),
        rotate(orientation, [0, 0, 1]),
        offset,
      );
      model.setCockpit(current.cockpit);
      model.pose({
        ...current.surfaces,
        flaps: current.flaps,
        rpm: current.rpm,
        dt: current.dt,
        gearDown: current.gearDown,
      });
      current.dt = 0; // a repaint without a new view must not advance the propeller again
      aimLights(eye, aircraftLights, current.light ?? DAY_LIGHT);
      // The aircraft is always nearer than the terrain it is drawn over, and
      // its depth range differs from the map's: start from a clean depth buffer.
      renderer.clearDepth();
      renderer.render(aircraftScene, aircraftCamera);
      renderer.resetState();
    },
  };

  return {
    layer,
    show(next) {
      view = next;
    },
  };
}
