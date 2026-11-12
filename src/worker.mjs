// Solar Weather Radio — Cloudflare Worker backend.
// Serves the JSON API; static files in public/ are served by Workers static assets.
//   sources.mjs  fetching and caching NASA DONKI and NOAA SWPC
//   state.mjs    readings → musical parameters and the event log
//   aurora.mjs   aurora odds for a location
//   sun.mjs      the latest image of the Sun

import { ensure } from './sources.mjs';
import { buildState } from './state.mjs';
import { aurora } from './aurora.mjs';
import { sunImage } from './sun.mjs';

const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

const routes = {
  async '/api/state'(url, env, ctx) {
    await ensure(['donki', 'goesFlares', 'xray', 'wind', 'kp'], env, ctx);
    return json(buildState());
  },

  async '/api/aurora'(url, env, ctx) {
    const q = url.searchParams;
    const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
    const valid = q.get('lat') && q.get('lon') && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    if (!valid) return json({ error: 'lat/lon required' }, 400);
    await ensure(['kp', 'ovation'], env, ctx);
    return json(await aurora(lat, lon));
  },

  async '/api/sun.jpg'() {
    const img = await sunImage();
    if (!img) return new Response('sun image unavailable', { status: 502 });
    return new Response(img.buf, {
      headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=300', 'x-captured': img.captured || '' },
    });
  },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const route = routes[url.pathname];
    if (!route) return env.ASSETS.fetch(request);
    try {
      return await route(url, env, ctx);
    } catch (err) {
      console.error(err);
      return json({ error: 'internal' }, 500);
    }
  },
};
