/**
 * Aircraft sound, synthesised with Web Audio: no samples to license or
 * download (see public/models/CREDITS.md).
 *
 * - Engine: two detuned sawtooth oscillators at the firing frequency of a
 *   four-cylinder engine (rpm / 30) and an octave below, through a low-pass
 *   that opens with power.
 * - Wind: looped white noise through a band-pass, louder with airspeed squared.
 * - Stall horn: a steady reed-like tone.
 * - Race cues: countdown beeps, a chime per gate, a buzz for a missed one,
 *   a short fanfare at the finish. Plain tones with quick envelopes.
 * - Drone defence: the interceptor's rotor buzz, the seeker's tone (low
 *   while it hunts, high once locked), noise bursts for launches, gun rounds
 *   and explosions, and the nearest enemy drone heard by kind (a two-stroke
 *   buzz, a jet's whoosh, a quadcopter's whine), Doppler-shifted as it closes.
 *
 * Browsers only start audio after a user gesture, so `start()` is called from
 * the click that begins the flight.
 */

export interface AudioState {
  rpm: number;
  /** 0–1. */
  throttle: number;
  /** m/s. */
  airspeed: number;
  stall: boolean;
  /** A turbofan: `rpm` is engine speed in %, and it whines and roars instead of firing. */
  jet?: boolean;
  /** A helicopter: `rpm` is rotor speed in %; blade slap over turbine whine, `throttle` is torque. */
  heli?: boolean;
  /** A quadcopter: `airspeed` drives its buzz, `throttle` its effort. */
  drone?: boolean;
  /** Missile seeker: hunting for a target, or locked on. */
  tone?: "seek" | "lock" | null;
  /** The nearest enemy drone: what it sounds like, metres away, closing speed m/s. */
  threat?: {
    sound: "prop" | "jet" | "quad";
    distance: number;
    closing: number;
  } | null;
}

/** Enemy drones are heard within this, metres. */
const THREAT_HEARD = 900;
const SOUND_SPEED = 343;

export type RaceCue =
  | "count"
  | "go"
  | "gate"
  | "missed"
  | "finish"
  | "best"
  | "launch"
  | "boom"
  | "alarm"
  | "lock"
  | "gun";

/**
 * Each cue: notes as [semitones above A4, start s, length s], and a timbre;
 * or a burst of noise through a band-pass sweeping from `from` to `to` Hz.
 */
const CUES: Record<
  RaceCue,
  {
    notes: [number, number, number][];
    type: OscillatorType;
    gain: number;
    noise?: { from: number; to: number; length: number };
  }
> = {
  count: { notes: [[3, 0, 0.14]], type: "sine", gain: 0.22 },
  go: { notes: [[15, 0, 0.5]], type: "sine", gain: 0.26 },
  gate: {
    notes: [
      [12, 0, 0.09],
      [19, 0.07, 0.16],
    ],
    type: "triangle",
    gain: 0.2,
  },
  missed: {
    notes: [
      [-14, 0, 0.32],
      [-15, 0.04, 0.3],
    ],
    type: "sawtooth",
    gain: 0.09,
  },
  finish: {
    notes: [
      [3, 0, 0.16],
      [7, 0.13, 0.16],
      [10, 0.26, 0.16],
      [15, 0.39, 0.6],
    ],
    type: "triangle",
    gain: 0.22,
  },
  best: {
    notes: [
      [3, 0, 0.12],
      [7, 0.1, 0.12],
      [10, 0.2, 0.12],
      [15, 0.3, 0.12],
      [19, 0.4, 0.12],
      [22, 0.5, 0.7],
    ],
    type: "triangle",
    gain: 0.22,
  },
  launch: {
    notes: [],
    type: "sine",
    gain: 0.5,
    noise: { from: 600, to: 2600, length: 0.9 },
  },
  boom: {
    notes: [[-33, 0, 0.5]],
    type: "sine",
    gain: 0.35,
    noise: { from: 900, to: 90, length: 1.4 },
  },
  alarm: {
    notes: [
      [2, 0, 0.18],
      [-3, 0.2, 0.18],
      [2, 0.4, 0.18],
      [-3, 0.6, 0.18],
    ],
    type: "square",
    gain: 0.07,
  },
  lock: {
    notes: [
      [24, 0, 0.06],
      [24, 0.09, 0.06],
    ],
    type: "square",
    gain: 0.05,
  },
  gun: {
    notes: [[-26, 0, 0.05]],
    type: "triangle",
    gain: 0.12,
    noise: { from: 3200, to: 700, length: 0.07 },
  },
};

export interface FlightAudio {
  start(): void;
  /** Play a cue (needs start() first; quiet if audio never started), `volume` 0–1. */
  cue(name: RaceCue, volume?: number): void;
  update(state: AudioState): void;
  /** Fade everything out (pause, crash, sound switched off). */
  silence(): void;
  dispose(): void;
}

export function createFlightAudio(): FlightAudio {
  let ctx: AudioContext | null = null;
  let nodes: {
    master: GainNode;
    engine: GainNode;
    filter: BiquadFilterNode;
    high: OscillatorNode;
    low: OscillatorNode;
    wind: GainNode;
    windFilter: BiquadFilterNode;
    horn: GainNode;
    hornTone: OscillatorNode;
    noise: AudioBuffer;
    threatGain: GainNode;
    threatTone: OscillatorNode;
    threatFilter: BiquadFilterNode;
    threatHiss: GainNode;
    threatHissFilter: BiquadFilterNode;
  } | null = null;

  const build = () => {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    const engine = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    const high = ctx.createOscillator();
    high.type = "sawtooth";
    const low = ctx.createOscillator();
    low.type = "sawtooth";
    low.detune.value = 7;
    high.connect(filter);
    low.connect(filter);
    filter.connect(engine).connect(master);
    high.start();
    low.start();

    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = "bandpass";
    windFilter.Q.value = 0.6;
    const wind = ctx.createGain();
    wind.gain.value = 0;
    source.connect(windFilter).connect(wind).connect(master);
    source.start();

    const hornTone = ctx.createOscillator();
    hornTone.type = "square";
    hornTone.frequency.value = 520;
    const hornFilter = ctx.createBiquadFilter();
    hornFilter.type = "bandpass";
    hornFilter.frequency.value = 1040;
    const horn = ctx.createGain();
    horn.gain.value = 0;
    hornTone.connect(hornFilter).connect(horn).connect(master);
    hornTone.start();

    // The nearest enemy drone: a tone (engine or rotors) and a hiss (a jet's exhaust).
    const threatGain = ctx.createGain();
    threatGain.gain.value = 0;
    const threatTone = ctx.createOscillator();
    threatTone.type = "sawtooth";
    const threatFilter = ctx.createBiquadFilter();
    threatFilter.type = "lowpass";
    threatTone.connect(threatFilter).connect(threatGain);
    threatTone.start();
    const hissSource = ctx.createBufferSource();
    hissSource.buffer = noise;
    hissSource.loop = true;
    const threatHissFilter = ctx.createBiquadFilter();
    threatHissFilter.type = "bandpass";
    threatHissFilter.Q.value = 0.7;
    const threatHiss = ctx.createGain();
    threatHiss.gain.value = 0;
    hissSource
      .connect(threatHissFilter)
      .connect(threatHiss)
      .connect(threatGain);
    hissSource.start(0, 0.7);
    threatGain.connect(master);

    nodes = {
      master,
      engine,
      filter,
      high,
      low,
      wind,
      windFilter,
      horn,
      hornTone,
      noise,
      threatGain,
      threatTone,
      threatFilter,
      threatHiss,
      threatHissFilter,
    };
  };

  const ramp = (param: AudioParam, value: number, seconds = 0.08) => {
    if (ctx) param.setTargetAtTime(value, ctx.currentTime, seconds);
  };

  return {
    start() {
      try {
        if (!ctx) build();
        void ctx?.resume();
      } catch {
        ctx = null;
        nodes = null;
      }
    },
    cue(name, volume = 1) {
      if (!ctx || ctx.state !== "running") return;
      const { notes, type, noise } = CUES[name];
      const gain = CUES[name].gain * Math.max(0, Math.min(1, volume));
      if (gain < 0.002) return;
      const now = ctx.currentTime;
      if (noise && nodes) {
        const source = ctx.createBufferSource();
        source.buffer = nodes.noise;
        source.loop = true;
        const band = ctx.createBiquadFilter();
        band.type = "bandpass";
        band.Q.value = 0.8;
        band.frequency.setValueAtTime(noise.from, now);
        band.frequency.exponentialRampToValueAtTime(
          noise.to,
          now + noise.length,
        );
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, now);
        env.gain.linearRampToValueAtTime(gain, now + 0.02);
        env.gain.exponentialRampToValueAtTime(0.0001, now + noise.length);
        source.connect(band).connect(env).connect(ctx.destination);
        source.start(now, Math.random());
        source.stop(now + noise.length + 0.05);
      }
      for (const [semitones, at, length] of notes) {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = 440 * 2 ** (semitones / 12);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, now + at);
        env.gain.linearRampToValueAtTime(gain, now + at + 0.012);
        env.gain.exponentialRampToValueAtTime(0.0001, now + at + length);
        // Straight to the speakers: cues stay audible over the engine.
        osc.connect(env).connect(ctx.destination);
        osc.start(now + at);
        osc.stop(now + at + length + 0.05);
      }
    },
    update({
      rpm,
      throttle,
      airspeed,
      stall,
      jet = false,
      heli = false,
      drone = false,
      tone = null,
      threat = null,
    }) {
      if (!nodes) return;
      if (threat && threat.distance < THREAT_HEARD) {
        const near = 1 - threat.distance / THREAT_HEARD;
        const doppler = Math.max(
          0.7,
          Math.min(1.5, SOUND_SPEED / (SOUND_SPEED - threat.closing)),
        );
        if (threat.sound === "jet") {
          ramp(nodes.threatTone.frequency, 620 * doppler, 0.05);
          ramp(nodes.threatFilter.frequency, 1500 * doppler, 0.05);
          ramp(nodes.threatHissFilter.frequency, 2200 * doppler, 0.05);
          ramp(nodes.threatHiss.gain, 1.6, 0.05);
        } else if (threat.sound === "quad") {
          ramp(nodes.threatTone.frequency, 410 * doppler, 0.05);
          ramp(nodes.threatFilter.frequency, 2600, 0.05);
          ramp(nodes.threatHiss.gain, 0, 0.05);
        } else {
          // A small two-stroke: a coarse, low buzz.
          ramp(nodes.threatTone.frequency, 96 * doppler, 0.05);
          ramp(nodes.threatFilter.frequency, 1100, 0.05);
          ramp(nodes.threatHiss.gain, 0, 0.05);
        }
        ramp(nodes.threatGain.gain, 0.28 * near * near, 0.08);
      } else {
        ramp(nodes.threatGain.gain, 0, 0.15);
      }
      if (drone) {
        // Four small rotors: a buzz rising with effort.
        const effort = Math.max(0, Math.min(1, throttle));
        ramp(nodes.high.frequency, 190 + 160 * effort);
        ramp(nodes.low.frequency, 95 + 80 * effort);
        ramp(nodes.filter.frequency, 900 + 1400 * effort);
        ramp(nodes.engine.gain, 0.035 + 0.05 * effort);
      } else if (heli) {
        // Four blades at 395 rpm pass about 26 times a second: a low thrum,
        // heavier with torque, over the turbines' whine.
        const share = Math.max(0, rpm) / 100;
        ramp(nodes.low.frequency, 26 * share);
        ramp(nodes.high.frequency, 1500 + 900 * share);
        ramp(nodes.filter.frequency, 380 + 900 * throttle);
        ramp(nodes.engine.gain, (0.08 + 0.14 * throttle) * share);
      } else if (jet) {
        // Compressor whine rising with the spool, over a low roar.
        const spool = Math.max(0, (rpm - 40) / 60);
        ramp(nodes.high.frequency, 900 + 1700 * spool);
        ramp(nodes.low.frequency, 45 + 40 * spool);
        ramp(nodes.filter.frequency, 1400 + 2600 * spool);
        ramp(nodes.engine.gain, 0.04 + 0.1 * spool);
      } else {
        const firing = rpm / 30;
        ramp(nodes.high.frequency, firing);
        ramp(nodes.low.frequency, firing / 2);
        ramp(nodes.filter.frequency, 260 + rpm * 0.28 + throttle * 500);
        ramp(nodes.engine.gain, 0.1 + 0.16 * throttle);
      }
      const rush = Math.min(1, airspeed / (jet ? 220 : drone ? 140 : 70));
      ramp(nodes.windFilter.frequency, 350 + 900 * rush);
      ramp(nodes.wind.gain, 0.3 * rush * rush);
      if (tone)
        ramp(nodes.hornTone.frequency, tone === "lock" ? 1240 : 620, 0.01);
      else ramp(nodes.hornTone.frequency, 520, 0.01);
      ramp(
        nodes.horn.gain,
        stall ? 0.07 : tone === "lock" ? 0.06 : tone === "seek" ? 0.025 : 0,
        0.02,
      );
      ramp(nodes.master.gain, 0.6, 0.15);
    },
    silence() {
      if (nodes) ramp(nodes.master.gain, 0, 0.1);
    },
    dispose() {
      void ctx?.close().catch(() => {});
      ctx = null;
      nodes = null;
    },
  };
}
