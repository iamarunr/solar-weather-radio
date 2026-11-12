// "Chance of aurora where you are tonight": NOAA's OVATION model for activity, then darkness
// (computed here) and cloud cover (Open-Meteo, no key needed) for whether you could see it.

import { MIN, getJSON, source, kpReadings } from './sources.mjs';

const RAD = Math.PI / 180;
const HOUR = 36e5;

// Centred-dipole geomagnetic latitude (north geomagnetic pole ≈ 80.8°N, 72.6°W, IGRF-14 epoch 2025).
function magLat(lat, lon) {
  const pLat = 80.8 * RAD, pLon = -72.6 * RAD;
  return Math.asin(Math.sin(lat * RAD) * Math.sin(pLat) + Math.cos(lat * RAD) * Math.cos(pLat) * Math.cos(lon * RAD - pLon)) / RAD;
}

// Probability the OVATION grid gives for a point, counting aurora poleward of it: overhead
// aurora is visible low on the horizon from up to ~10° of latitude away.
function visibleFrom(grid, lon, lat) {
  const at = (lo, la) => (la < -90 || la > 90) ? 0 : grid[(((Math.round(lo) % 360) + 360) % 360) * 181 + (Math.round(la) + 90)];
  const pole = lat >= 0 ? 1 : -1;
  let best = at(lon, lat);
  for (let d = 1; d <= 10; d++) for (const dl of [-2, 0, 2]) best = Math.max(best, at(lon + dl, lat + pole * d) * (1 - d / 12));
  return best;
}

// OVATION is a 30–90 min nowcast, and the oval is fixed relative to the Sun. "Tonight" for you is
// whatever the oval is doing *now* over the midnight sector, at your geomagnetic latitude.
function nightsideActivity(grid, lat, mlat) {
  const now = new Date();
  const midnightLon = -(now.getUTCHours() + now.getUTCMinutes() / 60) * 15; // local solar time = UTC + lon/15
  const hemisphere = Math.sign(lat || 1);
  let sum = 0, n = 0;
  for (let dlon = -30; dlon <= 30; dlon += 5) {
    const lon = midnightLon + dlon;
    let bestLat = 0, bestErr = Infinity;
    for (let la = 1; la <= 89; la++) {
      const err = Math.abs(magLat(la * hemisphere, lon) - mlat);
      if (err < bestErr) { bestErr = err; bestLat = la * hemisphere; }
    }
    sum += visibleFrom(grid, lon, bestLat);
    n++;
  }
  return sum / n;
}

function activityFor(lat, lon) {
  const ovation = source('ovation');
  const kp = kpReadings();
  const now = Date.now();
  const kpTonight = Math.max(kp.now, ...kp.forecast
    .filter(f => { const t = Date.parse(f.time_tag + 'Z'); return t > now - 3 * HOUR && t < now + 18 * HOUR; })
    .map(f => f.kp));

  const mlat = magLat(lat, lon);
  const local = ovation ? visibleFrom(ovation.grid, lon, lat) : 0;
  const nightside = ovation ? nightsideActivity(ovation.grid, lat, mlat) : 0;

  // Scale by how much stronger tonight's forecast Kp is than right now.
  const kpBoost = Math.min(2, Math.max(0.7, (kpTonight + 1) / (kp.now + 1)));
  const activity = Math.round(Math.min(100, Math.max(local, nightside) * kpBoost));

  // Rule of thumb: the visible equatorward edge sits near 66.5° − 2·Kp magnetic latitude.
  const kpNeeded = Math.max(0, Math.min(9, Math.ceil((66.5 - Math.abs(mlat)) / 2)));

  return {
    lat, lon, magLat: Math.round(mlat * 10) / 10, activity, local: Math.round(local), nightside: Math.round(nightside),
    kpNow: kp.now, kpTonight, kpNeeded, ovationForecastTime: ovation?.forecast || null,
  };
}

// ---------- sky: darkness + cloud cover ----------

function sunAltitude(lat, lon, date) {
  const doy = (Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 0)) / 864e5;
  const decl = -23.44 * Math.cos(RAD * (360 / 365) * (doy + 10));
  const hourAngle = (date.getUTCHours() + date.getUTCMinutes() / 60) * 15 + lon - 180;
  return Math.asin(Math.sin(lat * RAD) * Math.sin(decl * RAD) + Math.cos(lat * RAD) * Math.cos(decl * RAD) * Math.cos(hourAngle * RAD)) / RAD;
}

const cloudCache = new Map(); // "lat,lon" (0.1° grid) → { at, hours: [{t, cloud}] }

async function cloudHours(lat, lon) {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  const hit = cloudCache.get(key);
  if (hit && Date.now() - hit.at < 30 * MIN) return hit.hours;
  const [la, lo] = key.split(',');
  const d = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&hourly=cloud_cover&forecast_hours=24&timezone=GMT`);
  const hours = d.hourly.time.map((t, i) => ({ t: Date.parse(t + 'Z'), cloud: d.hourly.cloud_cover[i] }));
  if (cloudCache.size > 500) cloudCache.delete(cloudCache.keys().next().value);
  cloudCache.set(key, { at: Date.now(), hours });
  return hours;
}

async function skyFor(lat, lon) {
  // Tonight = the next 18 h. Prefer astronomical-ish darkness (sun < −12°), fall back to civil (< −6°).
  const now = Date.now(), slots = [];
  for (let m = 0; m < 18 * 60; m += 10) slots.push(new Date(now + m * 6e4));
  let dark = slots.filter(d => sunAltitude(lat, lon, d) < -12);
  if (!dark.length) dark = slots.filter(d => sunAltitude(lat, lon, d) < -6);
  const darkFrom = dark[0]?.getTime() ?? null;
  const darkUntil = dark.length ? dark[dark.length - 1].getTime() : null;

  let clouds = null, clearest = null;
  try {
    const hours = await cloudHours(lat, lon);
    const inDark = darkFrom ? hours.filter(h => h.t + HOUR > darkFrom && h.t <= darkUntil) : [];
    if (inDark.length) {
      clouds = Math.round(inDark.reduce((s, h) => s + h.cloud, 0) / inDark.length);
      clearest = inDark.reduce((a, b) => (b.cloud < a.cloud ? b : a));
    }
  } catch (err) {
    console.warn('[clouds]', err.message);
  }
  return { darkFrom, darkUntil, clouds, clearest: clearest && { t: clearest.t, cloud: clearest.cloud } };
}

export async function aurora(lat, lon) {
  const a = activityFor(lat, lon);
  const sky = await skyFor(lat, lon);
  // Odds you'll actually *see* it: activity × clear sky (weighted toward the clearest dark hour) × darkness.
  let chance = a.activity;
  if (!sky.darkFrom) chance = 0;
  else if (sky.clouds != null) {
    const clear = 1 - (0.6 * sky.clouds + 0.4 * sky.clearest.cloud) / 100;
    chance = Math.round(a.activity * clear);
  }
  return { ...a, chance, sky };
}
