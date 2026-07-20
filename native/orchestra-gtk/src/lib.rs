//! Native GTK4 frontend for Orchestra (plan: docs/gtk4-port-plan.md, M1-A3).
//!
//! Library + thin binary split so the modules are unit-testable and the
//! dead-code lint sees the public surface M2 workstreams will consume.

pub mod accounts;
pub mod app;
pub mod backend;
pub(crate) mod backend_fixtures;
pub mod banners;
pub mod ctx;
pub mod daemon;
pub mod dialogs;
pub mod diff;
pub mod icons;
pub mod main_pane;
pub mod modals;
pub mod notify;
pub mod overlays;
pub mod remote_control;
pub mod sidebar;
pub mod sound;
pub mod state;
pub mod terminal;
pub mod toolbar;
pub mod usage_limit;

/// The product version (repo package.json, injected by build.rs — plan §9
/// version lockstep). This is what goes into `hello.appVersion`, the footer,
/// and every backend-version comparison; the crate's own CARGO_PKG_VERSION is
/// deliberately not used anywhere user-visible.
pub fn app_version() -> &'static str {
    env!("ORCHESTRA_APP_VERSION")
}

#[cfg(test)]
mod theme_token_tests {
    /// Every `@define-color` in theme.css, in source order.
    fn token_defs() -> Vec<(String, String)> {
        include_str!("theme.css")
            .lines()
            .map(str::trim)
            .filter_map(|l| l.strip_prefix("@define-color"))
            .filter_map(|rest| {
                let rest = rest.trim().trim_end_matches(';');
                let (name, value) = rest.split_once(char::is_whitespace)?;
                Some((name.trim().to_string(), value.trim().to_string()))
            })
            .collect()
    }

    /// A token defined TWICE silently takes its LAST value — no parser error,
    /// no warning, and every consumer of the first definition changes color.
    /// That is exactly how `accent_2` came to render #7c6ef2 (a value present
    /// nowhere in the Electron renderer) instead of the canonical #8b7cff:
    /// a later section re-declared it, and nothing failed.
    ///
    /// This is the mechanical form of "tokens are declared in §1 only" —
    /// a convention nobody can enforce by reading becomes a gate anyone runs.
    #[test]
    fn no_token_is_defined_twice() {
        let defs = token_defs();
        // Guard the instrument: if the parser silently matched nothing, an
        // empty set would pass this test while proving nothing at all.
        assert!(
            defs.len() >= 14,
            "parsed only {} @define-color lines — the extractor is broken, \
             not the stylesheet",
            defs.len()
        );

        let mut seen: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
        let mut dupes = Vec::new();
        for (name, value) in &defs {
            if let Some(first) = seen.insert(name, value) {
                dupes.push(format!("{name}: {first} then {value} (the LAST one wins)"));
            }
        }
        assert!(
            dupes.is_empty(),
            "theme.css defines these tokens more than once, so the earlier \
             definition is dead and its consumers silently changed color:\n  {}",
            dupes.join("\n  ")
        );
    }

    /// The shared tokens must equal the renderer's `:root` values verbatim —
    /// these were confirmed against Electron's COMPUTED styles over CDP, so a
    /// drift here is a real visible divergence, not a notation difference.
    #[test]
    fn shared_tokens_match_the_renderer() {
        const EXPECTED: &[(&str, &str)] = &[
            ("bg", "#0b0d10"),
            ("bg_2", "#12151a"),
            ("bg_3", "#1a1f26"),
            ("bg_4", "#222933"),
            ("border", "#242a33"),
            ("border_strong", "#333b47"),
            ("text", "#e6e9ef"),
            ("text_dim", "#8b95a7"),
            ("accent", "#6ea8ff"),
            ("accent_strong", "#4a8cff"),
            ("accent_bright", "#7ab4ff"),
            ("accent_ink", "#081022"),
            ("accent_2", "#8b7cff"),
            ("green", "#5bd68b"),
            ("red", "#ff6b6b"),
            ("yellow", "#ffc857"),
            ("scratch", "#e3b341"),
            ("orchestrator", "#7ee787"),
        ];
        let defs = token_defs();
        for (name, want) in EXPECTED {
            let got = defs
                .iter()
                .find(|(n, _)| n == name)
                .unwrap_or_else(|| panic!("token @{name} is missing from theme.css"));
            assert_eq!(
                &got.1, want,
                "@{name} drifted from the renderer's --{}",
                name.replace('_', "-")
            );
        }
    }
}

#[cfg(test)]
mod version_tests {
    /// Drift gate for the lockstep: the compiled-in version must match the
    /// repo package.json this test reads at run time.
    #[test]
    fn lockstep_version_matches_package_json() {
        let raw =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../package.json"))
                .expect("repo package.json readable");
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(super::app_version(), parsed["version"].as_str().unwrap());
    }
}
