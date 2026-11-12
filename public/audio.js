// Generative ambient engine. Everything is driven by four numbers:
//   intensity (0–1) ← flare class / live X-ray flux   → brightness, note density, bell energy
//   tempo (BPM)     ← solar wind speed                → transport speed, wind-noise sweep rate
//   texture (0–1)   ← geomagnetic storm level (Kp)    → hiss, crackle, bit-crush, chorus depth
//   rumble (0/1)    ← Earth-directed CME inbound       → sub-bass swell
// plus mode (B/C/M/X) which picks the scale.

const Tone = window.Tone;

const SCALES = {
  B: [0, 2, 4, 7, 9],              // major pentatonic — quiet sun
  C: [0, 2, 4, 6, 7, 9, 11],       // lydian — gentle activity
  M: [0, 2, 3, 5, 7, 9, 10],       // dorian — moody
  X: [0, 1, 3, 5, 7, 8, 10],       // phrygian — dark, tense
};
const ROOT = 50; // D3
const PROGRESSION = [0, 5, 3, 4];  // scale degrees, one per 2 bars

const midi = n => Tone.Frequency(n, 'midi').toNote();
const rand = a => a[Math.floor(Math.random() * a.length)];

function degreeToMidi(scale, degree, octave = 0) {
  const len = scale.length;
  const o = Math.floor(degree / len);
  return ROOT + scale[((degree % len) + len) % len] + 12 * (o + octave);
}

export class SolarEngine {
  constructor() {
    this.params = { intensity: 0.2, tempo: 70, texture: 0.2, rumble: 0, density: 0.3, mode: 'B' };
    this.bar = 0;
    this.started = false;
    this.listeners = new Set();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data) { for (const fn of this.listeners) fn(type, data); }

  async start() {
    if (this.started) return;
    await Tone.start();
    this.build();
    this.apply(this.params, 0.01);
    Tone.getTransport().start('+0.1');
    this.started = true;
  }

  build() {
    const T = Tone;
    this.master = new T.Gain(0).toDestination();
    this.master.gain.rampTo(0.9, 4);
    this.limiter = new T.Limiter(-3).connect(this.master);
    this.analyser = new T.Analyser('waveform', 512);
    this.fft = new T.Analyser('fft', 64);
    this.limiter.connect(this.analyser);
    this.limiter.connect(this.fft);

    this.reverb = new T.Reverb({ decay: 9, preDelay: 0.08, wet: 0.55 }).connect(this.limiter);
    this.delay = new T.FeedbackDelay({ delayTime: '4n.', feedback: 0.45, wet: 0.3 }).connect(this.reverb);

    // --- Pad: the "sun" itself
    this.padFilter = new T.Filter({ type: 'lowpass', frequency: 800, Q: 0.7 }).connect(this.reverb);
    this.chorus = new T.Chorus({ frequency: 0.3, delayTime: 4, depth: 0.5, wet: 0.5 }).start().connect(this.padFilter);
    this.pad = new T.PolySynth(T.FMSynth, {
      harmonicity: 1.5, modulationIndex: 2,
      oscillator: { type: 'sine' }, modulation: { type: 'triangle' },
      envelope: { attack: 3, decay: 1, sustain: 0.8, release: 6 },
      modulationEnvelope: { attack: 4, decay: 0, sustain: 1, release: 6 },
      volume: -20,
    }).connect(this.chorus);
    this.pad.maxPolyphony = 12;

    // --- Bells: individual photons
    this.crusher = new T.BitCrusher(8);
    this.crusher.wet.value = 0;
    this.bellPan = new T.AutoPanner({ frequency: 0.07, depth: 0.8 }).start();
    this.crusher.chain(this.bellPan, this.delay);
    this.bells = new T.PolySynth(T.FMSynth, {
      harmonicity: 3.01, modulationIndex: 10,
      envelope: { attack: 0.005, decay: 1.6, sustain: 0, release: 2.5 },
      modulationEnvelope: { attack: 0.002, decay: 0.4, sustain: 0, release: 0.5 },
      volume: -24,
    }).connect(this.crusher);

    // --- Bass pulse
    this.bass = new T.MonoSynth({
      oscillator: { type: 'triangle' },
      filter: { Q: 1, type: 'lowpass' },
      filterEnvelope: { attack: 0.05, decay: 0.6, sustain: 0.2, release: 1.5, baseFrequency: 80, octaves: 2 },
      envelope: { attack: 0.08, decay: 0.8, sustain: 0.4, release: 2 },
      volume: -18,
    }).connect(this.reverb);

    // --- Solar wind hiss
    this.windGain = new T.Gain(0).connect(this.reverb);
    this.windFilter = new T.AutoFilter({ frequency: 0.1, baseFrequency: 300, octaves: 4, depth: 0.9, filter: { type: 'bandpass', Q: 2 } }).start().connect(this.windGain);
    this.windNoise = new T.Noise('pink').connect(this.windFilter).start();

    // --- Geomagnetic crackle (storm texture)
    this.crackleGain = new T.Gain(0).connect(this.delay);
    this.crackleFilter = new T.Filter({ type: 'bandpass', frequency: 3000, Q: 6 }).connect(this.crackleGain);
    this.crackle = new T.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.03, sustain: 0 }, volume: -10 }).connect(this.crackleFilter);

    // --- CME rumble
    this.rumbleGain = new T.Gain(0).connect(this.limiter);
    this.rumbleLFO = new T.LFO({ frequency: 0.13, min: 0.2, max: 1 }).start();
    this.rumbleAmp = new T.Gain(0).connect(this.rumbleGain);
    this.rumbleLFO.connect(this.rumbleAmp.gain);
    this.rumbleOsc = new T.FatOscillator({ frequency: 36.7, type: 'sine', count: 3, spread: 12 }).connect(this.rumbleAmp).start();

    // --- Flare swell (one-shot riser)
    this.swellFilter = new T.Filter({ type: 'bandpass', frequency: 400, Q: 3 }).connect(this.reverb);
    this.swellGain = new T.Gain(0).connect(this.swellFilter);
    this.swellNoise = new T.Noise('white').connect(this.swellGain).start();

    this.schedule();
  }

  schedule() {
    const tr = Tone.getTransport();

    // Chords: every 2 bars
    tr.scheduleRepeat(time => {
      const scale = SCALES[this.params.mode];
      const deg = PROGRESSION[(this.bar / 2) % PROGRESSION.length | 0];
      const notes = [0, 2, 4, 6].map(s => midi(degreeToMidi(scale, deg + s, -1)));
      if (this.params.intensity > 0.45) notes.push(midi(degreeToMidi(scale, deg + 8, -1)));
      this.pad.releaseAll(time);
      this.pad.triggerAttack(notes, time + 0.05, 0.5);
      this.bass.triggerAttackRelease(midi(degreeToMidi(scale, deg, -2)), '1n', time, 0.7);
      this.currentDegree = deg;
      this.emit('chord', { notes, degree: deg });
    }, '2m');

    tr.scheduleRepeat(() => { this.bar++; }, '1m');

    // Bells: 8th-note grid, probability grows with intensity
    tr.scheduleRepeat(time => {
      const p = 0.06 + this.params.intensity * 0.55;
      if (Math.random() > p) return;
      const scale = SCALES[this.params.mode];
      const deg = (this.currentDegree || 0) + rand([0, 2, 4, 7, 9, 11]);
      const oct = this.params.intensity > 0.6 && Math.random() < 0.4 ? 2 : 1;
      const vel = 0.25 + Math.random() * 0.5 * (0.5 + this.params.intensity);
      this.bells.triggerAttackRelease(midi(degreeToMidi(scale, deg, oct)), '8n', time, vel);
      Tone.getDraw().schedule(() => this.emit('note', { vel }), time);
    }, '8n');

    // Bass pulse on beat 3 when it's busy
    tr.scheduleRepeat(time => {
      if (this.params.intensity < 0.4) return;
      const scale = SCALES[this.params.mode];
      this.bass.triggerAttackRelease(midi(degreeToMidi(scale, (this.currentDegree || 0) + 4, -2)), '4n', time, 0.4);
    }, '1m', '2n');

    // Crackle: fast random ticks, density = texture
    tr.scheduleRepeat(time => {
      const t = this.params.texture;
      if (t < 0.25 || Math.random() > (t - 0.2) * 0.9) return;
      const n = 1 + Math.floor(Math.random() * 4 * t);
      // NoiseSynth is monophonic: hit times must be strictly increasing.
      const offsets = Array.from({ length: n }, () => Math.random() * 0.12).sort((a, b) => a - b);
      for (let i = 0; i < n; i++) {
        const at = time + offsets[i] + i * 0.001;
        this.crackleFilter.frequency.setValueAtTime(1500 + Math.random() * 6000, at);
        this.crackle.triggerAttackRelease(0.02, at, 0.3 + Math.random() * 0.7);
      }
    }, '16n');
  }

  /** Smoothly move to new parameters. */
  apply(p, ramp = 6) {
    const prevMode = this.params.mode;
    this.params = { ...this.params, ...p };
    if (!this.pad) return; // not built yet; start() applies the stored params
    const { intensity: I, tempo, texture: X, rumble, density } = this.params;

    Tone.getTransport().bpm.rampTo(tempo, ramp);
    this.padFilter.frequency.rampTo(300 + I * I * 4200, ramp);
    this.pad.set({ modulationIndex: 1.5 + I * 6 });
    this.bells.set({ modulationIndex: 6 + I * 18 });
    this.delay.feedback.rampTo(0.35 + I * 0.25, ramp);
    this.reverb.wet.rampTo(0.45 + density * 0.3, ramp);

    this.windGain.gain.rampTo(0.03 + X * 0.12 + density * 0.05, ramp);
    this.windFilter.frequency.rampTo(tempo / 600, ramp);
    this.crackleGain.gain.rampTo(X > 0.25 ? 0.25 + X * 0.5 : 0, ramp);
    this.crusher.wet.rampTo(X > 0.5 ? (X - 0.5) * 1.2 : 0, ramp);
    this.chorus.depth = 0.3 + X * 0.7;

    this.rumbleGain.gain.rampTo(rumble ? 0.35 : 0, ramp * 2);

    if (prevMode !== this.params.mode) this.emit('mode', this.params.mode);
  }

  /** A new flare just happened: rising swell + a cascade of bells. */
  flare(strength = 0.7) {
    if (!this.started) return;
    const now = Tone.now();
    const dur = 4 + strength * 6;
    this.swellGain.gain.cancelScheduledValues(now);
    this.swellGain.gain.setValueAtTime(0, now);
    this.swellGain.gain.linearRampToValueAtTime(0.25 + strength * 0.35, now + dur * 0.6);
    this.swellGain.gain.linearRampToValueAtTime(0, now + dur);
    this.swellFilter.frequency.cancelScheduledValues(now);
    this.swellFilter.frequency.setValueAtTime(200, now);
    this.swellFilter.frequency.exponentialRampToValueAtTime(6000, now + dur * 0.6);
    this.swellFilter.frequency.exponentialRampToValueAtTime(800, now + dur);

    const scale = SCALES[this.params.mode];
    const peak = now + dur * 0.6;
    const count = 6 + Math.round(strength * 10);
    for (let i = 0; i < count; i++) {
      const deg = (this.currentDegree || 0) + i * 2;
      this.bells.triggerAttackRelease(midi(degreeToMidi(scale, deg, 1)), '8n', peak + i * 0.09, 0.6 - i * 0.02);
    }
    this.emit('flare', { strength, peakIn: dur * 0.6 });
  }

  setVolume(v) { if (this.master) this.master.gain.rampTo(v, 0.3); }

  async stop() {
    if (!this.started) return;
    this.master.gain.rampTo(0, 1.5);
    await new Promise(r => setTimeout(r, 1600));
    Tone.getTransport().pause();
    this.paused = true;
  }

  async resume() {
    await Tone.start();
    Tone.getTransport().start();
    this.master.gain.rampTo(0.9, 2);
    this.paused = false;
  }
}
