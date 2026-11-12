// The backdrop: a live NASA SDO image of the Sun, ringed by an instrument-style reticle and the
// audio waveform, with a sparse solar wind streaming outward.

import { dayTime } from './util.js';

// The SDO frame is 1024² with the solar disc ≈ 39% of the width in radius. Mask it to a soft circle
// so the black frame and the timestamp in the corner disappear.
const SIZE = 1024, DISC = 0.39, CROP = 0.49;
const FRAME = 1000 / 60;      // motion constants below are tuned per 60 Hz frame
const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas   full-viewport canvas behind the page
 * @param {HTMLElement} o.sun            the element the Sun is drawn over
 * @param {HTMLElement} o.caption        where the image credit and capture time go
 * @param {HTMLElement[]} o.regions      the canvas only animates while one of these is on screen
 * @param {import('./audio.js').SolarEngine} o.engine
 */
export function startVisuals({ canvas, sun, caption, regions, engine }) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const stillQuery = matchMedia('(prefers-reduced-motion: reduce)');

  const target = { intensity: 0.2, wind: 400, density: 0.3 };
  const smooth = { intensity: 0.2, wind: 400 };
  const stars = Array.from({ length: 140 }, () => ({ x: Math.random(), y: Math.random(), a: 0.08 + Math.random() * 0.3 }));
  const particles = [];
  let W = 0, H = 0, DPR = 1;
  let flash = 0, noteKick = 0;
  let sunTex = null;
  let rafId = 0, lastTime = 0;

  engine.on((type, d) => { if (type === 'note') noteKick = Math.min(1, noteKick + d.vel * 0.6); });

  function resize() {
    DPR = Math.min(2, devicePixelRatio || 1);
    W = canvas.width = Math.round(innerWidth * DPR);
    H = canvas.height = Math.round(innerHeight * DPR);
  }

  async function loadSun() {
    try {
      const res = await fetch('/api/sun.jpg');
      if (!res.ok) throw new Error(res.status);
      const captured = res.headers.get('x-captured');
      const bitmap = await createImageBitmap(await res.blob());
      const masked = document.createElement('canvas');
      masked.width = masked.height = SIZE;
      const m = masked.getContext('2d');
      m.drawImage(bitmap, 0, 0, SIZE, SIZE);
      bitmap.close();
      m.globalCompositeOperation = 'destination-in';
      const fade = m.createRadialGradient(SIZE / 2, SIZE / 2, SIZE * (DISC + 0.03), SIZE / 2, SIZE / 2, SIZE * CROP);
      fade.addColorStop(0, '#000'); fade.addColorStop(1, 'rgba(0,0,0,0)');
      m.fillStyle = fade; m.fillRect(0, 0, SIZE, SIZE);
      sunTex = masked;
      const when = captured && !isNaN(new Date(captured)) ? dayTime(captured) : null;
      caption.textContent = `NASA SDO · AIA 171 Å${when ? ` · ${when}` : ''}`;
      sun.setAttribute('aria-label', `The Sun in extreme ultraviolet light, photographed by NASA's Solar Dynamics Observatory${when ? ` on ${when}` : ''}.`);
    } catch {
      if (!sunTex) {
        caption.textContent = 'Solar image unavailable';
        sun.setAttribute('aria-label', 'The latest image of the Sun is unavailable.');
      }
    }
  }

  function draw(k) {
    const still = stillQuery.matches;
    const ease = 1 - 0.98 ** k;
    smooth.intensity = lerp(smooth.intensity, target.intensity, ease);
    smooth.wind = lerp(smooth.wind, target.wind, ease);
    flash *= 0.985 ** k;
    noteKick *= 0.92 ** k;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#fff';
    for (const star of stars) { ctx.globalAlpha = star.a; ctx.fillRect(star.x * W, star.y * H, DPR, DPR); }
    ctx.globalAlpha = 1;

    const box = sun.getBoundingClientRect();
    const cx = (box.left + box.width / 2) * DPR, cy = (box.top + box.height / 2) * DPR;
    const half = (box.width / 2) * DPR;            // half of the image frame
    const limb = half * (DISC / 0.5);              // edge of the solar disc
    const ring = half * 0.94;                      // reticle radius

    // solar wind: sparse 1px particles streaming outward
    if (!still) {
      if (Math.random() < (0.35 + target.density * 0.5) * k) {
        particles.push({ a: Math.random() * TAU, d: ring, v: (smooth.wind / 400) * (0.5 + Math.random() * 0.6) * DPR, life: 1 });
      }
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.d += p.v * 1.6 * k; p.life -= 0.0035 * k;
        if (p.life <= 0) { particles[i] = particles[particles.length - 1]; particles.pop(); continue; }
        ctx.globalAlpha = p.life * 0.35;
        ctx.fillRect(cx + Math.cos(p.a) * p.d, cy + Math.sin(p.a) * p.d, DPR, DPR);
      }
      ctx.globalAlpha = 1;
    }

    // the Sun
    if (sunTex) {
      const size = half * 2 * (still ? 1 : 1 + noteKick * 0.004);
      ctx.globalAlpha = Math.min(1, 0.82 + smooth.intensity * 0.18 + (still ? 0 : flash * 0.2));
      ctx.drawImage(sunTex, cx - size / 2, cy - size / 2, size, size);
      ctx.globalAlpha = 1;
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = DPR;
      ctx.beginPath(); ctx.arc(cx, cy, limb, 0, TAU); ctx.stroke();
    }

    // reticle: hairline ring with ticks every 10°
    ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = DPR;
    ctx.beginPath(); ctx.arc(cx, cy, ring, 0, TAU); ctx.stroke();
    ctx.beginPath();
    for (let deg = 0; deg < 360; deg += 10) {
      const a = deg * Math.PI / 180, len = (deg % 90 === 0 ? 10 : 4) * DPR;
      ctx.moveTo(cx + Math.cos(a) * ring, cy + Math.sin(a) * ring);
      ctx.lineTo(cx + Math.cos(a) * (ring + len), cy + Math.sin(a) * (ring + len));
    }
    ctx.stroke();
    if (still) return;

    // the audio waveform, wrapped around the reticle
    const wave = engine.waveform();
    if (wave) {
      const n = wave.length, amp = half * (0.4 + smooth.intensity * 0.4);
      ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = DPR;
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * TAU - Math.PI / 2;
        const edge = Math.min(1, Math.min(i, n - i) / 16);   // fade the ends together so the loop closes cleanly
        const r = ring + wave[i % n] * amp * edge;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }

    // flare: a single thin shock ring travelling from the limb to the reticle
    if (flash > 0.01) {
      ctx.strokeStyle = `rgba(252,61,33,${flash * 0.9})`; ctx.lineWidth = DPR;
      ctx.beginPath(); ctx.arc(cx, cy, lerp(limb, ring, Math.min(1, (1 - flash) * 1.6)), 0, TAU); ctx.stroke();
    }
  }

  function frame(time) {
    const k = lastTime ? Math.min(6, (time - lastTime) / FRAME) : 1;
    lastTime = time;
    draw(k);
    rafId = requestAnimationFrame(frame);
  }

  // Only animate while the canvas can be seen: the About section and footer cover it completely.
  function setRunning(run) {
    if (run === Boolean(rafId)) return;
    if (run) { lastTime = 0; rafId = requestAnimationFrame(frame); }
    else { cancelAnimationFrame(rafId); rafId = 0; }
  }
  const visible = new Set(regions);
  const observer = new IntersectionObserver(entries => {
    for (const e of entries) e.isIntersecting ? visible.add(e.target) : visible.delete(e.target);
    setRunning(visible.size > 0);
  });
  for (const region of regions) observer.observe(region);

  addEventListener('resize', resize);
  resize();
  setRunning(true);
  loadSun();
  setInterval(() => { if (!document.hidden) loadSun(); }, 15 * 60_000);

  return {
    /** Move the visuals toward new readings. */
    set({ intensity, wind, density }) { Object.assign(target, { intensity, wind, density }); },
    /** A flare just went off. */
    flash(strength) { flash = Math.max(flash, strength); },
  };
}
