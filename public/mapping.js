// How space weather readings become musical parameters.
// Imported by both the Worker and the page, so live data and Simulate mode always agree.

export const clamp01 = x => Math.max(0, Math.min(1, x));

const LETTERS = ['A', 'B', 'C', 'M', 'X'];
const CLASS_BASE = { A: 1e-8, B: 1e-7, C: 1e-6, M: 1e-5, X: 1e-4 };

/** "M2.4" → 2.4e-5 W/m². Unknown input → 0. */
export function classToFlux(cls) {
  const m = /^([ABCMX])(\d+(?:\.\d+)?)/.exec(cls || '');
  return m ? CLASS_BASE[m[1]] * Number(m[2]) : 0;
}

/** 2.4e-5 W/m² → "M2.4". */
export function fluxToClass(flux) {
  if (!flux || flux <= 0) return 'A0.0';
  let i = Math.min(4, Math.max(0, Math.floor(Math.log10(flux)) + 8));
  if (i < 4 && flux / CLASS_BASE[LETTERS[i]] >= 9.95) i++; // 9.97 would round to "B10.0"; call it C1.0
  return `${LETTERS[i]}${(flux / CLASS_BASE[LETTERS[i]]).toFixed(1)}`;
}

/** X-ray flux on a log scale: A1 → 0, X10 → 1. */
export const intensityFor = flux => (flux > 0 ? clamp01((Math.log10(flux) + 8) / 5) : 0);

/** Solar wind 250–900 km/s → 48–112 BPM. */
export const tempoFor = speed => Math.round(48 + clamp01((speed - 250) / 650) * 64);

/** Planetary Kp 0–9 → 0–1. */
export const textureFor = kp => clamp01(kp / 9);

/** The flare class letter of the live flux picks the scale. */
export const modeFor = flux => (flux >= 1e-4 ? 'X' : flux >= 1e-5 ? 'M' : flux >= 1e-6 ? 'C' : 'B');

export const MODE_NAMES = { B: 'Major pentatonic', C: 'Lydian', M: 'Dorian', X: 'Phrygian' };

/** How hard a new flare of this class hits the music (0–1). */
export const flareStrength = cls => ({ A: 0.2, B: 0.3, C: 0.45, M: 0.75, X: 1 }[(cls || 'C')[0]] ?? 0.5);
