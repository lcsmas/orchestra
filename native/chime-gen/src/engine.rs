//! Offline renderer for the chime recipes (plan §0: "Web Audio chime synth →
//! pre-rendered PCM"). Reproduces the small subset of Web Audio semantics
//! `src/renderer/chime.ts` actually uses:
//!
//! - `setValueAtTime` + `exponentialRampToValueAtTime` control curves
//!   (v(t) = v0 · (v1/v0)^((t−t0)/(t1−t0))) for oscillator frequency, filter
//!   frequency, and gain envelopes;
//! - OscillatorNode waveforms (sine / triangle / square / sawtooth, naive —
//!   fine for sub-second percussive chimes);
//! - AudioBufferSourceNode white noise (seeded xorshift instead of
//!   Math.random so builds are reproducible);
//! - BiquadFilterNode bandpass/lowpass per the Audio EQ Cookbook (what Web
//!   Audio implements). NOTE Web Audio quirk kept for parity: lowpass Q is in
//!   dB, bandpass Q is linear — recipes store the values exactly as chime.ts
//!   writes them and the conversion happens here;
//! - the 0.9 master gain.

use crate::recipes::{Filter, Ramp, Source, Voice, Wave};

pub const SAMPLE_RATE: u32 = 48_000;
const MASTER_GAIN: f32 = 0.9;

/// Evaluate a `setValueAtTime`/`exponentialRampToValueAtTime` breakpoint
/// curve at time `t` (seconds, relative to the voice start). Before the first
/// point: first value. After the last: last value. Between points:
/// exponential interpolation (all chime.ts curves ramp between positive
/// values, so the exponential form is always defined).
pub fn curve_at(points: &[Ramp], t: f64) -> f64 {
    match points {
        [] => 0.0,
        [only] => only.v,
        _ => {
            let first = &points[0];
            if t <= first.t {
                return first.v;
            }
            for pair in points.windows(2) {
                let (a, b) = (&pair[0], &pair[1]);
                if t <= b.t {
                    let frac = (t - a.t) / (b.t - a.t);
                    return a.v * (b.v / a.v).powf(frac);
                }
            }
            points[points.len() - 1].v
        }
    }
}

/// Deterministic white noise in [-1, 1) — xorshift64*, fixed seed per voice.
struct Noise {
    state: u64,
}

impl Noise {
    fn new() -> Self {
        Self {
            state: 0x9e37_79b9_7f4a_7c15,
        }
    }

    fn next(&mut self) -> f64 {
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        let bits = x.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 11;
        (bits as f64 / (1u64 << 53) as f64) * 2.0 - 1.0
    }
}

/// One RBJ-cookbook biquad, coefficients recomputed when the target
/// frequency moves (swoosh/pluck ramp their filters).
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl Biquad {
    fn new() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    fn set_bandpass(&mut self, freq: f64, q: f64) {
        let w0 = 2.0 * std::f64::consts::PI * freq / SAMPLE_RATE as f64;
        let alpha = w0.sin() / (2.0 * q);
        // "Constant 0 dB peak gain" bandpass — the Web Audio variant.
        let b0 = alpha;
        let a0 = 1.0 + alpha;
        self.b0 = b0 / a0;
        self.b1 = 0.0;
        self.b2 = -b0 / a0;
        self.a1 = -2.0 * w0.cos() / a0;
        self.a2 = (1.0 - alpha) / a0;
    }

    fn set_lowpass(&mut self, freq: f64, q_db: f64) {
        // Web Audio lowpass interprets Q in dB (spec quirk kept for parity).
        let q = 10f64.powf(q_db / 20.0);
        let w0 = 2.0 * std::f64::consts::PI * freq / SAMPLE_RATE as f64;
        let alpha = w0.sin() / (2.0 * q);
        let cos = w0.cos();
        let a0 = 1.0 + alpha;
        self.b0 = (1.0 - cos) / 2.0 / a0;
        self.b1 = (1.0 - cos) / a0;
        self.b2 = (1.0 - cos) / 2.0 / a0;
        self.a1 = -2.0 * cos / a0;
        self.a2 = (1.0 - alpha) / a0;
    }

    fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

fn osc_sample(wave: Wave, phase: f64) -> f64 {
    // phase in [0, 1)
    match wave {
        Wave::Sine => (2.0 * std::f64::consts::PI * phase).sin(),
        Wave::Triangle => 4.0 * (phase - (phase + 0.5).floor()).abs() - 1.0,
        Wave::Square => {
            if phase < 0.5 {
                1.0
            } else {
                -1.0
            }
        }
        Wave::Sawtooth => 2.0 * phase - 1.0,
    }
}

/// Total length of a rendered sound in seconds: the last voice's stop time
/// plus a short tail so ramped filters ring out instead of clicking.
pub fn duration(voices: &[Voice]) -> f64 {
    voices
        .iter()
        .map(|v| v.start + v.stop)
        .fold(0.0, f64::max)
        + 0.05
}

/// Render a whole recipe (all its voices mixed) to f32 samples at 48 kHz.
pub fn render(voices: &[Voice]) -> Vec<f32> {
    let total = (duration(voices) * SAMPLE_RATE as f64).ceil() as usize;
    let mut out = vec![0.0f32; total];
    let dt = 1.0 / SAMPLE_RATE as f64;

    for voice in voices {
        let start_idx = (voice.start * SAMPLE_RATE as f64).round() as usize;
        let len = (voice.stop * SAMPLE_RATE as f64).ceil() as usize;
        let mut phase = 0.0f64;
        let mut noise = Noise::new();
        let mut biquad = Biquad::new();

        for i in 0..len {
            let t = i as f64 * dt;
            let raw = match &voice.source {
                Source::Osc { wave, freq } => {
                    let f = curve_at(freq, t);
                    phase += f * dt;
                    phase -= phase.floor();
                    osc_sample(*wave, phase)
                }
                Source::Noise => noise.next(),
            };
            let filtered = match &voice.filter {
                Filter::None => raw,
                Filter::Bandpass { freq, q } => {
                    biquad.set_bandpass(curve_at(freq, t), *q);
                    biquad.process(raw)
                }
                Filter::Lowpass { freq, q } => {
                    biquad.set_lowpass(curve_at(freq, t), *q);
                    biquad.process(raw)
                }
            };
            let gained = filtered * curve_at(&voice.gain, t) * MASTER_GAIN as f64;
            if let Some(slot) = out.get_mut(start_idx + i) {
                *slot += gained as f32;
            }
        }
    }
    out
}

/// Serialize samples as a 16-bit mono PCM WAV file.
pub fn to_wav(samples: &[f32]) -> Vec<u8> {
    let data_len = samples.len() * 2;
    let mut wav = Vec::with_capacity(44 + data_len);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data_len as u32).to_le_bytes());
    for s in samples {
        let clamped = s.clamp(-1.0, 1.0);
        wav.extend_from_slice(&((clamped * 32767.0) as i16).to_le_bytes());
    }
    wav
}
