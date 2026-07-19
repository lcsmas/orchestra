//! Build-time chime synthesizer (plan §0 substitution: Web Audio → offline
//! PCM). `recipes()` is the byte-faithful port of `src/renderer/chime.ts`;
//! `engine` renders a recipe to 48 kHz mono WAV bytes. Consumed two ways:
//!
//! - as a build-dependency of `orchestra-gtk` (its build.rs renders every
//!   recipe into OUT_DIR and the app embeds the bytes — no binary assets in
//!   git, and the shipped audio can never drift from these tables);
//! - as a bin (`cargo run -p chime-gen -- <outdir>`) so E2E scripts can
//!   render the WAVs to disk and assert on them.

pub mod engine;
pub mod recipes;

pub use recipes::{recipes, Recipe, DEFAULT_ID};

/// Render one recipe to a complete WAV file (empty voices → 0-sample WAV).
pub fn render_wav(recipe: &Recipe) -> Vec<u8> {
    engine::to_wav(&engine::render(&recipe.voices))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{curve_at, render};
    use crate::recipes::{Filter, Ramp, Source, Wave};

    fn recipe(id: &str) -> Recipe {
        recipes().into_iter().find(|r| r.id == id).unwrap()
    }

    /// The SOUNDS list must mirror chime.ts exactly: same ids, same order,
    /// same default. The picker UI renders this order.
    #[test]
    fn sound_list_matches_chime_ts() {
        let ids: Vec<&str> = recipes().iter().map(|r| r.id).collect();
        assert_eq!(
            ids,
            [
                "double-knock",
                "double-tap",
                "double-thud",
                "double-pop",
                "double-ping",
                "double-drop",
                "click",
                "bloop",
                "coin",
                "knock",
                "pop",
                "tap",
                "thud",
                "ping",
                "drop",
                "chirp",
                "swoosh",
                "marimba",
                "pluck",
                "bubble",
                "zap",
                "tada",
                "none",
            ]
        );
        assert_eq!(DEFAULT_ID, "knock");
    }

    /// Parameter spot-checks against chime.ts's literal values — the drift
    /// gate for the recipe tables.
    #[test]
    fn recipe_parameters_match_chime_ts() {
        // knock: body sine 180→70 Hz over 0.09 s, peak 0.45 at +0.004;
        // tick noise bandpass 1800 Hz Q 0.9, peak 0.18 at +0.002.
        let knock = recipe("knock");
        assert_eq!(knock.voices.len(), 2);
        let body = &knock.voices[0];
        let Source::Osc { wave, freq } = &body.source else {
            panic!("knock body must be an oscillator");
        };
        assert_eq!(*wave, Wave::Sine);
        assert_eq!(
            freq,
            &[Ramp { t: 0.0, v: 180.0 }, Ramp { t: 0.09, v: 70.0 }]
        );
        assert_eq!(body.gain[1], Ramp { t: 0.004, v: 0.45 });
        assert_eq!(body.gain[2], Ramp { t: 0.11, v: 0.0001 });
        let tick = &knock.voices[1];
        assert_eq!(tick.source, Source::Noise);
        let Filter::Bandpass { freq, q } = &tick.filter else {
            panic!("knock tick must be bandpass noise");
        };
        assert_eq!(freq[0].v, 1800.0);
        assert_eq!(*q, 0.9);
        assert_eq!(tick.gain[1], Ramp { t: 0.002, v: 0.18 });

        // coin: G5/D6 squares, 0.09 s apart, peak 0.08.
        let coin = recipe("coin");
        let notes: Vec<(f64, f64)> = coin
            .voices
            .iter()
            .map(|v| {
                let Source::Osc { wave, freq } = &v.source else {
                    panic!("coin is oscillators");
                };
                assert_eq!(*wave, Wave::Square);
                (v.start, freq[0].v)
            })
            .collect();
        assert_eq!(notes, [(0.0, 784.0), (0.09, 1175.0)]);
        assert_eq!(coin.voices[0].gain[1].v, 0.08);

        // tada: C5+E5+G5 triangles, peak 0.08 at +0.02, decay to 0.35.
        let tada = recipe("tada");
        let freqs: Vec<f64> = tada
            .voices
            .iter()
            .map(|v| {
                let Source::Osc { freq, .. } = &v.source else {
                    panic!()
                };
                freq[0].v
            })
            .collect();
        assert_eq!(freqs, [523.25, 659.25, 784.0]);
        assert_eq!(tada.voices[0].gain[1], Ramp { t: 0.02, v: 0.08 });
        assert_eq!(tada.voices[0].gain[2], Ramp { t: 0.35, v: 0.0001 });

        // swoosh: bandpass noise sweeping 800→3200 Hz over 0.18 s, Q 3.
        let swoosh = recipe("swoosh");
        let Filter::Bandpass { freq, q } = &swoosh.voices[0].filter else {
            panic!("swoosh is bandpass noise");
        };
        assert_eq!(
            freq,
            &[Ramp { t: 0.0, v: 800.0 }, Ramp { t: 0.18, v: 3200.0 }]
        );
        assert_eq!(*q, 3.0);

        // pluck: sawtooth A4 through a 2800→500 Hz lowpass, Q 2 (dB).
        let pluck = recipe("pluck");
        let Source::Osc { wave, freq } = &pluck.voices[0].source else {
            panic!()
        };
        assert_eq!(*wave, Wave::Sawtooth);
        assert_eq!(freq[0].v, 440.0);
        let Filter::Lowpass { freq, q } = &pluck.voices[0].filter else {
            panic!("pluck is lowpassed");
        };
        assert_eq!(
            freq,
            &[Ramp { t: 0.0, v: 2800.0 }, Ramp { t: 0.25, v: 500.0 }]
        );
        assert_eq!(*q, 2.0);

        // zap: sawtooth 1400→220 Hz over 0.12 s, fixed 3500 Hz lowpass.
        let zap = recipe("zap");
        let Source::Osc { freq, .. } = &zap.voices[0].source else {
            panic!()
        };
        assert_eq!(
            freq,
            &[Ramp { t: 0.0, v: 1400.0 }, Ramp { t: 0.12, v: 220.0 }]
        );

        // bubble: sine 500→900→600 Hz.
        let bubble = recipe("bubble");
        let Source::Osc { freq, .. } = &bubble.voices[0].source else {
            panic!()
        };
        assert_eq!(
            freq,
            &[
                Ramp { t: 0.0, v: 500.0 },
                Ramp { t: 0.05, v: 900.0 },
                Ramp { t: 0.12, v: 600.0 }
            ]
        );

        // double-ping: E5 then G5, 0.12 s apart.
        let dp = recipe("double-ping");
        assert_eq!(dp.voices[0].start, 0.0);
        assert_eq!(dp.voices[1].start, 0.12);
        let Source::Osc { freq, .. } = &dp.voices[1].source else {
            panic!()
        };
        assert_eq!(freq[0].v, 784.0);

        // marimba: fundamental + quiet octave (0.22 / 0.06).
        let marimba = recipe("marimba");
        assert_eq!(marimba.voices[0].gain[1].v, 0.22);
        assert_eq!(marimba.voices[1].gain[1].v, 0.06);
        let Source::Osc { freq, .. } = &marimba.voices[1].source else {
            panic!()
        };
        assert_eq!(freq[0].v, 1046.5);
    }

    #[test]
    fn every_audible_recipe_renders_sound() {
        for recipe in recipes() {
            let samples = render(&recipe.voices);
            let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
            if recipe.id == "none" {
                assert!(samples.is_empty() || peak == 0.0, "'none' must be silent");
            } else {
                assert!(
                    peak > 0.02,
                    "recipe '{}' rendered near-silence (peak {peak})",
                    recipe.id
                );
                // Envelopes all decay to 0.0001 — the render must not end on
                // an audible click.
                let tail = samples.last().copied().unwrap_or(0.0).abs();
                assert!(
                    tail < 0.02,
                    "recipe '{}' ends with a click (tail {tail})",
                    recipe.id
                );
            }
        }
    }

    #[test]
    fn renders_are_deterministic() {
        let knock = recipe("double-knock");
        assert_eq!(render_wav(&knock), render_wav(&knock));
    }

    #[test]
    fn exponential_curve_matches_web_audio_semantics() {
        let points = [Ramp { t: 0.0, v: 100.0 }, Ramp { t: 0.1, v: 400.0 }];
        assert_eq!(curve_at(&points, 0.0), 100.0);
        // Exponential midpoint of 100→400 is 200, not 250.
        assert!((curve_at(&points, 0.05) - 200.0).abs() < 1e-9);
        assert_eq!(curve_at(&points, 0.2), 400.0);
        // Before the first point: first value (setValueAtTime).
        assert_eq!(curve_at(&points, -1.0), 100.0);
    }
}
