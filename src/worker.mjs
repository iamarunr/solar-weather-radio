// Solar Weather Radio — Cloudflare Worker backend.
// Fetches NASA DONKI (flares, CMEs, geomagnetic storms) and NOAA SWPC real-time feeds on demand,
// caches them in memory per isolate (and in KV across isolates), and serves the JSON API.
// Static files in public/ are served by Workers static assets.

let NASA_KEY = 'DEMO_KEY';
let DEMO = true;

const MIN = 60_000;
const SWPC = 'https://services.swpc.noaa.gov';
const DONKI = 'https://api.nasa.gov/DONKI';

// How long each source stays fresh. DEMO_KEY allows ~10 req/hour, so DONKI is fetched gently.
const ttl = key => ({
  donki: DEMO ? 30 * MIN : 10 * MIN,
  goesFlares: 5 * MIN, xray: MIN, wind: MIN, kp: 5 * MIN, ovation: 10 * MIN,
}[key]);

/** @type {Record<string, {data:any, fetchedAt:number, lastTry?:number, error?:string}>} */
let cache = {};
let kvLoaded = false;
const inflight = new Map();

const day = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'solar-weather-radio/1.0' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = await res.json();
  if (body?.error?.code) throw new Error(body.error.code);
  return body;
}

async function refresh(key) {
  try {
    cache[key] = { data: await pollers[key](), fetchedAt: Date.now(), lastTry: Date.now() };
  } catch (err) {
    // Keep the last good data; just note the failure.
    cache[key] = { ...(cache[key] || { data: null, fetchedAt: 0 }), lastTry: Date.now(), error: String(err.message || err) };
    console.warn(`[${key}] ${err.message || err}`);
  }
}

// Make sure the given sources are loaded. Sources we already have are refreshed in the background
// (stale-while-revalidate), so only a cold start ever waits on upstream APIs.
async function ensure(keys, env, ctx) {
  NASA_KEY = env.NASA_API_KEY || 'DEMO_KEY';
  DEMO = NASA_KEY === 'DEMO_KEY';
  if (!kvLoaded) {
    kvLoaded = true;
    try {
      const saved = await env.CACHE?.get('state', 'json');
      if (saved) cache = { ...saved, ...cache };
    } catch (err) { console.warn('[kv]', err.message); }
  }
  const blocking = [];
  for (const key of keys) {
    if (Date.now() - (cache[key]?.lastTry || 0) < ttl(key)) continue;
    if (!inflight.has(key)) {
      const job = refresh(key).then(() => {
        // DONKI is rate-limited, so share it (and the rest of the small state) across isolates.
        if (key === 'donki' && env.CACHE) {
          const { ovation, ...rest } = cache;
          return env.CACHE.put('state', JSON.stringify(rest)).catch(err => console.warn('[kv]', err.message));
        }
      }).finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    if (cache[key]?.data == null) blocking.push(inflight.get(key));
    else ctx.waitUntil(inflight.get(key));
  }
  await Promise.all(blocking);
}

// ---------- pollers ----------

const pollers = {
  async donki() {
    const start = day(-7), end = day(1);
    const q = `startDate=${start}&endDate=${end}&api_key=${NASA_KEY}`;
    const [flr, cme, gst] = await Promise.allSettled([
      getJSON(`${DONKI}/FLR?${q}`),
      getJSON(`${DONKI}/CME?${q}`),
      getJSON(`${DONKI}/GST?startDate=${day(-30)}&endDate=${end}&api_key=${NASA_KEY}`),
    ]);
    const prev = cache.donki?.data || {};
    const pick = (r, k) => (r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : prev[k] || []);
    const errors = [flr, cme, gst].map((r, i) => r.status === 'rejected' ? `${['FLR', 'CME', 'GST'][i]}: ${r.reason.message}` : null).filter(Boolean);
    if (errors.length) console.warn('[donki]', errors.join('; '));
    if (errors.length === 3) throw new Error(errors[1]); // nothing new — keep last good cache
    return { flr: pick(flr, 'flr'), cme: pick(cme, 'cme'), gst: pick(gst, 'gst'), errors };
  },
  goesFlares: () => getJSON(`${SWPC}/json/goes/primary/xray-flares-7-day.json`),
  xray: async () => {
    const rows = await getJSON(`${SWPC}/json/goes/primary/xrays-6-hour.json`);
    return rows.filter(r => r.energy === '0.1-0.8nm').slice(-90).map(r => ({ t: r.time_tag, flux: r.flux }));
  },
  wind: async () => {
    const rows = await getJSON(`${SWPC}/json/rtsw/rtsw_wind_1m.json`);
    // newest first; prefer the active spacecraft
    const good = rows.filter(r => r.proton_speed != null);
    const active = good.filter(r => r.active);
    const series = (active.length ? active : good).slice(0, 120).reverse();
    return series.map(r => ({ t: r.time_tag, speed: r.proton_speed, density: r.proton_density, temp: r.proton_temperature }));
  },
  kp: async () => {
    const [obs, fc] = await Promise.all([
      getJSON(`${SWPC}/products/noaa-planetary-k-index.json`),
      getJSON(`${SWPC}/products/noaa-planetary-k-index-forecast.json`),
    ]);
    const norm = rows => Array.isArray(rows[0]) // older SWPC "products" format is array-of-arrays
      ? rows.slice(1).map(r => ({ time_tag: r[0], kp: Number(r[1]), observed: r[2] }))
      : rows.map(r => ({ time_tag: r.time_tag, kp: Number(r.kp ?? r.Kp), observed: r.observed ?? 'observed' }));
    return { observed: norm(obs).slice(-24), forecast: norm(fc).filter(r => r.observed !== 'observed') };
  },
  ovation: async () => {
    const d = await getJSON(`${SWPC}/json/ovation_aurora_latest.json`);
    // Pack into a 360x181 Uint8 grid: index = lon * 181 + (lat + 90)
    const grid = new Array(360 * 181).fill(0);
    for (const [lon, lat, p] of d.coordinates) grid[lon * 181 + (lat + 90)] = p;
    return { observed: d['Observation Time'], forecast: d['Forecast Time'], grid };
  },
};

// ---------- derived "musical" state ----------

const CLASS_BASE = { A: 1e-8, B: 1e-7, C: 1e-6, M: 1e-5, X: 1e-4 };
const classToFlux = c => {
  const m = /^([ABCMX])(\d+(?:\.\d+)?)/.exec(c || '');
  return m ? CLASS_BASE[m[1]] * Number(m[2]) : 0;
};
const fluxToClass = f => {
  if (!f || f <= 0) return 'A0.0';
  const letters = ['A', 'B', 'C', 'M', 'X'];
  let i = Math.min(4, Math.max(0, Math.floor(Math.log10(f)) + 8));
  if (i < 4 && f / CLASS_BASE[letters[i]] >= 9.95) i++; // 9.97 would round to "B10.0"; call it C1.0
  return `${letters[i]}${(f / CLASS_BASE[letters[i]]).toFixed(1)}`;
};
const clamp01 = x => Math.max(0, Math.min(1, x));
const last = a => (a?.length ? a[a.length - 1] : undefined);

function normaliseFlares() {
  const donki = (cache.donki?.data?.flr || []).map(f => ({
    id: f.flrID, source: 'DONKI', begin: f.beginTime, peak: f.peakTime, cls: f.classType,
    region: f.activeRegionNum, link: f.link,
  }));
  if (donki.length) return donki;
  // DONKI FLR has been unreliable; GOES event list is the same physics, straight from NOAA.
  return (cache.goesFlares?.data || [])
    .filter(f => f.max_class && /^[CMX]/.test(f.max_class))
    .map(f => ({ id: f.begin_time, source: 'GOES', begin: f.begin_time, peak: f.max_time, cls: f.max_class }));
}

function normaliseCMEs() {
  return (cache.donki?.data?.cme || []).map(c => {
    const a = c.cmeAnalyses?.find(x => x.isMostAccurate) || c.cmeAnalyses?.[0] || {};
    const enlil = a.enlilList?.[0];
    return {
      id: c.activityID, start: c.startTime, speed: a.speed ?? null, type: a.type ?? null,
      earthBound: Boolean(enlil?.isEarthGB || enlil?.isEarthMinorImpact),
      arrival: enlil?.estimatedShockArrivalTime ?? null, note: c.note, link: c.link,
    };
  });
}

function normaliseStorms() {
  return (cache.donki?.data?.gst || []).map(g => ({
    id: g.gstID, start: g.startTime, maxKp: Math.max(0, ...(g.allKpIndex || []).map(k => k.kpIndex)), link: g.link,
  }));
}

function buildState() {
  const wind = cache.wind?.data || [];
  const xray = cache.xray?.data || [];
  const kp = cache.kp?.data || { observed: [], forecast: [] };
  const flares = normaliseFlares().sort((a, b) => (b.peak || b.begin || '').localeCompare(a.peak || a.begin || ''));
  const cmes = normaliseCMEs().sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  const storms = normaliseStorms().sort((a, b) => b.start.localeCompare(a.start));

  const speed = last(wind)?.speed ?? 400;
  const density = last(wind)?.density ?? 5;
  const flux = last(xray)?.flux ?? 1e-7;
  const kpNow = last(kp.observed)?.kp ?? 2;

  const dayAgo = Date.now() - 864e5;
  const recentFlares = flares.filter(f => Date.parse(f.peak || f.begin) > dayAgo);
  const biggestRecent = recentFlares.reduce((m, f) => Math.max(m, classToFlux(f.cls)), 0);

  // Intensity: live X-ray flux on a log scale (A1 → 0, X10 → 1), nudged up by big flares in the last 24h.
  const liveIntensity = clamp01((Math.log10(flux) + 8) / 5);
  const recentIntensity = biggestRecent ? clamp01((Math.log10(biggestRecent) + 8) / 5) : 0;
  const intensity = clamp01(Math.max(liveIntensity, recentIntensity * 0.85));

  // Tempo: solar wind 250–900 km/s → 48–112 BPM.
  const tempo = Math.round(48 + clamp01((speed - 250) / 650) * 64);

  // Texture: Kp 0–9, boosted if DONKI logged a storm in the last 3 days.
  const activeStorm = storms.find(s => Date.parse(s.start) > Date.now() - 3 * 864e5);
  const texture = clamp01(Math.max(kpNow / 9, activeStorm ? activeStorm.maxKp / 9 * 0.8 : 0));

  const incomingCME = cmes.find(c => c.earthBound && c.arrival && Date.parse(c.arrival) > Date.now() - 12 * 36e5);

  return {
    generatedAt: new Date().toISOString(),
    demoKey: DEMO,
    params: {
      intensity, tempo, texture,
      rumble: incomingCME ? 1 : 0,
      density: clamp01(density / 20),
      mode: flux >= 1e-4 ? 'X' : flux >= 1e-5 ? 'M' : flux >= 1e-6 ? 'C' : 'B',
    },
    readings: {
      xrayFlux: flux, xrayClass: fluxToClass(flux), windSpeed: speed, windDensity: density, kp: kpNow,
      kpForecastMax24h: Math.max(kpNow, ...kp.forecast.filter(f => Date.parse(f.time_tag + 'Z') < Date.now() + 864e5).map(f => f.kp)),
    },
    series: { wind: wind.slice(-60), xray: xray.slice(-60), kp: kp.observed },
    events: { flares: flares.slice(0, 12), cmes: cmes.slice(0, 8), storms: storms.slice(0, 6), incomingCME: incomingCME || null },
    sources: Object.fromEntries(Object.entries(cache).map(([k, v]) => [k, { fetchedAt: v.fetchedAt, error: v.error || null }])),
  };
}

// ---------- aurora: "chance where you are tonight" ----------

// Centred-dipole geomagnetic latitude (north geomagnetic pole ≈ 80.8°N, 72.6°W, IGRF-14 epoch 2025).
function magLat(lat, lon) {
  const r = Math.PI / 180, pLat = 80.8 * r, pLon = -72.6 * r;
  return Math.asin(Math.sin(lat * r) * Math.sin(pLat) + Math.cos(lat * r) * Math.cos(pLat) * Math.cos(lon * r - pLon)) / r;
}

function auroraFor(lat, lon) {
  const ov = cache.ovation?.data;
  const kp = cache.kp?.data || { observed: [], forecast: [] };
  const kpNow = last(kp.observed)?.kp ?? 2;
  const tonight = kp.forecast.filter(f => {
    const t = Date.parse(f.time_tag + 'Z');
    return t > Date.now() - 3 * 36e5 && t < Date.now() + 18 * 36e5;
  });
  const kpTonight = Math.max(kpNow, ...tonight.map(f => f.kp));

  const mlat = magLat(lat, lon);
  let local = 0, nightside = 0;
  if (ov) {
    const at = (lo, la) => (la < -90 || la > 90) ? 0 : ov.grid[(((Math.round(lo) % 360) + 360) % 360) * 181 + (Math.round(la) + 90)];
    // Aurora overhead poleward of you is visible low on the horizon up to ~10° of latitude away.
    const visibleFrom = (lo, la) => {
      const pole = la >= 0 ? 1 : -1;
      let best = at(lo, la);
      for (let d = 1; d <= 10; d++) for (const dl of [-2, 0, 2]) best = Math.max(best, at(lo + dl, la + pole * d) * (1 - d / 12));
      return best;
    };
    local = visibleFrom(lon, lat);

    // OVATION is a 30–90 min nowcast, and the oval is fixed relative to the Sun. "Tonight" for you is
    // whatever the oval is doing *now* over the midnight sector, at your geomagnetic latitude.
    const utcH = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
    const midnightLon = -utcH * 15; // local solar time = UTC + lon/15
    const samples = [];
    for (let dlon = -30; dlon <= 30; dlon += 5) {
      const lo = midnightLon + dlon;
      let bestLat = 0, bestErr = Infinity;
      for (let la = -89; la <= 89; la++) {
        if (Math.sign(la) !== Math.sign(lat || 1)) continue;
        const err = Math.abs(magLat(la, lo) - mlat);
        if (err < bestErr) { bestErr = err; bestLat = la; }
      }
      samples.push(visibleFrom(lo, bestLat));
    }
    nightside = samples.reduce((a, b) => a + b, 0) / samples.length;
  }
  // Scale by how much stronger tonight's forecast Kp is than right now.
  const kpBoost = Math.min(2, Math.max(0.7, (kpTonight + 1) / (kpNow + 1)));
  const chance = Math.round(Math.min(100, Math.max(local, nightside) * kpBoost));

  // Rule of thumb: the visible equatorward edge sits near 66.5° − 2·Kp magnetic latitude.
  const kpNeeded = Math.max(0, Math.min(9, Math.ceil((66.5 - Math.abs(mlat)) / 2)));

  return {
    lat, lon, magLat: Math.round(mlat * 10) / 10, chance, local: Math.round(local), nightside: Math.round(nightside),
    kpNow, kpTonight, kpNeeded, ovationForecastTime: ov?.forecast || null,
  };
}

// ---------- sky: darkness + cloud cover (Open-Meteo, no key needed) ----------

function sunAltitude(lat, lon, date) {
  const r = Math.PI / 180;
  const doy = (Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 0)) / 864e5;
  const decl = -23.44 * Math.cos(r * (360 / 365) * (doy + 10));
  const hourAngle = (date.getUTCHours() + date.getUTCMinutes() / 60) * 15 + lon - 180;
  return Math.asin(Math.sin(lat * r) * Math.sin(decl * r) + Math.cos(lat * r) * Math.cos(decl * r) * Math.cos(hourAngle * r)) / r;
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
    const inDark = darkFrom ? hours.filter(h => h.t + 36e5 > darkFrom && h.t <= darkUntil) : [];
    if (inDark.length) {
      clouds = Math.round(inDark.reduce((s, h) => s + h.cloud, 0) / inDark.length);
      clearest = inDark.reduce((a, b) => (b.cloud < a.cloud ? b : a));
    }
  } catch (err) {
    console.warn('[clouds]', err.message);
  }
  return { darkFrom, darkUntil, clouds, clearest: clearest && { t: clearest.t, cloud: clearest.cloud } };
}

async function aurora(lat, lon) {
  const a = auroraFor(lat, lon);
  const sky = await skyFor(lat, lon);
  // Odds you'll actually *see* it: activity × clear sky (weighted toward the clearest dark hour) × darkness.
  let visible = a.chance;
  if (!sky.darkFrom) visible = 0;
  else if (sky.clouds != null) {
    const clear = 1 - (0.6 * sky.clouds + 0.4 * sky.clearest.cloud) / 100;
    visible = Math.round(a.chance * clear);
  }
  return { ...a, activity: a.chance, chance: visible, sky };
}

// ---------- live image of the Sun (NASA Solar Dynamics Observatory, AIA 171 Å) ----------

let sun = { buf: null, at: 0, captured: null };
async function sunImage() {
  if (sun.buf && Date.now() - sun.at < 15 * MIN) return sun;
  try {
    const res = await fetch('https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0171.jpg', { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${res.status}`);
    sun = { buf: await res.arrayBuffer(), at: Date.now(), captured: res.headers.get('last-modified') };
  } catch (err) {
    console.warn('[sun]', err.message);
    if (!sun.buf) return null;
  }
  return sun;
}

// ---------- http ----------

const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/state') {
        await ensure(['donki', 'goesFlares', 'xray', 'wind', 'kp'], env, ctx);
        return json(buildState());
      }
      if (url.pathname === '/api/aurora') {
        const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
        if (!url.searchParams.get('lat') || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ error: 'lat/lon required' }, 400);
        await ensure(['kp', 'ovation'], env, ctx);
        return json(await aurora(lat, lon));
      }
      if (url.pathname === '/api/sun.jpg') {
        const img = await sunImage();
        if (!img) return new Response('sun image unavailable', { status: 502 });
        return new Response(img.buf, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=300', 'x-captured': img.captured || '' } });
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ error: 'internal' }, 500);
    }
  },
};
