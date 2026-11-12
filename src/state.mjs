// Turns the cached NASA and NOAA data into the JSON the page plays: musical parameters,
// the readings behind them, and the recent event log.

import { classToFlux, fluxToClass, intensityFor, tempoFor, textureFor, modeFor, clamp01 } from '../public/mapping.js';
import { source, sourceStatus, kpReadings, usingDemoKey, last } from './sources.mjs';

const HOUR = 36e5, DAY = 864e5;
const newestFirst = time => (a, b) => (time(b) || '').localeCompare(time(a) || '');

function flares() {
  const donki = (source('donki')?.flr || []).map(f => ({
    id: f.flrID, source: 'DONKI', begin: f.beginTime, peak: f.peakTime, cls: f.classType,
    region: f.activeRegionNum, link: f.link,
  }));
  if (donki.length) return donki;
  // DONKI FLR has been unreliable; GOES event list is the same physics, straight from NOAA.
  return (source('goesFlares') || [])
    .filter(f => f.max_class && /^[CMX]/.test(f.max_class))
    .map(f => ({ id: f.begin_time, source: 'GOES', begin: f.begin_time, peak: f.max_time, cls: f.max_class }));
}

function cmes() {
  return (source('donki')?.cme || []).map(c => {
    const a = c.cmeAnalyses?.find(x => x.isMostAccurate) || c.cmeAnalyses?.[0] || {};
    const enlil = a.enlilList?.[0];
    return {
      id: c.activityID, start: c.startTime, speed: a.speed ?? null, type: a.type ?? null,
      earthBound: Boolean(enlil?.isEarthGB || enlil?.isEarthMinorImpact),
      arrival: enlil?.estimatedShockArrivalTime ?? null, note: c.note, link: c.link,
    };
  });
}

function storms() {
  return (source('donki')?.gst || []).map(g => ({
    id: g.gstID, start: g.startTime, maxKp: Math.max(0, ...(g.allKpIndex || []).map(k => k.kpIndex)), link: g.link,
  }));
}

export function buildState() {
  const now = Date.now();
  const wind = last(source('wind'));
  const kp = kpReadings();
  const flareList = flares().sort(newestFirst(f => f.peak || f.begin));
  const cmeList = cmes().sort(newestFirst(c => c.start));
  const stormList = storms().sort(newestFirst(s => s.start));

  const speed = wind?.speed ?? 400;
  const density = wind?.density ?? 5;
  const flux = last(source('xray'))?.flux ?? 1e-7;

  // Intensity: live X-ray flux, nudged up by big flares in the last 24 h.
  const biggestRecent = flareList
    .filter(f => Date.parse(f.peak || f.begin) > now - DAY)
    .reduce((max, f) => Math.max(max, classToFlux(f.cls)), 0);
  const intensity = clamp01(Math.max(intensityFor(flux), intensityFor(biggestRecent) * 0.85));

  // Texture: Kp, boosted if DONKI logged a storm in the last 3 days.
  const activeStorm = stormList.find(s => Date.parse(s.start) > now - 3 * DAY);
  const texture = clamp01(Math.max(textureFor(kp.now), activeStorm ? textureFor(activeStorm.maxKp) * 0.8 : 0));

  const incomingCME = cmeList.find(c => c.earthBound && c.arrival && Date.parse(c.arrival) > now - 12 * HOUR) || null;

  return {
    generatedAt: new Date(now).toISOString(),
    demoKey: usingDemoKey(),
    params: {
      intensity, texture,
      tempo: tempoFor(speed),
      rumble: incomingCME ? 1 : 0,
      density: clamp01(density / 20),
      mode: modeFor(flux),
    },
    readings: {
      xrayFlux: flux, xrayClass: fluxToClass(flux), windSpeed: speed, windDensity: density, kp: kp.now,
      kpForecastMax24h: Math.max(kp.now, ...kp.forecast.filter(f => Date.parse(f.time_tag + 'Z') < now + DAY).map(f => f.kp)),
    },
    events: { flares: flareList.slice(0, 12), cmes: cmeList.slice(0, 8), storms: stormList.slice(0, 6), incomingCME },
    sources: sourceStatus(),
  };
}
