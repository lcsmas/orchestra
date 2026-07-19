//! Frontend UI state persisted to `$ORCHESTRA_HOME/gtk-ui-state.json`
//! (plan §5.6 — the localStorage-parity file; M1 carries the skeleton subset,
//! M2 workstreams add their fields here).
//!
//! Pure module: no GTK, so it unit-tests without a display. Debouncing lives
//! at the call site (app.rs) — this file only knows how to load and save.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UiState {
    pub sidebar_width: Option<i32>,
    pub window: Option<WindowGeometry>,
    pub last_active_workspace: Option<String>,
    /// Chime id from the sound picker (plan §5.5); None = default (`knock`).
    pub notification_sound: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowGeometry {
    pub width: i32,
    pub height: i32,
    pub maximized: bool,
}

/// `$ORCHESTRA_HOME`, else `~/.orchestra` — same resolution the backend uses
/// for the `ui-sock` pointer (docs/ui-rpc-protocol.md §1).
pub fn orchestra_home() -> PathBuf {
    if let Some(home) = std::env::var_os("ORCHESTRA_HOME") {
        return PathBuf::from(home);
    }
    let user_home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    user_home.join(".orchestra")
}

pub fn state_path(home: &Path) -> PathBuf {
    home.join("gtk-ui-state.json")
}

impl UiState {
    /// Missing, unreadable, or corrupt file → defaults. State is a cache of
    /// UI preferences; losing it must never be fatal.
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Atomic write (tmp + rename) so a crash mid-save can't corrupt the file.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        let json = serde_json::to_vec_pretty(self).expect("UiState always serializes");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(test: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("orch-gtk-state-{}-{test}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn roundtrips_through_disk() {
        let dir = temp_dir("roundtrip");
        let path = state_path(&dir);
        let state = UiState {
            sidebar_width: Some(312),
            window: Some(WindowGeometry {
                width: 1400,
                height: 900,
                maximized: false,
            }),
            last_active_workspace: Some("ws-2".into()),
            notification_sound: Some("tada".into()),
        };
        state.save(&path).unwrap();
        assert_eq!(UiState::load(&path), state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_yields_defaults() {
        assert_eq!(
            UiState::load(Path::new("/nonexistent/gtk-ui-state.json")),
            UiState::default()
        );
    }

    #[test]
    fn corrupt_file_yields_defaults() {
        let dir = temp_dir("corrupt");
        let path = state_path(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(UiState::load(&path), UiState::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tolerates_fields_from_newer_versions() {
        let raw = r#"{"sidebarWidth": 280, "someM2Field": {"x": 1}}"#;
        let state: UiState = serde_json::from_str(raw).unwrap();
        assert_eq!(state.sidebar_width, Some(280));
    }
}
