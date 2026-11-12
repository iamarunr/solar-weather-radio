// The latest image of the Sun from NASA's Solar Dynamics Observatory (AIA 171 Å), kept for 15 min.

import { MIN } from './sources.mjs';

const LATEST = 'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0171.jpg';
let sun = { buf: null, at: 0, captured: null };

/** Returns { buf, captured } or null if the image has never loaded. A failed refresh keeps the old one. */
export async function sunImage() {
  if (sun.buf && Date.now() - sun.at < 15 * MIN) return sun;
  try {
    const res = await fetch(LATEST, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${res.status}`);
    sun = { buf: await res.arrayBuffer(), at: Date.now(), captured: res.headers.get('last-modified') };
  } catch (err) {
    console.warn('[sun]', err.message);
    if (!sun.buf) return null;
  }
  return sun;
}
