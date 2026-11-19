/**
 * International Standard Atmosphere, troposphere and lower stratosphere.
 *
 * Keep this file import-free: Node runs the tests on it directly.
 */

export const SEA_LEVEL_DENSITY = 1.225;
export const GRAVITY = 9.80665;

const T0 = 288.15;
const P0 = 101_325;
const LAPSE = 0.0065;
const R_AIR = 287.053;
const TROPOPAUSE = 11_000;

export interface Air {
  /** Kelvin. */
  temperature: number;
  /** Pascal. */
  pressure: number;
  /** kg/m³. */
  density: number;
}

/** Standard air at a geopotential altitude in metres. */
export function standardAir(altitude: number): Air {
  const h = Math.max(-500, Math.min(altitude, 20_000));
  let temperature: number;
  let pressure: number;
  if (h <= TROPOPAUSE) {
    temperature = T0 - LAPSE * h;
    pressure = P0 * (temperature / T0) ** (GRAVITY / (LAPSE * R_AIR));
  } else {
    temperature = T0 - LAPSE * TROPOPAUSE;
    const p11 = P0 * (temperature / T0) ** (GRAVITY / (LAPSE * R_AIR));
    pressure =
      p11 * Math.exp((-GRAVITY * (h - TROPOPAUSE)) / (R_AIR * temperature));
  }
  return { temperature, pressure, density: pressure / (R_AIR * temperature) };
}

export const airDensity = (altitude: number) => standardAir(altitude).density;
