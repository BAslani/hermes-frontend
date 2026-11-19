import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";
import * as THREE from "three";
import type { Mat3 } from "@/lib/flight/camera";
import { cross, normalize, type Vec3 } from "@/lib/flight/vec";
import { DAY_LIGHT, type SceneLight } from "../time-of-day";
import {
  aimLights,
  createLights,
  createSmokeCloud,
  disposeSmoke,
  drawSmoke,
  type PuffData,
  place,
} from "./eye-space";

/**
 * Draws the drone-defence world with three.js inside MapLibre's context:
 * the attack drones, the missiles, their smoke, explosions and the defended
 * site. One pass, sharing the terrain's depth buffer (see aircraft-layer.ts
 * for why MapLibre's own near and far planes, in metres, are all it needs),
 * so a ridge hides a drone behind it. The player is the camera: nothing of
 * the interceptor itself is drawn.
 *
 * Everything is built in code (no model files), so it can ship anywhere.
 */

export interface StrikeView {
  /** East-north-up to eye space. */
  eye: Mat3;
  /** Vertical field of view, degrees. */
  fov: number;
  /** MapLibre's pixels per metre at the camera, to read its near and far planes in metres. */
  pixelsPerMeter: number;
  light?: SceneLight;
  /** Drones: offset from the camera, the way they fly, and which model. */
  threats: { offset: Vec3; forward: Vec3; model: "delta" | "jet" | "quad" }[];
  /** Falling pieces of downed drones, camera-relative (xyz each). */
  debris: { offsets: Float32Array; count: number } | null;
  /** Gun tracers: a short streak per round, two camera-relative points each (xyz xyz). */
  tracers: { offsets: Float32Array; count: number } | null;
  /** White-hot thermal: drones, missiles and wreckage glow white (the map is greyed by the page). */
  thermal: boolean;
  /** Blinking navigation lights on the drones (at night). */
  navLights: boolean;
  /** Seconds, for the blinking. */
  time: number;
  /** Missiles in flight. */
  missiles: { offset: Vec3; forward: Vec3 }[];
  /** Missile trails (grey), explosion smoke (dark) and fire (glowing). */
  trails: PuffData | null;
  smoke: PuffData | null;
  fire: PuffData | null;
  /** The defended site: a ring at the height the drones aim for, coloured by what is left of it. */
  site: { offset: Vec3; radius: number; health: number } | null;
  /** Drone launchers on the ground, camera-relative, each facing the way its drones leave. */
  launchers: { offset: Vec3; forward: Vec3 }[];
  /** The co-op partner's interceptor drone, seen from the F-14. */
  partner?: { offset: Vec3; forward: Vec3 } | null;
}

export interface StrikeLayer {
  layer: CustomLayerInterface;
  show(view: StrikeView | null): void;
}

export const MAX_TRAIL_PUFFS = 3200;
export const MAX_SMOKE_PUFFS = 1600;
export const MAX_DEBRIS = 400;
export const MAX_TRACERS = 120;
export const MAX_FIRE_PUFFS = 500;
const MAX_THREATS = 32;
/** Jets and hunters drawn at once (each model has its own pool). */
const MAX_SPECIAL = 16;
const MAX_MISSILES = 24;
const MAX_LAUNCHERS = 8;

/** A delta-wing attack drone about 2.5 m across, built along +x (nose), y left, z up. */
function droneGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.CylinderGeometry(0.2, 0.26, 3.2, 10);
  body.rotateZ(-Math.PI / 2);
  parts.push(body);
  const nose = new THREE.SphereGeometry(0.2, 10, 8);
  nose.translate(1.6, 0, 0);
  parts.push(nose);
  // The wing: a flat delta from just behind the nose to the tail.
  const wing = new THREE.BufferGeometry();
  const w = new Float32Array([0.6, 0, 0, -1.45, 1.25, 0, -1.45, -1.25, 0]);
  wing.setAttribute("position", new THREE.BufferAttribute(w, 3));
  wing.setIndex([0, 1, 2, 0, 2, 1]);
  wing.computeVertexNormals();
  parts.push(wing);
  // Fins at the wing tips.
  for (const side of [1, -1]) {
    const fin = new THREE.BufferGeometry();
    const f = new Float32Array([
      -1.0,
      1.15 * side,
      0,
      -1.5,
      1.25 * side,
      0,
      -1.55,
      1.25 * side,
      0.5,
    ]);
    fin.setAttribute("position", new THREE.BufferAttribute(f, 3));
    fin.setIndex([0, 1, 2, 0, 2, 1]);
    fin.computeVertexNormals();
    parts.push(fin);
  }
  // The pusher propeller, a thin disc at the tail.
  const prop = new THREE.CylinderGeometry(0.45, 0.45, 0.04, 16);
  prop.rotateZ(Math.PI / 2);
  prop.translate(-1.68, 0, 0);
  parts.push(prop);
  return parts;
}

/** A jet-powered attack drone about 4 m long: slim body, swept wings, twin fins, along +x. */
function jetGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.CylinderGeometry(0.16, 0.24, 3.8, 10);
  body.rotateZ(-Math.PI / 2);
  parts.push(body);
  const nose = new THREE.ConeGeometry(0.16, 0.7, 10);
  nose.rotateZ(-Math.PI / 2);
  nose.translate(2.25, 0, 0);
  parts.push(nose);
  const flat = (points: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(points), 3),
    );
    g.setIndex([0, 1, 2, 0, 2, 1, 0, 2, 3, 0, 3, 2]);
    g.computeVertexNormals();
    return g;
  };
  // Swept wings and tailplanes: quads from root leading edge to tip and back.
  for (const side of [1, -1]) {
    parts.push(
      flat([
        0.5,
        0.1 * side,
        0,
        -0.5,
        1.25 * side,
        0,
        -0.9,
        1.25 * side,
        0,
        -0.4,
        0.1 * side,
        0,
      ]),
    );
    parts.push(
      flat([
        -1.4,
        0.1 * side,
        0.05,
        -1.9,
        0.55 * side,
        0.05,
        -2.05,
        0.55 * side,
        0.05,
        -1.85,
        0.1 * side,
        0.05,
      ]),
    );
    parts.push(
      flat([
        -1.35,
        0.12 * side,
        0.1,
        -1.85,
        0.3 * side,
        0.6,
        -2.0,
        0.3 * side,
        0.6,
        -1.9,
        0.12 * side,
        0.1,
      ]),
    );
  }
  // The engine pod on its back.
  const pod = new THREE.CylinderGeometry(0.17, 0.2, 1.2, 10);
  pod.rotateZ(-Math.PI / 2);
  pod.translate(-1.2, 0, 0.3);
  parts.push(pod);
  return parts;
}

/** A hunter: a quadcopter about 1.2 m across, X frame, four rotor discs. */
function quadGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.BoxGeometry(0.45, 0.3, 0.18);
  parts.push(body);
  for (const angle of [45, 135, 225, 315]) {
    const a = (angle * Math.PI) / 180;
    const arm = new THREE.BoxGeometry(0.62, 0.05, 0.04);
    arm.translate(0.31, 0, 0);
    arm.rotateZ(a);
    parts.push(arm);
  }
  // Rotor discs last, so they get the see-through material.
  for (const angle of [45, 135, 225, 315]) {
    const a = (angle * Math.PI) / 180;
    const disc = new THREE.CylinderGeometry(0.26, 0.26, 0.01, 18);
    disc.rotateX(Math.PI / 2);
    disc.translate(Math.cos(a) * 0.6, Math.sin(a) * 0.6, 0.06);
    parts.push(disc);
  }
  return parts;
}

/** A missile about 2 m long along +x. */
function missileGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.CylinderGeometry(0.08, 0.08, 1.7, 8);
  body.rotateZ(-Math.PI / 2);
  parts.push(body);
  const nose = new THREE.ConeGeometry(0.08, 0.3, 8);
  nose.rotateZ(-Math.PI / 2);
  nose.translate(1.0, 0, 0);
  parts.push(nose);
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.BoxGeometry(0.22, 0.01, 0.34);
    fin.translate(-0.72, 0, 0);
    fin.rotateX((i * Math.PI) / 2);
    parts.push(fin);
  }
  return parts;
}

/** A drone launcher: a six-wheel truck with its rail raised at the launch angle, rail end forward. */
function launcherGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const bed = new THREE.BoxGeometry(7, 2.4, 1.1);
  bed.translate(-0.6, 0, 1.3);
  parts.push(bed);
  const cab = new THREE.BoxGeometry(1.8, 2.4, 1.6);
  cab.translate(3.6, 0, 1.6);
  parts.push(cab);
  for (const x of [3.4, -1.6, -3.2])
    for (const y of [1.1, -1.1]) {
      const wheel = new THREE.CylinderGeometry(0.55, 0.55, 0.4, 12);
      wheel.translate(x, y, 0.55);
      parts.push(wheel);
    }
  // The rail, 6 m long, pivoting at the back of the bed and pointing up and forward at 35°.
  const rail = new THREE.BoxGeometry(6, 0.5, 0.35);
  rail.translate(3, 0, 0);
  rail.rotateY((-35 * Math.PI) / 180);
  rail.translate(-3.8, 0, 2.1);
  parts.push(rail);
  return parts;
}

export function createStrikeLayer(id: string): StrikeLayer {
  let renderer: THREE.WebGLRenderer | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let view: StrikeView | null = null;

  const scene = new THREE.Scene();
  const lights = createLights(scene);
  const camera = new THREE.PerspectiveCamera(37, 1, 1, 100_000);

  const droneParts = droneGeometry();
  const droneMaterial = new THREE.MeshStandardMaterial({
    color: 0x3b3f44,
    roughness: 0.7,
    side: THREE.DoubleSide,
  });
  const propMaterial = new THREE.MeshBasicMaterial({
    color: 0x111111,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  });
  const drones = Array.from({ length: MAX_THREATS }, () => {
    const group = new THREE.Group();
    droneParts.forEach((g, i) =>
      group.add(
        new THREE.Mesh(
          g,
          i === droneParts.length - 1 ? propMaterial : droneMaterial,
        ),
      ),
    );
    group.matrixAutoUpdate = false;
    group.visible = false;
    scene.add(group);
    return group;
  });
  // Jets and hunters: their own pools of their own models.
  const pool = (parts: THREE.BufferGeometry[], max: number, see: number) =>
    Array.from({ length: max }, () => {
      const group = new THREE.Group();
      parts.forEach((g, i) =>
        group.add(
          new THREE.Mesh(
            g,
            i >= parts.length - see ? propMaterial : droneMaterial,
          ),
        ),
      );
      group.matrixAutoUpdate = false;
      group.visible = false;
      scene.add(group);
      return group;
    });
  const jetParts = jetGeometry();
  const quadParts = quadGeometry();
  const jets = pool(jetParts, MAX_SPECIAL, 0);
  const quads = pool(quadParts, MAX_SPECIAL, 4);
  // The partner's interceptor: the quadcopter model, light grey so it is not taken for a hunter.
  const allyMaterial = new THREE.MeshStandardMaterial({
    color: 0xd8dde2,
    roughness: 0.6,
    side: THREE.DoubleSide,
  });
  const ally = new THREE.Group();
  quadParts.forEach((g, i) =>
    ally.add(
      new THREE.Mesh(
        g,
        i >= quadParts.length - 4 ? propMaterial : allyMaterial,
      ),
    ),
  );
  ally.matrixAutoUpdate = false;
  ally.visible = false;
  scene.add(ally);
  // Debris: small dark specks a couple of pixels across.
  const debrisGeometry = new THREE.BufferGeometry();
  const debrisPositions = new THREE.BufferAttribute(
    new Float32Array(MAX_DEBRIS * 3),
    3,
  );
  debrisPositions.setUsage(THREE.DynamicDrawUsage);
  debrisGeometry.setAttribute("position", debrisPositions);
  const debrisMaterial = new THREE.PointsMaterial({
    color: 0x151310,
    size: 2.5,
    sizeAttenuation: false,
  });
  const debris = new THREE.Points(debrisGeometry, debrisMaterial);
  debris.matrixAutoUpdate = false;
  debris.frustumCulled = false;
  debris.visible = false;
  scene.add(debris);

  // Tracers: bright streaks, added onto the scene.
  const tracerGeometry = new THREE.BufferGeometry();
  const tracerPositions = new THREE.BufferAttribute(
    new Float32Array(MAX_TRACERS * 6),
    3,
  );
  tracerPositions.setUsage(THREE.DynamicDrawUsage);
  tracerGeometry.setAttribute("position", tracerPositions);
  const tracerMaterial = new THREE.LineBasicMaterial({
    color: 0xffd27a,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const tracers = new THREE.LineSegments(tracerGeometry, tracerMaterial);
  tracers.matrixAutoUpdate = false;
  tracers.frustumCulled = false;
  tracers.visible = false;
  scene.add(tracers);
  // Navigation lights: a red blink on each drone, a few pixels across at any range.
  const navGeometry = new THREE.BufferGeometry();
  const navPositions = new THREE.BufferAttribute(
    new Float32Array(MAX_THREATS * 3),
    3,
  );
  navPositions.setUsage(THREE.DynamicDrawUsage);
  navGeometry.setAttribute("position", navPositions);
  const navMaterial = new THREE.PointsMaterial({
    color: 0xff3b2f,
    size: 5,
    sizeAttenuation: false,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const navLights = new THREE.Points(navGeometry, navMaterial);
  navLights.matrixAutoUpdate = false;
  navLights.frustumCulled = false;
  navLights.visible = false;
  scene.add(navLights);
  // White-hot: the same meshes, lit from inside.
  const COLD = {
    debris: new THREE.Color(0x151310),
    speck: new THREE.Color(0x1c1c1c),
  };
  const HOT = new THREE.Color(0xffffff);
  let hot = false;
  const setThermal = (on: boolean) => {
    if (on === hot) return;
    hot = on;
    droneMaterial.emissive.set(on ? 0xffffff : 0x000000);
    droneMaterial.emissiveIntensity = on ? 1.1 : 0;
    missileMaterial.emissive.set(on ? 0xffffff : 0x000000);
    missileMaterial.emissiveIntensity = on ? 1.2 : 0;
    debrisMaterial.color.copy(on ? HOT : COLD.debris);
    speckMaterial.color.copy(on ? HOT : COLD.speck);
    propMaterial.color.set(on ? 0xdddddd : 0x111111);
  };

  // Far away a drone is smaller than a pixel: a dark speck a few pixels across stands in for it.
  const speckGeometry = new THREE.BufferGeometry();
  const speckPositions = new THREE.BufferAttribute(
    new Float32Array(MAX_THREATS * 3),
    3,
  );
  speckPositions.setUsage(THREE.DynamicDrawUsage);
  speckGeometry.setAttribute("position", speckPositions);
  const speckMaterial = new THREE.PointsMaterial({
    color: 0x1c1c1c,
    size: 3,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.85,
  });
  const specks = new THREE.Points(speckGeometry, speckMaterial);
  specks.matrixAutoUpdate = false;
  specks.frustumCulled = false;
  scene.add(specks);

  const missileParts = missileGeometry();
  const missileMaterial = new THREE.MeshStandardMaterial({
    color: 0xe8e8e2,
    roughness: 0.5,
  });
  const missiles = Array.from({ length: MAX_MISSILES }, () => {
    const group = new THREE.Group();
    for (const g of missileParts) group.add(new THREE.Mesh(g, missileMaterial));
    group.matrixAutoUpdate = false;
    group.visible = false;
    scene.add(group);
    return group;
  });

  const trails = createSmokeCloud(scene, MAX_TRAIL_PUFFS, 0xdedbd4, 0.8);
  const smoke = createSmokeCloud(scene, MAX_SMOKE_PUFFS, 0x2e2a26, 2.4);
  const fire = createSmokeCloud(scene, MAX_FIRE_PUFFS, 0xff7a1a, 1.6, true);

  const siteGeometry = new THREE.RingGeometry(0.97, 1, 96);
  const siteMaterial = new THREE.MeshBasicMaterial({
    color: 0x2cc4ae,
    transparent: true,
    opacity: 0.75,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const siteRing = new THREE.Mesh(siteGeometry, siteMaterial);
  siteRing.matrixAutoUpdate = false;
  siteRing.visible = false;
  scene.add(siteRing);
  const beamGeometry = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true);
  beamGeometry.translate(0, 0.5, 0);
  const beamMaterial = new THREE.MeshBasicMaterial({
    color: 0x2cc4ae,
    transparent: true,
    opacity: 0.18,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(beamGeometry, beamMaterial);
  beam.matrixAutoUpdate = false;
  beam.visible = false;
  scene.add(beam);
  // Launchers: the truck model, and an orange beam over each so it can be found from afar.
  const launcherParts = launcherGeometry();
  const launcherMaterial = new THREE.MeshStandardMaterial({
    color: 0x5a5a3c,
    roughness: 0.85,
  });
  const launcherBeamMaterial = new THREE.MeshBasicMaterial({
    color: 0xff8a2a,
    transparent: true,
    opacity: 0.16,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const launcherPool = Array.from({ length: MAX_LAUNCHERS }, () => {
    const truck = new THREE.Group();
    for (const g of launcherParts)
      truck.add(new THREE.Mesh(g, launcherMaterial));
    const beam = new THREE.Mesh(beamGeometry, launcherBeamMaterial);
    for (const o of [truck, beam]) {
      o.matrixAutoUpdate = false;
      o.visible = false;
      scene.add(o);
    }
    return { truck, beam };
  });
  const healthy = new THREE.Color(0x2cc4ae);
  const hurt = new THREE.Color(0xffb547);
  const lost = new THREE.Color(0xff4d4d);

  /** An object along `forward`, kept upright (its z as near world up as the heading allows). */
  const placeAlong = (
    object: THREE.Object3D,
    eye: Mat3,
    forward: Vec3,
    offset: Vec3,
  ) => {
    const x = normalize(forward);
    const side = cross([0, 0, 1], x);
    const y: Vec3 = Math.hypot(...side) > 1e-6 ? normalize(side) : [0, 1, 0];
    place(object, eye, x, y, cross(x, y), offset);
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
      renderer.autoClear = false;
    },

    onRemove() {
      for (const g of [
        ...droneParts,
        ...jetParts,
        ...quadParts,
        ...missileParts,
        speckGeometry,
        debrisGeometry,
        tracerGeometry,
        navGeometry,
        siteGeometry,
        beamGeometry,
        ...launcherParts,
      ])
        g.dispose();
      for (const m of [
        droneMaterial,
        propMaterial,
        speckMaterial,
        debrisMaterial,
        tracerMaterial,
        navMaterial,
        missileMaterial,
        siteMaterial,
        beamMaterial,
        launcherMaterial,
        allyMaterial,
        launcherBeamMaterial,
      ])
        m.dispose();
      for (const c of [trails, smoke, fire]) disposeSmoke(c);
      // Not renderer.dispose(): that would lose the context MapLibre is still using.
      renderer?.renderLists.dispose();
      renderer = null;
    },

    render(_gl, args) {
      if (!renderer || !canvas || !view) return;
      const current = view;
      const { eye } = current;
      renderer.resetState();
      renderer.setViewport(0, 0, canvas.width, canvas.height);

      setThermal(current.thermal);
      const lines = current.tracers;
      tracers.visible = Boolean(lines && lines.count > 0);
      if (lines && tracers.visible) {
        const n = Math.min(lines.count, MAX_TRACERS);
        (tracerPositions.array as Float32Array).set(
          lines.offsets.subarray(0, n * 6),
        );
        tracerPositions.needsUpdate = true;
        tracerGeometry.setDrawRange(0, n * 2);
        place(tracers, eye, [1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]);
      }
      // The lights blink together, about once a second.
      navLights.visible =
        current.navLights &&
        current.threats.length > 0 &&
        current.time % 1.1 < 0.25;
      if (navLights.visible) {
        const n = Math.min(current.threats.length, MAX_THREATS);
        for (let i = 0; i < n; i++)
          (navPositions.array as Float32Array).set(
            current.threats[i].offset,
            i * 3,
          );
        navPositions.needsUpdate = true;
        navGeometry.setDrawRange(0, n);
        place(navLights, eye, [1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]);
      }

      // Each model's pool takes the drones of its kind, in order.
      const pools = { delta: drones, jet: jets, quad: quads };
      const used = { delta: 0, jet: 0, quad: 0 };
      for (const t of current.threats) {
        const group = pools[t.model][used[t.model]];
        if (!group) continue;
        used[t.model]++;
        group.visible = true;
        placeAlong(group, eye, t.forward, t.offset);
      }
      for (const model of ["delta", "jet", "quad"] as const)
        for (let i = used[model]; i < pools[model].length; i++)
          pools[model][i].visible = false;
      const pieces = current.debris;
      debris.visible = Boolean(pieces && pieces.count > 0);
      if (pieces && debris.visible) {
        const n = Math.min(pieces.count, MAX_DEBRIS);
        (debrisPositions.array as Float32Array).set(
          pieces.offsets.subarray(0, n * 3),
        );
        debrisPositions.needsUpdate = true;
        debrisGeometry.setDrawRange(0, n);
        place(debris, eye, [1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]);
      }
      const count = Math.min(current.threats.length, MAX_THREATS);
      for (let i = 0; i < count; i++)
        (speckPositions.array as Float32Array).set(
          current.threats[i].offset,
          i * 3,
        );
      speckPositions.needsUpdate = true;
      speckGeometry.setDrawRange(0, count);
      specks.visible = count > 0;
      place(specks, eye, [1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]);

      missiles.forEach((group, i) => {
        const m = current.missiles[i];
        group.visible = Boolean(m);
        if (m) placeAlong(group, eye, m.forward, m.offset);
      });

      const pixelScale =
        canvas.height / 2 / Math.tan((current.fov * Math.PI) / 360);
      drawSmoke(trails, current.trails, eye, pixelScale);
      drawSmoke(smoke, current.smoke, eye, pixelScale);
      drawSmoke(fire, current.fire, eye, pixelScale);

      const site = current.site;
      siteRing.visible = beam.visible = Boolean(site);
      if (site) {
        const colour =
          site.health > 0.5
            ? healthy.clone().lerp(hurt, (1 - site.health) * 2)
            : hurt.clone().lerp(lost, 1 - site.health * 2);
        siteMaterial.color.copy(colour);
        beamMaterial.color.copy(colour);
        const r = site.radius;
        place(siteRing, eye, [r, 0, 0], [0, r, 0], [0, 0, 1], site.offset);
        place(beam, eye, [3, 0, 0], [0, 0, 600], [0, -3, 0], site.offset);
      }
      ally.visible = Boolean(current.partner);
      if (current.partner)
        placeAlong(ally, eye, current.partner.forward, current.partner.offset);
      launcherPool.forEach(({ truck, beam }, i) => {
        const l = current.launchers[i];
        truck.visible = beam.visible = Boolean(l);
        if (!l) return;
        placeAlong(truck, eye, l.forward, l.offset);
        // Wider with distance, so it stays a few pixels across (2 m up close, 15 m at 7 km).
        const r = Math.max(2, Math.hypot(...l.offset) * 0.002);
        place(beam, eye, [r, 0, 0], [0, 0, 400], [0, -r, 0], l.offset);
      });

      camera.fov = current.fov;
      camera.aspect = canvas.width / canvas.height;
      camera.near = args.nearZ / current.pixelsPerMeter;
      camera.far = args.farZ / current.pixelsPerMeter;
      camera.updateProjectionMatrix();
      aimLights(eye, lights, current.light ?? DAY_LIGHT);
      renderer.render(scene, camera);
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
