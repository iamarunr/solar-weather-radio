// The "aurora tonight, where you are" panel.

import { $, el, hhmm } from './util.js';

const STORE = 'swr-loc';

// Headline verdict, plus one plain sentence saying why.
function explain(a, lat) {
  const { sky } = a;
  const cloudy = sky.clouds != null && sky.clouds >= 70 && sky.clearest.cloud >= 60;
  const pole = lat >= 0 ? 'north' : 'south';
  const awayFromPole = lat >= 0 ? 'south' : 'north';
  const best = sky.clearest ? ` The clearest sky is around ${hhmm(sky.clearest.t)}.` : '';
  const quiet = a.kpTonight < a.kpNeeded
    ? `The Sun is too quiet to push the aurora this far ${awayFromPole}. It usually takes a Kp of ${a.kpNeeded} or more here, and tonight's forecast peaks at ${a.kpTonight.toFixed(1)}.`
    : null;

  if (!sky.darkFrom) return ['The sky won\'t get dark enough tonight.', 'The Sun barely sets where you are at this time of year, so any aurora would be washed out.'];
  if (a.activity >= 20 && cloudy) return ['The aurora is active, but clouds will likely hide it.', `Cloud cover averages ${sky.clouds}% during the dark hours.${best}`];
  if (a.chance >= 50) return ['Good chance of aurora tonight.', `Get away from city lights and look ${pole}.${best}`];
  if (a.chance >= 20) return ['Aurora is possible tonight, low on the horizon.', `Find a dark spot with an open view to the ${pole}.${best}`];
  if (a.chance >= 5) return ['Aurora is unlikely tonight, but not impossible.', quiet ?? 'Activity is low right now. It\'s worth another look if the Kp index climbs.'];
  return ['No aurora expected at your location tonight.', quiet ?? (sky.clouds >= 70
    ? `Activity is low, and cloud cover averages ${sky.clouds}% during the dark hours.`
    : 'The aurora is too faint and too far away to see from here right now.')];
}

function skyStats(a) {
  const { sky } = a;
  const dark = !sky.darkFrom ? 'no'
    : sky.darkFrom - Date.now() < 6e5 ? `now – ${hhmm(sky.darkUntil)}`
    : `${hhmm(sky.darkFrom)} – ${hhmm(sky.darkUntil)}`;
  return [
    ['Aurora activity', `${a.activity}%`],
    ['Cloud cover', sky.clouds == null ? 'n/a' : `${sky.clouds}%`],
    ['Clearest hour', sky.clearest ? `${hhmm(sky.clearest.t)} · ${sky.clearest.cloud}%` : '—'],
    ['Dark', dark],
  ];
}

function say(verdict, why = '') {
  $('a-verdict').textContent = verdict;
  $('a-why').textContent = why;
}

async function load(lat, lon) {
  say('Reading the auroral oval and the clouds…');
  try {
    const res = await fetch(`/api/aurora?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`);
    const a = await res.json();
    if (a.error) throw new Error(a.error);
    try { localStorage.setItem(STORE, JSON.stringify({ lat, lon })); } catch {}

    $('a-chance').textContent = a.chance;
    say(...explain(a, lat));
    $('a-sky').replaceChildren(...skyStats(a).map(([label, value]) => {
      const row = el('div');
      row.append(el('dt', 'lbl', label), el('dd', null, value));
      return row;
    }));
    $('a-detail').textContent =
      `${lat.toFixed(1)}°, ${lon.toFixed(1)}° (mag ${a.magLat}°) · Kp now ${a.kpNow.toFixed(1)}, up to ${a.kpTonight.toFixed(1)} tonight · ` +
      `you typically need Kp ${a.kpNeeded}+ · NOAA OVATION + Open-Meteo`;
  } catch {
    say('Aurora model unavailable right now.', 'Please try again in a minute.');
  }
}

export function initAurora() {
  $('locate').addEventListener('click', () => {
    if (!navigator.geolocation) return say('Your browser can\'t share a location. Enter coordinates instead.');
    say('Locating…');
    navigator.geolocation.getCurrentPosition(
      p => load(p.coords.latitude, p.coords.longitude),
      () => say('Location blocked. Enter coordinates instead.'),
      { maximumAge: 30 * 60e3, timeout: 15e3 },
    );
  });

  $('manual').addEventListener('submit', e => {
    e.preventDefault();
    const { lat, lon } = e.target.elements;
    const la = Number(lat.value), lo = Number(lon.value);
    const ok = lat.value.trim() && lon.value.trim() && Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180;
    if (ok) load(la, lo);
    else say('Enter a latitude from −90 to 90 and a longitude from −180 to 180.');
  });

  try {
    const saved = JSON.parse(localStorage.getItem(STORE));
    if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon)) load(saved.lat, saved.lon);
  } catch {}
}
