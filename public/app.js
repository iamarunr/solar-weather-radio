// Solar Weather Radio — page wiring: poll the Worker, show the readings, drive the audio engine.

import { SolarEngine, loadTone } from './audio.js';
import { startVisuals } from './visuals.js';
import { initAurora } from './aurora.js';
import { fluxToClass, intensityFor, tempoFor, textureFor, modeFor, flareStrength, MODE_NAMES } from './mapping.js';
import { $, el, dayTime, weekdayTime, NEW_TAB_NOTE } from './util.js';

const POLL_MS = 60_000;
const engine = new SolarEngine();
const visuals = startVisuals({
  canvas: $('sky'), sun: $('sun'), caption: $('sun-cap'), engine,
  regions: [document.querySelector('.stage'), document.querySelector('.dock')],
});

let live = null;          // last /api/state payload
let lastPoll = 0;
let firstLoad = true;
const seenFlares = new Set();
const simOn = () => $('sim-on').checked;

// ---------- data ----------

async function poll() {
  lastPoll = Date.now();
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error(res.status);
    live = await res.json();
    onState(live);
  } catch {
    $('status').replaceChildren(el('span', 'warn', 'Station unreachable. Retrying…'));
  }
}

function onState(state) {
  // New flares → musical event (but not for the backlog on first load).
  for (const flare of state.events.flares) {
    if (seenFlares.has(flare.id)) continue;
    seenFlares.add(flare.id);
    const fresh = Date.now() - Date.parse(flare.peak || flare.begin) < 2 * 36e5;
    if (!firstLoad || fresh) triggerFlare(flareStrength(flare.cls));
  }
  firstLoad = false;
  renderLog(state.events);
  renderStatus(state);
  if (!simOn()) render(state.params, state.readings, state.events.incomingCME);
}

function triggerFlare(strength) {
  engine.flare(strength);
  visuals.flash(strength);
}

// ---------- rendering ----------

function setMeter(id, value) {
  const meter = $(id), percent = Math.round(value * 100);
  meter.firstElementChild.style.transform = `scaleX(${value})`;
  meter.setAttribute('aria-valuenow', percent);
  meter.setAttribute('aria-valuetext', `${percent}%`);
}

function render(params, readings, cme) {
  engine.apply(params);
  visuals.set({ intensity: params.intensity, wind: readings.windSpeed, density: params.density });

  const wind = Math.round(readings.windSpeed);
  const mode = MODE_NAMES[params.mode];
  $('r-xray').textContent = readings.xrayClass;
  setMeter('m-intensity', params.intensity);
  $('r-wind').textContent = `${wind} km/s`;
  $('r-bpm').textContent = `${params.tempo} bpm`;
  $('r-kp').textContent = readings.kp.toFixed(2);
  setMeter('m-texture', params.texture);
  $('h-texture').textContent = readings.kp >= 5 ? `G${Math.min(5, Math.floor(readings.kp) - 4)} storm` : 'Storm level adds hiss, crackle and grit';
  $('r-cme').textContent = cme ? `ETA ${weekdayTime(cme.arrival)}` : 'none';
  $('r-rumble').textContent = params.rumble ? 'on' : 'off';
  $('link-rumble').classList.toggle('on', Boolean(params.rumble));
  $('r-mode').textContent = mode;

  $('nowline').textContent =
    `${readings.xrayClass} X-ray flux, ${wind} km/s solar wind, Kp ${readings.kp.toFixed(1)}. ` +
    `Playing ${mode} at ${params.tempo} BPM${params.rumble ? ' with a CME inbound' : ''}.`;
}

function renderStatus(state) {
  const fetched = Object.values(state.sources).map(s => s.fetchedAt).filter(Boolean);
  const minutes = fetched.length ? Math.round((Date.now() - Math.max(...fetched)) / 60_000) : null;
  const stale = Object.entries(state.sources).filter(([, s]) => s.error).map(([name]) => name);
  const warn = (text, title) => { const node = el('span', 'warn', text); if (title) node.title = title; return node; };

  const parts = [];
  if (simOn()) parts.push(warn('SIMULATED'));
  parts.push(`updated ${minutes == null ? '—' : minutes < 1 ? 'just now' : `${minutes} min ago`}`);
  if (state.demoKey) parts.push(warn('DEMO_KEY', 'Using NASA\'s shared demo key, which is rate-limited'));
  if (stale.length) parts.push(warn(`${stale.join(', ')} stale`, 'Serving cached data'));
  $('status').replaceChildren(...parts.flatMap((part, i) => (i ? [' · ', part] : [part])));
}

const LOG_KINDS = {
  flr: { label: 'FLR', name: 'Solar flare' },
  cme: { label: 'CME', name: 'Coronal mass ejection' },
  gst: { label: 'GST', name: 'Geomagnetic storm' },
};
let logShown = null;

function renderLog({ flares, cmes, storms }) {
  const items = [
    ...flares.map(f => ({ t: f.peak || f.begin, kind: 'flr', what: `${f.cls} flare${f.region ? ` · AR ${f.region}` : ''}`, link: f.link, src: f.source })),
    ...cmes.map(c => ({ t: c.start, kind: 'cme', what: `${c.speed ? `${Math.round(c.speed)} km/s` : 'CME'}${c.earthBound ? ' · Earth-directed' : ''}`, link: c.link })),
    ...storms.map(g => ({ t: g.start, kind: 'gst', what: `Geomagnetic storm · Kp ${g.maxKp}`, link: g.link })),
  ].filter(x => x.t).sort((a, b) => b.t.localeCompare(a.t)).slice(0, 24);

  // Most polls bring nothing new. Leave the list alone then, so focus and scroll position survive.
  const signature = JSON.stringify(items);
  if (signature === logShown) return;
  logShown = signature;

  const list = $('events');
  if (!items.length) return list.replaceChildren(el('li', 'empty', 'A quiet week on the Sun.'));
  list.replaceChildren(...items.map(logEntry));
}

// These fields come from NASA and NOAA. Insert them as text, never as HTML, and only link to https.
function logEntry(item) {
  const { label, name } = LOG_KINDS[item.kind];
  const date = new Date(item.t);
  const when = isNaN(date) ? String(item.t) : dayTime(date);

  const tag = el('span', `tag ${item.kind}`);
  const abbr = el('span', null, label);
  abbr.setAttribute('aria-hidden', 'true');
  tag.append(abbr, el('span', 'sr', `${name}: `));

  const body = el('div');
  body.append(el('div', 'what', item.what), el('div', 'when', when + (item.src === 'GOES' ? ' · GOES' : '')));

  const li = el('li');
  li.append(tag);
  let href = null;
  try { const url = new URL(item.link); if (url.protocol === 'https:') href = url.href; } catch {}
  if (href) {
    const link = el('a');
    link.href = href; link.target = '_blank'; link.rel = 'noopener';
    link.append(body, el('span', 'sr', NEW_TAB_NOTE));
    li.append(link);
  } else li.append(body);
  return li;
}

// ---------- transport ----------

const play = $('play'), pause = $('pause');

// Fetch the audio library once the page is idle, or sooner if the visitor reaches for the button.
const warmUp = () => loadTone().catch(() => {});
for (const type of ['pointerenter', 'focus', 'touchstart']) play.addEventListener(type, warmUp, { once: true, passive: true });
addEventListener('load', () => (window.requestIdleCallback || (fn => setTimeout(fn, 1500)))(warmUp), { once: true });

play.addEventListener('click', async () => {
  play.disabled = true;
  play.textContent = 'Tuning in…';
  try {
    await engine.start();
  } catch {
    play.disabled = false;
    play.textContent = 'Listen live';
    $('nowline').textContent = 'The audio engine could not load. Check your connection and try again.';
    return;
  }
  document.body.classList.add('playing');
  $('transport').hidden = false;
  pause.focus();              // the play button is about to disappear; keep keyboard focus on the transport
  if (simOn()) applySim();
  else if (live) engine.apply(live.params, 0.5);
});

pause.addEventListener('click', async () => {
  const resuming = engine.paused;
  pause.textContent = resuming ? 'Pause' : 'Resume';
  document.body.classList.toggle('playing', resuming);
  if (resuming) await engine.resume();
  else engine.pause();
});

$('vol').addEventListener('input', e => {
  engine.setVolume(Number(e.target.value));
  e.target.setAttribute('aria-valuetext', `${Math.round(e.target.value * 100)}%`);
});

// ---------- simulate ----------

function applySim() {
  const flux = 10 ** Number($('s-flux').value);
  const wind = Number($('s-wind').value);
  const kp = Number($('s-kp').value);
  const cme = $('s-cme').checked;
  const cls = fluxToClass(flux);

  $('o-flux').textContent = cls;
  $('o-wind').textContent = wind;
  $('o-kp').textContent = kp.toFixed(1);
  $('s-flux').setAttribute('aria-valuetext', `class ${cls}`);
  $('s-wind').setAttribute('aria-valuetext', `${wind} km/s`);
  $('s-kp').setAttribute('aria-valuetext', kp.toFixed(1));
  if (!simOn()) return;

  const params = {
    intensity: intensityFor(flux), tempo: tempoFor(wind), texture: textureFor(kp), mode: modeFor(flux),
    rumble: cme ? 1 : 0, density: live?.params.density ?? 0.3,
  };
  render(params, { xrayClass: cls, windSpeed: wind, kp }, cme ? { arrival: Date.now() + 36 * 36e5 } : null);
  engine.apply(params, 2);
}

for (const id of ['s-flux', 's-wind', 's-kp', 's-cme']) $(id).addEventListener('input', applySim);
$('sim-on').addEventListener('change', () => {
  $('sim-controls').disabled = !simOn();
  if (simOn()) applySim(); else if (live) onState(live);
  if (live) renderStatus(live);
});
$('s-flare').addEventListener('click', () => triggerFlare(Math.max(0.4, intensityFor(10 ** Number($('s-flux').value)))));

// ---------- start ----------

$('sim-controls').disabled = !simOn();   // browsers may restore the checkbox on reload
applySim();
initAurora();
poll();
// Keep polling in a background tab only while the music is playing; otherwise catch up on return.
setInterval(() => { if (!document.hidden || engine.playing) poll(); }, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastPoll > POLL_MS) poll(); });
