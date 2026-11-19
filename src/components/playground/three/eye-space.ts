import * as THREE from "three";
import { applyMat3, type Mat3 } from "@/lib/flight/camera";
import type { Vec3 } from "@/lib/flight/vec";
import type { SceneLight } from "../time-of-day";

/**
 * Pieces shared by the custom layers that draw with three.js inside
 * MapLibre's context. Their scenes live in eye space: every object gets a
 * model matrix built straight from its axes and its offset from the camera
 * (east-north-up metres, already camera-relative), so the GPU only sees
 * small numbers.
 */

/** A model matrix straight into eye space: columns are the object's axes in eye space, then its offset. */
export function place(
  object: THREE.Object3D,
  eye: Mat3,
  x: Vec3,
  y: Vec3,
  z: Vec3,
  offset: Vec3,
) {
  const ex = applyMat3(eye, x);
  const ey = applyMat3(eye, y);
  const ez = applyMat3(eye, z);
  const t = applyMat3(eye, offset);
  object.matrix.set(
    ex[0],
    ey[0],
    ez[0],
    t[0],
    ex[1],
    ey[1],
    ez[1],
    t[1],
    ex[2],
    ey[2],
    ez[2],
    t[2],
    0,
    0,
    0,
    1,
  );
  object.matrixWorldNeedsUpdate = true;
}

export interface SceneLights {
  sky: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
}

export function createLights(scene: THREE.Scene): SceneLights {
  const sky = new THREE.HemisphereLight(0xdfeaf5, 0x6f6a5c, 1.5);
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
  scene.add(sky, sun, sun.target);
  return { sky, sun };
}

/** Lights live in the world; the scenes are in eye space. */
export function aimLights(eye: Mat3, l: SceneLights, light: SceneLight) {
  l.sky.position.set(...applyMat3(eye, [0, 0, 1]));
  l.sky.color.set(light.skyColor);
  l.sky.groundColor.set(light.groundColor);
  l.sky.intensity = light.skyIntensity;
  l.sun.position.set(...applyMat3(eye, light.sun));
  l.sun.color.set(light.sunColor);
  l.sun.intensity = light.sunIntensity;
  l.sun.target.position.set(0, 0, 0);
}

const SMOKE_VERTEX = /* glsl */ `
  attribute float age;
  uniform float scale;
  uniform float size;
  varying float vAge;
  void main() {
    vec4 eye = modelViewMatrix * vec4(position, 1.0);
    // Puffs start about 1.6 m across and spread to about 9 m (times the size uniform).
    gl_PointSize = clamp((1.6 + 7.5 * sqrt(age)) * size * scale / -eye.z, 1.0, 512.0);
    gl_Position = projectionMatrix * eye;
    vAge = age;
  }
`;

const SMOKE_FRAGMENT = /* glsl */ `
  uniform vec3 color;
  varying float vAge;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float soft = smoothstep(1.0, 0.25, d);
    float alpha = soft * (1.0 - vAge) * (1.0 - vAge) * 0.55;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

/** Fire: white-hot to orange to dull red as it ages, added onto what is behind it. */
const FIRE_FRAGMENT = /* glsl */ `
  uniform vec3 color;
  varying float vAge;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float soft = smoothstep(1.0, 0.0, d);
    vec3 hot = mix(vec3(1.0, 0.95, 0.75), color, smoothstep(0.0, 0.35, vAge));
    hot = mix(hot, vec3(0.45, 0.08, 0.02), smoothstep(0.4, 1.0, vAge));
    float alpha = soft * (1.0 - vAge) * (1.0 - vAge);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(hot * alpha, alpha);
  }
`;

export interface PuffData {
  offsets: Float32Array;
  ages: Float32Array;
  count: number;
}

export type SmokeCloud = ReturnType<typeof createSmokeCloud>;

/** Soft round points sized in metres: smoke, or (fire: true) glowing fire. */
export function createSmokeCloud(
  scene: THREE.Scene,
  max: number,
  colour: number,
  size = 1,
  fire = false,
) {
  const geometry = new THREE.BufferGeometry();
  const positions = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
  const ages = new THREE.BufferAttribute(new Float32Array(max), 1);
  positions.setUsage(THREE.DynamicDrawUsage);
  ages.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positions);
  geometry.setAttribute("age", ages);
  const material = new THREE.ShaderMaterial({
    vertexShader: SMOKE_VERTEX,
    fragmentShader: fire ? FIRE_FRAGMENT : SMOKE_FRAGMENT,
    uniforms: {
      scale: { value: 500 },
      size: { value: size },
      color: { value: new THREE.Color(colour) },
    },
    transparent: true,
    depthWrite: false,
    blending: fire ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.matrixAutoUpdate = false;
  points.frustumCulled = false;
  points.visible = false;
  scene.add(points);
  return { points, geometry, material, positions, ages, max };
}

export function drawSmoke(
  cloud: SmokeCloud,
  data: PuffData | null | undefined,
  eye: Mat3,
  pixelScale: number,
) {
  cloud.points.visible = Boolean(data && data.count > 0);
  if (!data || !cloud.points.visible) return;
  const count = Math.min(data.count, cloud.max);
  (cloud.positions.array as Float32Array).set(
    data.offsets.subarray(0, count * 3),
  );
  (cloud.ages.array as Float32Array).set(data.ages.subarray(0, count));
  cloud.positions.needsUpdate = true;
  cloud.ages.needsUpdate = true;
  cloud.geometry.setDrawRange(0, count);
  // Positions are already camera-relative, east-north-up: only the eye rotation is left.
  place(cloud.points, eye, [1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]);
  cloud.material.uniforms.scale.value = pixelScale;
}

export function disposeSmoke(cloud: SmokeCloud) {
  cloud.geometry.dispose();
  cloud.material.dispose();
}

/** A fixed pool of puffs filled each frame: camera-relative positions and ages. */
export class PuffBuffer implements PuffData {
  readonly offsets: Float32Array;
  readonly ages: Float32Array;
  count = 0;
  readonly max: number;

  constructor(max: number) {
    this.max = max;
    this.offsets = new Float32Array(max * 3);
    this.ages = new Float32Array(max);
  }

  clear() {
    this.count = 0;
  }

  put(offset: Vec3, age: number) {
    if (this.count >= this.max) return;
    this.offsets.set(offset, this.count * 3);
    this.ages[this.count] = Math.min(1, Math.max(0, age));
    this.count++;
  }

  /** This frame's puffs, or null when there are none. */
  data(): PuffData | null {
    return this.count ? this : null;
  }
}
