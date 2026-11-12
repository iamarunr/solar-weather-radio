// Upstream data: NASA DONKI and NOAA SWPC, fetched on demand and cached in memory per isolate
// (and in KV across isolates).

export const MIN = 60_000;
const SWPC = 'https://services.swpc.noaa.gov';
const DONKI = 'https://api.nasa.gov/DONKI';

let nasaKey = 'DEMO_KEY';
export const usingDemoKey = () => nasaKey === 'DEMO_KEY';

// How long each source stays fresh. DEMO_KEY allows ~10 req/hour, so DONKI is fetched gently.
const ttl = key => ({
  donki: usingDemoKey() ? 30 * MIN : 10 * MIN,
  goesFlares: 5 * MIN, xray: MIN, wind: MIN, kp: 5 * MIN, ovation: 10 * MIN,
}[key]);

/** @type {Record<string, {data:any, fetchedAt:number, lastTry?:number, error?:string}>} */
let cache = {};
let kvLoaded = false;
const inflight = new Map();

export const last = a => (a?.length ? a[a.length - 1] : undefined);

/** The latest data for a source, or undefined if it has never loaded. */
export const source = key => cache[key]?.data;

/** When each source was last fetched, and whether its latest attempt failed. */
export const sourceStatus = () =>
  Object.fromEntries(Object.entries(cache).map(([k, v]) => [k, { fetchedAt: v.fetchedAt, error: v.error || null }]));

/** Observed and forecast Kp, plus the current value (2 until the first reading arrives). */
export function kpReadings() {
  const kp = source('kp') || { observed: [], forecast: [] };
  return { ...kp, now: last(kp.observed)?.kp ?? 2 };
}

export async function getJSON(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'solar-weather-radio/1.0' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = await res.json();
  if (body?.error?.code) throw new Error(body.error.code);
  return body;
}

const day = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

const pollers = {
  async donki() {
    const end = day(1);
    const week = `startDate=${day(-7)}&endDate=${end}&api_key=${nasaKey}`;
    const month = `startDate=${day(-30)}&endDate=${end}&api_key=${nasaKey}`;
    const names = ['FLR', 'CME', 'GST'];
    const [flr, cme, gst] = await Promise.allSettled([
      getJSON(`${DONKI}/FLR?${week}`),
      getJSON(`${DONKI}/CME?${week}`),
      getJSON(`${DONKI}/GST?${month}`),
    ]);
    const prev = source('donki') || {};
    const pick = (r, k) => (r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : prev[k] || []);
    const errors = [flr, cme, gst].flatMap((r, i) => (r.status === 'rejected' ? [`${names[i]}: ${r.reason.message}`] : []));
    if (errors.length) console.warn('[donki]', errors.join('; '));
    if (errors.length === names.length) throw new Error(errors[1]); // nothing new — keep last good cache
    return { flr: pick(flr, 'flr'), cme: pick(cme, 'cme'), gst: pick(gst, 'gst'), errors };
  },

  goesFlares: () => getJSON(`${SWPC}/json/goes/primary/xray-flares-7-day.json`),

  async xray() {
    const rows = await getJSON(`${SWPC}/json/goes/primary/xrays-6-hour.json`);
    return rows.filter(r => r.energy === '0.1-0.8nm').slice(-90).map(r => ({ t: r.time_tag, flux: r.flux }));
  },

  async wind() {
    const rows = await getJSON(`${SWPC}/json/rtsw/rtsw_wind_1m.json`);
    // newest first; prefer the active spacecraft
    const good = rows.filter(r => r.proton_speed != null);
    const active = good.filter(r => r.active);
    const series = (active.length ? active : good).slice(0, 120).reverse();
    return series.map(r => ({ t: r.time_tag, speed: r.proton_speed, density: r.proton_density, temp: r.proton_temperature }));
  },

  async kp() {
    const [obs, fc] = await Promise.all([
      getJSON(`${SWPC}/products/noaa-planetary-k-index.json`),
      getJSON(`${SWPC}/products/noaa-planetary-k-index-forecast.json`),
    ]);
    const norm = rows => Array.isArray(rows[0]) // older SWPC "products" format is array-of-arrays
      ? rows.slice(1).map(r => ({ time_tag: r[0], kp: Number(r[1]), observed: r[2] }))
      : rows.map(r => ({ time_tag: r.time_tag, kp: Number(r.kp ?? r.Kp), observed: r.observed ?? 'observed' }));
    return { observed: norm(obs).slice(-24), forecast: norm(fc).filter(r => r.observed !== 'observed') };
  },

  async ovation() {
    const d = await getJSON(`${SWPC}/json/ovation_aurora_latest.json`);
    // Pack into a 360x181 grid: index = lon * 181 + (lat + 90)
    const grid = new Uint8Array(360 * 181);
    for (const [lon, lat, p] of d.coordinates) grid[lon * 181 + (lat + 90)] = p;
    return { observed: d['Observation Time'], forecast: d['Forecast Time'], grid };
  },
};

async function refresh(key) {
  try {
    cache[key] = { data: await pollers[key](), fetchedAt: Date.now(), lastTry: Date.now() };
  } catch (err) {
    // Keep the last good data; just note the failure.
    cache[key] = { ...(cache[key] || { data: null, fetchedAt: 0 }), lastTry: Date.now(), error: String(err.message || err) };
    console.warn(`[${key}] ${err.message || err}`);
  }
}

async function loadFromKV(env) {
  try {
    const saved = await env.CACHE?.get('state', 'json');
    if (saved) cache = { ...saved, ...cache };
  } catch (err) { console.warn('[kv]', err.message); }
}

// DONKI is rate-limited, so share it (and the rest of the small state) across isolates.
function saveToKV(env) {
  if (!env.CACHE) return;
  const { ovation, ...rest } = cache;
  return env.CACHE.put('state', JSON.stringify(rest)).catch(err => console.warn('[kv]', err.message));
}

// Make sure the given sources are loaded. Slightly stale sources are refreshed in the background
// (stale-while-revalidate). A request only waits on upstream APIs when a source is missing, or
// (for up to OVERDUE_WAIT) when it is more than three times past its shelf life.
const OVERDUE_WAIT = 2500;

export async function ensure(keys, env, ctx) {
  nasaKey = env.NASA_API_KEY || 'DEMO_KEY';
  if (!kvLoaded) {
    kvLoaded = true;
    await loadFromKV(env);
  }
  const blocking = [], overdue = [];
  for (const key of keys) {
    if (Date.now() - (cache[key]?.lastTry || 0) < ttl(key)) continue;
    if (!inflight.has(key)) {
      inflight.set(key, refresh(key)
        .then(() => (key === 'donki' ? saveToKV(env) : undefined))
        .finally(() => inflight.delete(key)));
    }
    const job = inflight.get(key);
    ctx.waitUntil(job);
    if (cache[key]?.data == null) blocking.push(job);
    // An isolate that sat idle (or just loaded an old copy from KV) holds data well past its
    // shelf life. Give the refresh a moment to land instead of showing a visitor old readings.
    else if (Date.now() - cache[key].fetchedAt > 3 * ttl(key)) overdue.push(job);
  }
  await Promise.all(blocking);
  if (overdue.length) {
    await Promise.race([Promise.all(overdue), new Promise(r => setTimeout(r, OVERDUE_WAIT))]);
  }
}
