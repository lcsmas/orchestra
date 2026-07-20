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
mod type_scale_tests {
    /// `font-size` for every rule whose selector is a BARE single class
    /// (`.ws-sub { … }`). Those are the rules directly comparable to the
    /// renderer's, because neither side needs cascade modelling to resolve
    /// them. Returns (class, value) in source order; a later rule for the same
    /// class overwrites an earlier one, which is what GTK itself does.
    fn bare_class_font_sizes() -> std::collections::HashMap<String, String> {
        let css = include_str!("theme.css");
        // Strip comments first: a commented-out declaration is not a rule, and
        // counting one would make this gate fire on dead text.
        let mut clean = String::with_capacity(css.len());
        let mut rest = css;
        while let Some(start) = rest.find("/*") {
            clean.push_str(&rest[..start]);
            match rest[start..].find("*/") {
                Some(end) => rest = &rest[start + end + 2..],
                None => {
                    rest = "";
                    break;
                }
            }
        }
        clean.push_str(rest);

        let mut out = std::collections::HashMap::new();
        for block in clean.split('}') {
            let Some((selectors, body)) = block.split_once('{') else {
                continue;
            };
            // Only single-class selectors: no descendants, no states, no
            // element prefixes. `.a, .b { }` contributes both .a and .b.
            let Some(size) = body
                .split(';')
                .filter_map(|d| d.split_once(':'))
                .filter(|(p, _)| p.trim() == "font-size")
                .map(|(_, v)| v.trim().to_string())
                .next_back()
            else {
                continue;
            };
            for sel in selectors.split(',') {
                let sel = sel.trim();
                let Some(class) = sel.strip_prefix('.') else {
                    continue;
                };
                if class
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                {
                    out.insert(class.to_string(), size.clone());
                }
            }
        }
        out
    }

    /// The type scale drifted on 34 shared selectors before this gate existed,
    /// and none of it failed anything: `cargo build` does not read theme.css,
    /// and the token test above covers COLOR only. The defects clustered in
    /// Resources / Insights / Help — surfaces that render but that no test
    /// had ever measured.
    ///
    /// Values are Electron's, taken from `src/renderer/styles.css` (the same
    /// bare-single-class rules) and cross-checked against computed styles.
    #[test]
    fn shared_font_sizes_match_the_renderer() {
        // (class, Electron's font-size). Half-pixel values are intentional and
        // GTK renders them — several already shipped (.env-notice-title 11.5px).
        const EXPECTED: &[(&str, &str)] = &[
            ("account-badge", "10.5px"),
            ("account-field-label", "10.5px"),
            ("account-inherit-empty", "11.5px"),
            ("account-inherit-group-label", "10.5px"),
            ("help-panel-title", "12px"),
            ("help-view-sub", "11px"),
            ("insights-panel-meta", "11px"),
            ("insights-panel-title", "12px"),
            ("insights-view-sub", "11px"),
            ("pr-badge", "9px"),
            ("res-account-name", "12px"),
            ("res-agent-branch", "12px"),
            ("res-cell", "11px"),
            ("res-empty", "12px"),
            ("res-live", "10px"),
            ("res-meter-label", "9px"),
            ("res-procs-empty", "10px"),
            ("res-table-head", "9px"),
            ("res-tile-label", "10px"),
            ("res-tile-sub", "11px"),
            ("res-tile-value", "22px"),
            ("sound-desc", "11px"),
            ("usage-bars-panel-title", "10px"),
            ("usage-bars-row-status", "10px"),
            ("ws-hidden-count", "9px"),
            ("ws-sub", "11px"),
            // Split out of grouped rules: Electron sizes each member
            // differently, so one shared rule cannot express both.
            ("branch-empty", "12px"),
            ("branch-error", "11px"),
            ("usage-row-bar-label", "9px"),
            ("usage-row-pct", "10px"),
            // Were relative `em`, which float with the inherited base and so
            // cannot be verified against a fixed px reference at all.
            ("diff-indicator", "11px"),
            ("queue-banner-item-text", "11.5px"),
            ("queue-banner-sub", "11.5px"),
            ("setup-banner-log", "11.5px"),
            ("setup-banner-sub", "11.5px"),
            // Controls: these already matched before the sweep. They are here
            // so a regression in the UNCHANGED majority also fails, rather
            // than only the rules this pass happened to touch.
            ("ws-name", "12px"),
            ("env-notice-title", "11.5px"),
            ("field-textarea", "12.5px"),
        ];

        let sizes = bare_class_font_sizes();
        // Guard the instrument: an extractor that silently matched nothing
        // would pass every assertion below while proving nothing.
        assert!(
            sizes.len() >= 80,
            "parsed only {} bare-class font-size rules — the extractor is \
             broken, not the stylesheet",
            sizes.len()
        );

        let mut wrong = Vec::new();
        for (class, want) in EXPECTED {
            match sizes.get(*class) {
                Some(got) if got == want => {}
                Some(got) => wrong.push(format!(".{class}: want {want}, theme.css has {got}")),
                None => wrong.push(format!(".{class}: no bare-class font-size rule at all")),
            }
        }
        assert!(
            wrong.is_empty(),
            "the GTK type scale drifted from the Electron renderer on {} \
             selector(s):\n  {}",
            wrong.len(),
            wrong.join("\n  ")
        );
    }

    /// A relative font-size cannot be compared to Electron's absolute px, and
    /// it silently rescales whenever an ancestor's size changes. The sweep
    /// converted every such rule that had a renderer counterpart; this keeps
    /// new ones from appearing on those selectors.
    #[test]
    fn shared_selectors_do_not_use_relative_font_sizes() {
        let sizes = bare_class_font_sizes();
        assert!(sizes.len() >= 80, "extractor is broken, not the stylesheet");

        let relative: Vec<_> = sizes
            .iter()
            .filter(|(_, v)| v.ends_with("em") || v.ends_with('%'))
            .map(|(k, v)| format!(".{k}: {v}"))
            .collect();

        // Rules with no Electron counterpart are out of scope for parity and
        // are listed explicitly, so adding a new one is a deliberate act.
        const KNOWN_GTK_ONLY: &[&str] = &[
            "empty-title",
            "branch-hint",
            "diff-file-name",
            "diff-trunc-notice",
            "sandbox-control-text",
            "merge-pill-label",
            // No `.diff-status-title` rule exists in the renderer at all.
            "diff-status-title",
        ];
        let unexpected: Vec<_> = relative
            .iter()
            .filter(|r| {
                let class = r.trim_start_matches('.').split(':').next().unwrap_or("");
                !KNOWN_GTK_ONLY.contains(&class)
            })
            .collect();

        assert!(
            unexpected.is_empty(),
            "these selectors use a relative font-size, so they cannot be held \
             to Electron's absolute values:\n  {unexpected:?}"
        );
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
