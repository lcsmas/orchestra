//! Native GTK4 frontend for Orchestra (plan: docs/gtk4-port-plan.md, M1-A3).
//!
//! Library + thin binary split so the modules are unit-testable and the
//! dead-code lint sees the public surface M2 workstreams will consume.

pub mod app;
pub mod backend;
pub mod daemon;
pub mod dialogs;
pub mod remote_control;
pub mod state;

/// The product version (repo package.json, injected by build.rs — plan §9
/// version lockstep). This is what goes into `hello.appVersion`, the footer,
/// and every backend-version comparison; the crate's own CARGO_PKG_VERSION is
/// deliberately not used anywhere user-visible.
pub fn app_version() -> &'static str {
    env!("ORCHESTRA_APP_VERSION")
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
