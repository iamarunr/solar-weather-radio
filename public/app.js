import { SolarEngine } from './audio.js';

const $ = id => document.getElementById(id);
const engine = new SolarEngine();
const MODE_NAMES = { B: 'Major pentatonic', C: 'Lydian', M: 'Dorian', X: 'Phrygian' };

let live = null;          // last /api/state payload
const seenFlares = new Set();
let firstLoad = true;
const vis = { intensity: 0.2, texture: 0.2, wind: 400, density: 0.3, rumble: 0, flash: 0 };

// ---------- data ----------

async function poll() {
  try {
    const res = await fetch('/api/state');
    live = await res.json();
    onState(live);
  } catch (err) {
    $('status').innerHTML = '<span class="warn">backend unreachable</span>';
  }
}

function onState(s) {
  // New flares → musical event (but not for the backlog on first load).
  for (const f of s.events.flares) {
    if (!seenFlares.has(f.id)) {
      seenFlares.add(f.id);
      const fresh = Date.now() - Date.parse(f.peak || f.begin) < 2 * 36e5;
      if (!firstLoad || fresh) triggerFlare(classStrength(f.cls));
    }
  }
  firstLoad = false;
  renderLog(s.events);
  renderStatus(s);
  if (!simOn()) render(s.params, s.readings, s.events.incomingCME);
}

function classStrength(cls) {
  const L = (cls || 'C')[0];
  return { A: 0.2, B: 0.3, C: 0.45, M: 0.75, X: 1 }[L] ?? 0.5;
}

// ---------- rendering ----------

const fmtClass = flux => {
  const letters = ['A', 'B', 'C', 'M', 'X'];
  let i = Math.min(4, Math.max(0, Math.floor(Math.log10(flux)) + 8));
  if (i < 4 && flux / 10 ** (i - 8) >= 9.95) i++;
  return `${letters[i]}${(flux / 10 ** (i - 8)).toFixed(1)}`;
};

function render(params, readings, cme) {
  engine.apply(params);
  Object.assign(vis, { intensity: params.intensity, texture: params.texture, wind: readings.windSpeed, density: params.density, rumble: params.rumble });
  
  $('r-xray').textContent = readings.xrayClass;
  $('m-intensity').style.width = `${Math.round(params.intensity * 100)}%`;
  $('r-wind').textContent = `${Math.round(readings.windSpeed)} km/s`;
  $('r-bpm').textContent = `${params.tempo} bpm`;
  $('r-kp').textContent = readings.kp.toFixed(2);
  $('m-texture').style.width = `${Math.round(params.texture * 100)}%`;
  $('h-texture').textContent = readings.kp >= 5 ? `G${Math.min(5, Math.floor(readings.kp) - 4)} storm` : 'Storm level adds hiss, crackle and grit';
  $('r-cme').textContent = cme ? `ETA ${new Date(cme.arrival).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'none';
  $('r-rumble').textContent = params.rumble ? 'on' : 'off';
  document.querySelector('[data-k="rumble"]').classList.toggle('on', !!params.rumble);
  $('r-mode').textContent = MODE_NAMES[params.mode];

  $('nowline').textContent =
    `${readings.xrayClass} X-ray flux, ${Math.round(readings.windSpeed)} km/s solar wind, Kp ${readings.kp.toFixed(1)}. ` +
    `Playing ${MODE_NAMES[params.mode]} at ${params.tempo} BPM${params.rumble ? ' with a CME inbound' : ''}.`;
}

function renderStatus(s) {
  const ages = Object.values(s.sources).map(x => x.fetchedAt).filter(Boolean);
  const newest = ages.length ? Math.max(...ages) : 0;
  const ago = newest ? Math.round((Date.now() - newest) / 60000) : null;
  const errs = Object.entries(s.sources).filter(([, v]) => v.error).map(([k]) => k);
  $('status').innerHTML =
    `${simOn() ? '<span class="warn">SIMULATED</span> · ' : ''}updated ${ago == null ? '—' : ago < 1 ? 'just now' : ago + ' min ago'}` +
    (s.demoKey ? ' · <span class="warn" title="Set NASA_API_KEY in .env">DEMO_KEY</span>' : '') +
    (errs.length ? ` · <span class="warn" title="Serving cached data">${errs.join(', ')} stale</span>` : '');
}

function renderLog({ flares, cmes, storms }) {
  const items = [
    ...flares.map(f => ({ t: f.peak || f.begin, tag: 'flr', label: 'FLR', what: `${f.cls} flare${f.region ? ` · AR ${f.region}` : ''}`, link: f.link, src: f.source })),
    ...cmes.map(c => ({ t: c.start, tag: 'cme', label: 'CME', what: `${c.speed ? Math.round(c.speed) + ' km/s' : 'CME'}${c.earthBound ? ' · Earth-directed' : ''}`, link: c.link })),
    ...storms.map(g => ({ t: g.start, tag: 'gst', label: 'GST', what: `Geomagnetic storm · Kp ${g.maxKp}`, link: g.link })),
  ].filter(x => x.t).sort((a, b) => b.t.localeCompare(a.t)).slice(0, 24);

  const ol = $('events');
  if (!items.length) { ol.innerHTML = '<li class="empty">A quiet week on the Sun.</li>'; return; }
  // These fields come from NASA and NOAA. Insert them as text, never as HTML, and only link to https.
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  ol.replaceChildren(...items.map(x => {
    const li = el('li');
    const date = new Date(x.t);
    const when = isNaN(date) ? String(x.t) : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const body = el('div');
    body.append(el('div', 'what', x.what), el('div', 'when', when + (x.src === 'GOES' ? ' · GOES' : '')));
    li.append(el('span', `tag ${x.tag}`, x.label));
    let href = null;
    try { const u = new URL(x.link); if (u.protocol === 'https:') href = u.href; } catch {}
    if (href) {
      const link = el('a');
      link.href = href; link.target = '_blank'; link.rel = 'noopener';
      link.append(body);
      li.append(link);
    } else li.append(body);
    return li;
  }));
}

// ---------- flare ----------

function triggerFlare(strength) {
  engine.flare(strength);
  vis.flash = Math.max(vis.flash, strength);
}

// ---------- transport ----------

$('play').addEventListener('click', async () => {
  await engine.start();
  document.body.classList.add('playing');
  $('transport').hidden = false;
  if (live && !simOn()) engine.apply(live.params, 0.5);
  else if (simOn()) applySim();
});
$('pause').addEventListener('click', async e => {
  if (engine.paused) { await engine.resume(); e.target.textContent = 'Pause'; document.body.classList.add('playing'); }
  else { e.target.textContent = 'Resume'; document.body.classList.remove('playing'); await engine.stop(); }
});
$('vol').addEventListener('input', e => engine.setVolume(Number(e.target.value)));

// ---------- simulate ----------

const simOn = () => $('sim-on').checked;
function applySim() {
  const flux = 10 ** Number($('s-flux').value);
  const wind = Number($('s-wind').value);
  const kp = Number($('s-kp').value);
  const cme = $('s-cme').checked;
  $('o-flux').textContent = fmtClass(flux);
  $('o-wind').textContent = wind;
  $('o-kp').textContent = kp.toFixed(1);
  if (!simOn()) return;
  const params = {
    intensity: Math.max(0, Math.min(1, (Math.log10(flux) + 8) / 5)),
    tempo: Math.round(48 + Math.max(0, Math.min(1, (wind - 250) / 650)) * 64),
    texture: kp / 9, rumble: cme ? 1 : 0, density: live?.params.density ?? 0.3,
    mode: flux >= 1e-4 ? 'X' : flux >= 1e-5 ? 'M' : flux >= 1e-6 ? 'C' : 'B',
  };
  render(params, { xrayClass: fmtClass(flux), windSpeed: wind, kp }, cme ? { arrival: Date.now() + 36 * 36e5 } : null);
  engine.apply(params, 2);
}
for (const id of ['s-flux', 's-wind', 's-kp', 's-cme']) $(id).addEventListener('input', applySim);
$('sim-on').addEventListener('change', () => {
  $('sim-on').closest('.sim').classList.toggle('on', simOn());
  if (simOn()) applySim(); else if (live) onState(live);
  if (live) renderStatus(live);
});
$('s-flare').addEventListener('click', () => triggerFlare(Math.max(0.4, (Number($('s-flux').value) + 8) / 5)));
applySim();

// ---------- aurora ----------

const hhmm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function loadAurora(lat, lon) {
  $('a-verdict').textContent = 'Reading the auroral oval and the clouds…';
  $('a-why').textContent = '';
  try {
    const a = await (await fetch(`/api/aurora?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`)).json();
    if (a.error) throw new Error(a.error);
    localStorage.setItem('swr-loc', JSON.stringify({ lat, lon }));
    const { sky } = a;
    $('aurora').style.setProperty('--chance', a.chance);
    $('a-chance').textContent = a.chance;

    // Headline verdict, plus one plain sentence saying why.
    const cloudy = sky.clouds != null && sky.clouds >= 70 && sky.clearest.cloud >= 60;
    const toward = lat >= 0 ? 'south' : 'north';           // direction away from the pole
    const pole = lat >= 0 ? 'north' : 'south';
    const kpGap = a.kpTonight < a.kpNeeded;
    const quiet = `The Sun is too quiet to push the aurora this far ${toward}. It usually takes a Kp of ${a.kpNeeded} or more here, and tonight's forecast peaks at ${a.kpTonight.toFixed(1)}.`;
    const best = sky.clearest ? ` The clearest sky is around ${hhmm(sky.clearest.t)}.` : '';
    const [verdict, why] =
      !sky.darkFrom ? ['The sky won\'t get dark enough tonight.', 'The Sun barely sets where you are at this time of year, so any aurora would be washed out.'] :
      a.activity >= 20 && cloudy ? ['The aurora is active, but clouds will likely hide it.', `Cloud cover averages ${sky.clouds}% during the dark hours.${best}`] :
      a.chance >= 50 ? ['Good chance of aurora tonight.', `Get away from city lights and look ${pole}.${best}`] :
      a.chance >= 20 ? ['Aurora is possible tonight, low on the horizon.', `Find a dark spot with an open view to the ${pole}.${best}`] :
      a.chance >= 5 ? ['Aurora is unlikely tonight, but not impossible.', kpGap ? quiet : `Activity is low right now. It's worth another look if the Kp index climbs.`] :
      ['No aurora expected at your location tonight.', kpGap ? quiet : (sky.clouds >= 70 ? `Activity is low, and cloud cover averages ${sky.clouds}% during the dark hours.` : 'The aurora is too faint and too far away to see from here right now.')];
    $('a-verdict').textContent = verdict;
    $('a-why').textContent = why;

    const stats = [
      ['Aurora activity', `${a.activity}%`],
      ['Cloud cover', sky.clouds == null ? 'n/a' : `${sky.clouds}%`],
      ['Clearest hour', sky.clearest ? `${hhmm(sky.clearest.t)} · ${sky.clearest.cloud}%` : '—'],
      ['Dark', sky.darkFrom ? (sky.darkFrom - Date.now() < 6e5 ? `now – ${hhmm(sky.darkUntil)}` : `${hhmm(sky.darkFrom)} – ${hhmm(sky.darkUntil)}`) : 'no'],
    ];
    $('a-sky').replaceChildren(...stats.map(([k, v]) => {
      const d = document.createElement('div');
      d.innerHTML = `<span class="lbl"></span><b></b>`;
      d.firstChild.textContent = k; d.lastChild.textContent = v;
      return d;
    }));

    $('a-detail').textContent =
      `${lat.toFixed(1)}°, ${lon.toFixed(1)}° (mag ${a.magLat}°) · Kp now ${a.kpNow.toFixed(1)}, up to ${a.kpTonight.toFixed(1)} tonight · ` +
      `you typically need Kp ${a.kpNeeded}+ · NOAA OVATION + Open-Meteo`;
    vis.auroraChance = a.chance / 100;
  } catch (err) {
    $('a-verdict').textContent = 'Aurora model unavailable right now.';
  }
}

$('locate').addEventListener('click', () => {
  if (!navigator.geolocation) return ($('a-verdict').textContent = 'Geolocation unavailable. Enter coordinates.');
  $('a-verdict').textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    p => loadAurora(p.coords.latitude, p.coords.longitude),
    () => ($('a-verdict').textContent = 'Location blocked. Enter coordinates instead.'),
    { maximumAge: 30 * 60e3, timeout: 15e3 },
  );
});
$('manual').addEventListener('submit', e => {
  e.preventDefault();
  const lat = Number(e.target.lat.value), lon = Number(e.target.lon.value);
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) loadAurora(lat, lon);
  else $('a-verdict').textContent = 'Latitude −90…90, longitude −180…180.';
});
try {
  const saved = JSON.parse(localStorage.getItem('swr-loc'));
  if (saved) loadAurora(saved.lat, saved.lon);
} catch {}

// ---------- visuals ----------
// A live NASA SDO image of the Sun, ringed by an instrument-style reticle and the audio waveform.

const cv = $('sky');
const ctx = cv.getContext('2d');
let W, H, DPR;
const stars = Array.from({ length: 140 }, () => ({ x: Math.random(), y: Math.random(), a: 0.08 + Math.random() * 0.3 }));
const particles = [];
function resize() {
  DPR = Math.min(2, devicePixelRatio || 1);
  W = cv.width = innerWidth * DPR; H = cv.height = innerHeight * DPR;
}
addEventListener('resize', resize); resize();

const lerp = (a, b, t) => a + (b - a) * t;
const sm = { intensity: 0.2, texture: 0.2, wind: 400 };
let noteKick = 0;
engine.on((type, d) => { if (type === 'note') noteKick = Math.min(1, noteKick + d.vel * 0.6); });

// The SDO frame is 1024² with the solar disc ≈ 39% of the width in radius. Mask it to a soft circle
// so the black frame and the timestamp in the corner disappear.
const DISC = 0.39, CROP = 0.49;
let sunTex = null;
async function loadSun() {
  try {
    const res = await fetch('/api/sun.jpg');
    if (!res.ok) throw new Error(res.status);
    const captured = res.headers.get('x-captured');
    const bmp = await createImageBitmap(await res.blob());
    const off = document.createElement('canvas');
    off.width = off.height = 1024;
    const o = off.getContext('2d');
    o.drawImage(bmp, 0, 0, 1024, 1024);
    o.globalCompositeOperation = 'destination-in';
    const g = o.createRadialGradient(512, 512, 1024 * (DISC + 0.03), 512, 512, 1024 * CROP);
    g.addColorStop(0, '#000'); g.addColorStop(1, 'rgba(0,0,0,0)');
    o.fillStyle = g; o.fillRect(0, 0, 1024, 1024);
    sunTex = off;
    if (captured) $('sun-cap').textContent = `NASA SDO · AIA 171 Å · ${new Date(captured).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  } catch {
    $('sun-cap').textContent = 'Solar image unavailable';
  }
}
loadSun();
setInterval(loadSun, 15 * 60_000);

function frame() {
  sm.intensity = lerp(sm.intensity, vis.intensity, 0.02);
  sm.texture = lerp(sm.texture, vis.texture, 0.02);
  sm.wind = lerp(sm.wind, vis.wind, 0.02);
  vis.flash *= 0.985; noteKick *= 0.92;
  const I = sm.intensity;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#fff';
  for (const st of stars) { ctx.globalAlpha = st.a; ctx.fillRect(st.x * W, st.y * H, DPR, DPR); }
  ctx.globalAlpha = 1;

  const box = $('sun').getBoundingClientRect();
  const cx = (box.left + box.width / 2) * DPR, cy = (box.top + box.height / 2) * DPR;
  const half = (box.width / 2) * DPR;            // half of the image frame
  const R = half * (DISC / 0.5);                 // solar limb
  const ring = half * 0.94;                      // reticle radius

  // solar wind: sparse 1px particles streaming outward
  if (Math.random() < 0.35 + vis.density * 0.5) {
    particles.push({ a: Math.random() * Math.PI * 2, d: ring, v: (sm.wind / 400) * (0.5 + Math.random() * 0.6) * DPR, life: 1 });
  }
  ctx.fillStyle = '#fff';
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.d += p.v * 1.6; p.life -= 0.0035;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    ctx.globalAlpha = p.life * 0.35;
    ctx.fillRect(cx + Math.cos(p.a) * p.d, cy + Math.sin(p.a) * p.d, DPR, DPR);
  }
  ctx.globalAlpha = 1;

  // the Sun
  if (sunTex) {
    const s = half * 2 * (1 + noteKick * 0.004);
    ctx.globalAlpha = Math.min(1, 0.82 + I * 0.18 + vis.flash * 0.2);
    ctx.drawImage(sunTex, cx - s / 2, cy - s / 2, s, s);
    ctx.globalAlpha = 1;
  } else {
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = DPR;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  }

  // reticle: hairline ring with ticks every 10°
  ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = DPR;
  ctx.beginPath(); ctx.arc(cx, cy, ring, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  for (let d = 0; d < 360; d += 10) {
    const a = d * Math.PI / 180, len = (d % 90 === 0 ? 10 : 4) * DPR;
    ctx.moveTo(cx + Math.cos(a) * ring, cy + Math.sin(a) * ring);
    ctx.lineTo(cx + Math.cos(a) * (ring + len), cy + Math.sin(a) * (ring + len));
  }
  ctx.stroke();

  // the audio waveform, wrapped around the reticle
  const wave = engine.analyser && !engine.paused ? engine.analyser.getValue() : null;
  if (wave) {
    const n = 256, amp = half * (0.4 + I * 0.4);
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = DPR;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      // fade the ends together so the loop closes cleanly
      const edge = Math.min(1, Math.min(i, n - i) / 16);
      const r = ring + wave[i % n] * amp * edge;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }

  // flare: a single thin shock ring
  if (vis.flash > 0.01) {
    const f = vis.flash;
    ctx.strokeStyle = `rgba(252,61,33,${f * 0.9})`; ctx.lineWidth = DPR;
    ctx.beginPath(); ctx.arc(cx, cy, lerp(R, ring, Math.min(1, (1 - f) * 1.6)), 0, Math.PI * 2); ctx.stroke(); // limb → reticle
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

poll();
setInterval(poll, 60_000);
