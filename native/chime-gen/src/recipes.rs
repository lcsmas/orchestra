//! Declarative recipe tables — a 1:1 port of the ~20 oscillator recipes in
//! `src/renderer/chime.ts` (the behavioral source of truth). Every frequency,
//! gain breakpoint, filter parameter, timing offset, and the SOUNDS ordering
//! is copied verbatim from that file; the unit tests below pin the values so
//! drift against chime.ts is a test failure, not a silent detune.
//!
//! Shape mapping: each `Voice` is one OscillatorNode-or-noise + optional
//! biquad + GainNode chain; `Ramp` points are the
//! `setValueAtTime`/`exponentialRampToValueAtTime` calls with times relative
//! to the voice's `start` offset (chime.ts writes them relative to `now`).

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Wave {
    Sine,
    Triangle,
    Square,
    Sawtooth,
}

/// One control-curve breakpoint (time seconds, value).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ramp {
    pub t: f64,
    pub v: f64,
}

fn r(t: f64, v: f64) -> Ramp {
    Ramp { t, v }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    Osc { wave: Wave, freq: Vec<Ramp> },
    Noise,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Filter {
    None,
    /// Web Audio bandpass: linear Q.
    Bandpass {
        freq: Vec<Ramp>,
        q: f64,
    },
    /// Web Audio lowpass: Q in dB (the value chime.ts writes).
    Lowpass {
        freq: Vec<Ramp>,
        q: f64,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Voice {
    /// Offset of this voice within the sound (the `now + delay` in chime.ts).
    pub start: f64,
    /// `osc.stop(start + stop)` — render length of the voice.
    pub stop: f64,
    pub source: Source,
    pub filter: Filter,
    pub gain: Vec<Ramp>,
}

pub struct Recipe {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub voices: Vec<Voice>,
}

const QUIET: f64 = 0.0001;

fn osc(start: f64, stop: f64, wave: Wave, freq: Vec<Ramp>, gain: Vec<Ramp>) -> Voice {
    Voice {
        start,
        stop,
        source: Source::Osc { wave, freq },
        filter: Filter::None,
        gain,
    }
}

fn noise_bp(start: f64, stop: f64, freq: f64, q: f64, gain: Vec<Ramp>) -> Voice {
    Voice {
        start,
        stop,
        source: Source::Noise,
        filter: Filter::Bandpass {
            freq: vec![r(0.0, freq)],
            q,
        },
        gain,
    }
}

/// chime.ts `knock`/`doubleKnock` hit: low kick-thud (180→70 Hz sine) +
/// brushy tick (1800 Hz bandpass noise). The two variants differ only in
/// peaks and decay/stop times, passed explicitly.
struct KnockParams {
    body_peak: f64,
    body_end: f64,
    body_stop: f64,
    tick_peak: f64,
    tick_end: f64,
    tick_stop: f64,
}

fn knock_at(t: f64, p: &KnockParams) -> Vec<Voice> {
    vec![
        osc(
            t,
            p.body_stop,
            Wave::Sine,
            vec![r(0.0, 180.0), r(0.09, 70.0)],
            vec![r(0.0, QUIET), r(0.004, p.body_peak), r(p.body_end, QUIET)],
        ),
        noise_bp(
            t,
            p.tick_stop,
            1800.0,
            0.9,
            vec![r(0.0, QUIET), r(0.002, p.tick_peak), r(p.tick_end, QUIET)],
        ),
    ]
}

pub fn recipes() -> Vec<Recipe> {
    vec![
        // ---- two-note percussion variants (chime.ts SOUNDS order) ----
        Recipe {
            id: "double-knock",
            name: "Double knock",
            description: "Two soft Slack-style knocks",
            voices: [0.0, 0.14]
                .into_iter()
                .flat_map(|t| {
                    knock_at(
                        t,
                        &KnockParams {
                            body_peak: 0.4,
                            body_end: 0.1,
                            body_stop: 0.12,
                            tick_peak: 0.15,
                            tick_end: 0.05,
                            tick_stop: 0.07,
                        },
                    )
                })
                .collect(),
        },
        Recipe {
            id: "double-tap",
            name: "Double tap",
            description: "Two crisp wooden taps",
            voices: [0.0, 0.09]
                .into_iter()
                .map(|t| {
                    noise_bp(
                        t,
                        0.05,
                        2600.0,
                        4.0,
                        vec![r(0.0, QUIET), r(0.002, 0.28), r(0.04, QUIET)],
                    )
                })
                .collect(),
        },
        Recipe {
            id: "double-thud",
            name: "Double thud",
            description: "Two deep muted thumps",
            voices: [0.0, 0.16]
                .into_iter()
                .map(|t| {
                    osc(
                        t,
                        0.17,
                        Wave::Sine,
                        vec![r(0.0, 140.0), r(0.13, 60.0)],
                        vec![r(0.0, QUIET), r(0.005, 0.42), r(0.15, QUIET)],
                    )
                })
                .collect(),
        },
        Recipe {
            id: "double-pop",
            name: "Double pop",
            description: "Two rising blips",
            voices: [520.0, 760.0]
                .into_iter()
                .enumerate()
                .map(|(i, pitch)| {
                    osc(
                        i as f64 * 0.1,
                        0.11,
                        Wave::Sine,
                        vec![r(0.0, pitch * 1.25), r(0.05, pitch)],
                        vec![r(0.0, QUIET), r(0.003, 0.3), r(0.09, QUIET)],
                    )
                })
                .collect(),
        },
        Recipe {
            id: "double-ping",
            name: "Double ping",
            description: "Two-note ping, major third up",
            voices: [659.25, 784.0]
                .into_iter()
                .enumerate()
                .map(|(i, pitch)| {
                    osc(
                        i as f64 * 0.12,
                        0.16,
                        Wave::Triangle,
                        vec![r(0.0, pitch)],
                        vec![r(0.0, QUIET), r(0.006, 0.16), r(0.14, QUIET)],
                    )
                })
                .collect(),
        },
        Recipe {
            id: "double-drop",
            name: "Double drop",
            description: "Two water-drop chirps",
            voices: [0.0, 0.12]
                .into_iter()
                .map(|t| {
                    osc(
                        t,
                        0.12,
                        Wave::Sine,
                        vec![r(0.0, 380.0), r(0.07, 1700.0)],
                        vec![r(0.0, QUIET), r(0.008, 0.2), r(0.1, QUIET)],
                    )
                })
                .collect(),
        },
        Recipe {
            id: "click",
            name: "Click",
            description: "Two quick mechanical taps",
            voices: [0.0, 0.055]
                .into_iter()
                .map(|t| {
                    noise_bp(
                        t,
                        0.04,
                        3500.0,
                        2.5,
                        vec![r(0.0, QUIET), r(0.001, 0.22), r(0.025, QUIET)],
                    )
                })
                .collect(),
        },
        Recipe {
            id: "bloop",
            name: "Bloop",
            description: "Two ascending sine blips",
            voices: [520.0, 780.0]
                .into_iter()
                .enumerate()
                .map(|(i, freq)| {
                    osc(
                        i as f64 * 0.08,
                        0.11,
                        Wave::Sine,
                        vec![r(0.0, freq)],
                        vec![r(0.0, QUIET), r(0.005, 0.24), r(0.09, QUIET)],
                    )
                })
                .collect(),
        },
        Recipe {
            id: "coin",
            name: "Coin",
            description: "Retro pickup, two-note up",
            // G5, D6 — chime.ts's retro coin arpeggio.
            voices: [784.0, 1175.0]
                .into_iter()
                .enumerate()
                .map(|(i, note)| {
                    osc(
                        i as f64 * 0.09,
                        0.13,
                        Wave::Square,
                        vec![r(0.0, note)],
                        vec![r(0.0, QUIET), r(0.003, 0.08), r(0.12, QUIET)],
                    )
                })
                .collect(),
        },
        // ---- single-hit variants ----
        Recipe {
            id: "knock",
            name: "Knock",
            description: "Slack-style soft knock",
            voices: knock_at(
                0.0,
                &KnockParams {
                    body_peak: 0.45,
                    body_end: 0.11,
                    body_stop: 0.13,
                    tick_peak: 0.18,
                    tick_end: 0.055,
                    tick_stop: 0.08,
                },
            ),
        },
        Recipe {
            id: "pop",
            name: "Pop",
            description: "Short pitched blip",
            voices: vec![osc(
                0.0,
                0.1,
                Wave::Sine,
                vec![r(0.0, 680.0), r(0.07, 220.0)],
                vec![r(0.0, QUIET), r(0.003, 0.35), r(0.09, QUIET)],
            )],
        },
        Recipe {
            id: "tap",
            name: "Tap",
            description: "Dry wooden tap",
            voices: vec![noise_bp(
                0.0,
                0.05,
                2600.0,
                4.0,
                vec![r(0.0, QUIET), r(0.002, 0.3), r(0.04, QUIET)],
            )],
        },
        Recipe {
            id: "thud",
            name: "Thud",
            description: "Deep muted thump",
            voices: vec![osc(
                0.0,
                0.2,
                Wave::Sine,
                vec![r(0.0, 120.0), r(0.15, 55.0)],
                vec![r(0.0, QUIET), r(0.006, 0.5), r(0.18, QUIET)],
            )],
        },
        Recipe {
            id: "ping",
            name: "Ping",
            description: "Short crisp tone",
            voices: vec![osc(
                0.0,
                0.16,
                Wave::Triangle,
                vec![r(0.0, 880.0)],
                vec![r(0.0, QUIET), r(0.006, 0.18), r(0.14, QUIET)],
            )],
        },
        Recipe {
            id: "drop",
            name: "Drop",
            description: "Water-drop chirp",
            voices: vec![osc(
                0.0,
                0.16,
                Wave::Sine,
                vec![r(0.0, 380.0), r(0.09, 1800.0)],
                vec![r(0.0, QUIET), r(0.01, 0.22), r(0.14, QUIET)],
            )],
        },
        Recipe {
            id: "chirp",
            name: "Chirp",
            description: "Quick upward sweep",
            voices: vec![osc(
                0.0,
                0.1,
                Wave::Triangle,
                vec![r(0.0, 1100.0), r(0.07, 2400.0)],
                vec![r(0.0, QUIET), r(0.004, 0.14), r(0.09, QUIET)],
            )],
        },
        Recipe {
            id: "swoosh",
            name: "Swoosh",
            description: "Brushy filtered sweep",
            voices: vec![Voice {
                start: 0.0,
                stop: 0.24,
                source: Source::Noise,
                filter: Filter::Bandpass {
                    freq: vec![r(0.0, 800.0), r(0.18, 3200.0)],
                    q: 3.0,
                },
                gain: vec![r(0.0, QUIET), r(0.02, 0.22), r(0.22, QUIET)],
            }],
        },
        Recipe {
            id: "marimba",
            name: "Marimba",
            description: "Woody plucked note",
            // C5 fundamental + a quiet octave.
            voices: [(523.25, 0.22), (1046.5, 0.06)]
                .into_iter()
                .map(|(freq, vol)| {
                    osc(
                        0.0,
                        0.3,
                        Wave::Sine,
                        vec![r(0.0, freq)],
                        vec![r(0.0, QUIET), r(0.004, vol), r(0.28, QUIET)],
                    )
                })
                .collect(),
        },
        Recipe {
            id: "pluck",
            name: "Pluck",
            description: "Soft string pluck",
            voices: vec![Voice {
                start: 0.0,
                stop: 0.32,
                source: Source::Osc {
                    wave: Wave::Sawtooth,
                    freq: vec![r(0.0, 440.0)], // A4
                },
                filter: Filter::Lowpass {
                    freq: vec![r(0.0, 2800.0), r(0.25, 500.0)],
                    q: 2.0,
                },
                gain: vec![r(0.0, QUIET), r(0.005, 0.12), r(0.3, QUIET)],
            }],
        },
        Recipe {
            id: "bubble",
            name: "Bubble",
            description: "Pitched sine bubble",
            voices: vec![osc(
                0.0,
                0.16,
                Wave::Sine,
                vec![r(0.0, 500.0), r(0.05, 900.0), r(0.12, 600.0)],
                vec![r(0.0, QUIET), r(0.006, 0.2), r(0.14, QUIET)],
            )],
        },
        Recipe {
            id: "zap",
            name: "Zap",
            description: "Synthy descending drop",
            voices: vec![Voice {
                start: 0.0,
                stop: 0.16,
                source: Source::Osc {
                    wave: Wave::Sawtooth,
                    freq: vec![r(0.0, 1400.0), r(0.12, 220.0)],
                },
                filter: Filter::Lowpass {
                    freq: vec![r(0.0, 3500.0)],
                    q: 1.0, // Web Audio BiquadFilter default — chime.ts never sets it
                },
                gain: vec![r(0.0, QUIET), r(0.005, 0.1), r(0.14, QUIET)],
            }],
        },
        Recipe {
            id: "tada",
            name: "Tada",
            description: "Triad chord",
            // C5 + E5 + G5 together.
            voices: [523.25, 659.25, 784.0]
                .into_iter()
                .map(|freq| {
                    osc(
                        0.0,
                        0.37,
                        Wave::Triangle,
                        vec![r(0.0, freq)],
                        vec![r(0.0, QUIET), r(0.02, 0.08), r(0.35, QUIET)],
                    )
                })
                .collect(),
        },
        Recipe {
            id: "none",
            name: "Silent",
            description: "No sound",
            voices: vec![],
        },
    ]
}

/// chime.ts `DEFAULT_ID`.
pub const DEFAULT_ID: &str = "knock";
