//! Icon assets — the GTK counterpart to Electron's inline SVG components.
//!
//! # Why this exists
//!
//! Electron hand-writes its icons as inline `<svg>` in the React components
//! (`src/renderer/components/Sidebar.tsx` alone defines 21 of them) and
//! recolours each one through `fill="currentColor"` / `stroke="currentColor"`,
//! so a single asset tracks whatever `color` the surrounding CSS resolves to.
//!
//! Before this module the GTK port had no icons at all — it substituted *text
//! glyphs* for them (`⑃` for a git branch, `⎇` for the branch picker, `🌿`/`⚡`
//! for the orchestrator/scratch chips). Those resolve through whatever font
//! happens to carry the codepoint, which is why they rendered at inconsistent
//! weights and sizes and read as "ugly" next to Electron. Note `⑃` is
//! OCR INVERTED FORK and `⎇` is ALTERNATIVE KEY SYMBOL — neither is a git
//! glyph; they merely look vaguely branch-shaped in some fonts.
//!
//! # Mechanism, and why this one
//!
//! The SVGs in `icons/` are compiled into a GResource by `build.rs` and
//! embedded in the binary. [`register`] hooks that resource into the default
//! [`gtk::IconTheme`], after which any widget can name an icon and GTK
//! resolves it — [`gtk::Image::from_icon_name`], `set_icon_name`, and so on.
//!
//! Two properties drove the choice:
//!
//! 1. **Self-contained.** A filesystem icon search path would need the assets
//!    shipped alongside the binary, so a packaging slip becomes a runtime UI
//!    defect. Embedding removes that failure mode. (`build.rs` already embeds
//!    the chime WAVs for the same reason.)
//!
//!    A note on *how* a missing icon fails, because an earlier revision of this
//!    comment had it backwards and the difference decides how you test: GTK
//!    does **not** draw blank. It substitutes its own broken-image placeholder,
//!    which is plainly visible. Measured under a headless compositor with
//!    `docs/visual-reference/paint-effect-probe.py` (`pad_for` + `_digest`),
//!    against a known-good stock icon in the same run:
//!
//!    | icon | ink |
//!    |---|---:|
//!    | stock `document-open-symbolic` (known-good) | 141 |
//!    | a name in no theme (`orch-zzznonsense-symbolic`) | **162** |
//!
//!    So a typo'd name is loud, not silent. The consequence for the test below
//!    is that "the icon drew something" proves nothing on its own — the
//!    placeholder draws something too — which is why the bundle-enumeration
//!    test checks *presence in the bundle* rather than sampling pixels.
//! 2. **Recolouring.** Every asset is named `*-symbolic`. GTK recolours a
//!    symbolic icon to the widget's CSS `color`, which is the direct analogue
//!    of Electron's `currentColor` and the reason one asset can serve the
//!    dim/hover/accent states of a button instead of needing three. This is a
//!    *naming convention*, not a flag: drop the suffix and the icon still
//!    renders, still parses, and silently stops tracking the theme.
//!
//! Deliberately NOT used: `gtk::IconTheme::add_search_path` (not
//! self-contained, per 1) and a hand-rolled `Paintable` over librsvg (this
//! crate doesn't link librsvg, and it would reimplement what the IconTheme
//! already does).

use gtk::{gio, glib};

/// The GResource prefix `build.rs` bundles the icons under. GTK appends its
/// own `icons/<theme>/<size>/` convention to an icon-theme resource path, so
/// this is the parent of the `scalable/actions` directory in the bundle.
const RESOURCE_PATH: &str = "/dev/orchestra/gtk";

/// The compiled GResource bundle (built from `icons/*.svg` by `build.rs`).
const ICON_BUNDLE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/icons.gresource"));

// Icon names. Constants rather than bare strings at the call sites: a typo'd
// name draws GTK's broken-image placeholder (see the module docs), which is
// only caught if someone happens to look at that widget in that state. The
// compiler catching it is cheaper.
//
// Each maps to the Electron component it was lifted from; the path data is
// copied verbatim, only the wrapper differs.

// -- toolbar --------------------------------------------------------------
/// Git branch mark — `BranchIcon` (BranchPicker.tsx). Replaces `⑃` and `⎇`.
pub const BRANCH: &str = "orch-branch-symbolic";
/// Dropdown caret on the branch chip — the 12×12 chevron in BranchPicker.tsx.
pub const CARET_DOWN: &str = "orch-caret-down-symbolic";
/// Restart-agent circular arrow — App.tsx toolbar.
pub const RESTART: &str = "orch-restart-symbolic";
/// Run-script play triangle — App.tsx toolbar.
pub const PLAY: &str = "orch-play-symbolic";
/// Run-script stop square — App.tsx toolbar.
pub const STOP: &str = "orch-stop-symbolic";
/// File/nvim pane toggle — App.tsx toolbar.
pub const PANE: &str = "orch-pane-symbolic";
/// Pull-request mark — the `button.pr-link::before` mask (styles.css:201-207).
pub const PR: &str = "orch-pr-symbolic";
/// External-link arrow — the `button.pr-link::after` mask (styles.css:210-217).
pub const EXTERNAL: &str = "orch-external-symbolic";

// -- sidebar --------------------------------------------------------------
/// Scratch-session bolt — `ZapIcon`. Replaces the `⚡` literal.
pub const ZAP: &str = "orch-zap-symbolic";
/// Orchestrator network node — `OrchestratorIcon`. Replaces the `🌿` literal.
pub const ORCHESTRATOR: &str = "orch-orchestrator-symbolic";
/// Repo scripts gear — `GearIcon`. Replaces the `⚙` literal.
pub const GEAR: &str = "orch-gear-symbolic";
/// GitHub mark — `GitHubIcon`. Replaces the `↗` literal.
pub const GITHUB: &str = "orch-github-symbolic";
/// Delete/remove — `TrashIcon`.
pub const TRASH: &str = "orch-trash-symbolic";
/// Add-repo folder — `FolderPlusIcon`.
pub const FOLDER_PLUS: &str = "orch-folder-plus-symbolic";
/// Archive — `ArchiveIcon`. Replaces the `🗄` literal.
pub const ARCHIVE: &str = "orch-archive-symbolic";
/// Restore-from-archive — `RestoreIcon`. Replaces the `↺` literal.
pub const RESTORE: &str = "orch-restore-symbolic";
/// Branch-picker search magnifier — `SearchIcon`.
pub const SEARCH: &str = "orch-search-symbolic";
/// Close/dismiss — replaces the `✕` literals.
pub const CLOSE: &str = "orch-close-symbolic";
/// Add — replaces the bare `+` character used as an icon.
pub const PLUS: &str = "orch-plus-symbolic";
/// Sandbox import — `SandboxUploadIcon`.
pub const SANDBOX_UP: &str = "orch-sandbox-up-symbolic";
/// Sandbox eject — `SandboxDownloadIcon`.
pub const SANDBOX_DOWN: &str = "orch-sandbox-down-symbolic";

// -- sidebar header / overlay entry points --------------------------------
/// Sound settings bell — `BellIcon`.
pub const BELL: &str = "orch-bell-symbolic";
/// Help — `HelpIcon` (Help.tsx).
pub const HELP: &str = "orch-help-symbolic";
/// Resources sparkline — `ResourcesIcon`.
pub const RESOURCES: &str = "orch-resources-symbolic";
/// Insights sparkle — `SparkleIcon` (Insights.tsx).
pub const INSIGHTS: &str = "orch-insights-symbolic";
/// Accounts — `UsersIcon`.
pub const USERS: &str = "orch-users-symbolic";
/// Logs — `LogsIcon`.
pub const LOGS: &str = "orch-logs-symbolic";

/// Register the embedded icon bundle with the default [`gtk::IconTheme`].
///
/// Must run after `gtk::init` (the default theme needs a display) and before
/// any widget names an icon. Idempotent: re-registering the same resource is
/// harmless, and `add_resource_path` de-duplicates.
///
/// # Panics
///
/// If the bundle fails to parse — that means `build.rs` produced a corrupt
/// GResource, which would otherwise surface as every icon in the app rendering
/// a broken-image placeholder. Failing loudly at startup is the point.
pub fn register() {
    let bytes = glib::Bytes::from_static(ICON_BUNDLE);
    let resource = gio::Resource::from_data(&bytes).expect("embedded icon GResource parses");
    gio::resources_register(&resource);

    if let Some(display) = gtk::gdk::Display::default() {
        gtk::IconTheme::for_display(&display).add_resource_path(RESOURCE_PATH);
    }
}

/// A [`gtk::Image`] for `name`, sized to the icon's natural 16px box.
///
/// Prefer this over `Image::from_icon_name` at call sites so the pixel size is
/// applied consistently — GTK's default icon size is 16 but a themed widget can
/// scale it, and the toolbar/sidebar chrome wants a fixed size like Electron's
/// explicit `width`/`height` attributes.
pub fn image(name: &str) -> gtk::Image {
    let img = gtk::Image::from_icon_name(name);
    img.set_pixel_size(16);
    img
}

/// A [`gtk::Image`] for `name` at an explicit pixel size.
///
/// Electron sets a per-icon `width`/`height` (13px on sidebar row actions,
/// 14–16px in the toolbar); this mirrors that rather than scaling every icon to
/// one size.
pub fn image_sized(name: &str, px: i32) -> gtk::Image {
    let img = gtk::Image::from_icon_name(name);
    img.set_pixel_size(px);
    img
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every name a call site can use must exist in the bundle.
    ///
    /// A missing name does not draw blank — GTK substitutes a visible
    /// broken-image placeholder (measured: ink 162 vs 141 for a real icon; see
    /// the module docs). That makes a typo *visible*, but only to someone
    /// looking at that widget in that state; a name used on a rarely-shown
    /// button would still ship broken. Enumerating the bundle turns that into
    /// a build failure instead of a review-by-eyeball.
    #[test]
    fn every_named_icon_is_in_the_bundle() {
        let bytes = glib::Bytes::from_static(ICON_BUNDLE);
        let resource = gio::Resource::from_data(&bytes).expect("bundle parses");
        let dir = "/dev/orchestra/gtk/icons/scalable/actions";
        let present: Vec<String> = resource
            .enumerate_children(dir, gio::ResourceLookupFlags::NONE)
            .expect("bundle has the icon directory")
            .into_iter()
            .map(|s| s.trim_end_matches(".svg").to_string())
            .collect();

        // Positive control: the enumeration found *something*. Without this an
        // empty bundle would make every assertion below vacuously... fail, but
        // more importantly it proves the lookup path itself is right.
        assert!(
            !present.is_empty(),
            "no icons enumerated under {dir} — the resource path is wrong"
        );

        let named = [
            BRANCH,
            CARET_DOWN,
            RESTART,
            PLAY,
            STOP,
            PANE,
            PR,
            EXTERNAL,
            ZAP,
            ORCHESTRATOR,
            GEAR,
            GITHUB,
            TRASH,
            FOLDER_PLUS,
            ARCHIVE,
            RESTORE,
            SEARCH,
            CLOSE,
            PLUS,
            SANDBOX_UP,
            SANDBOX_DOWN,
            BELL,
            HELP,
            RESOURCES,
            INSIGHTS,
            USERS,
            LOGS,
        ];
        for name in named {
            assert!(
                present.iter().any(|p| p == name),
                "icon {name} is named in code but absent from the bundle; \
                 it would silently draw nothing. present: {present:?}"
            );
        }

        // Negative control: a name that is NOT in the bundle must be reported
        // absent. Without this, a lookup that returned "everything matches"
        // would pass the loop above and prove nothing.
        assert!(
            !present.iter().any(|p| p == "orch-zzznonsense-symbolic"),
            "absent-icon check is broken — it matched a name that does not exist"
        );
    }

    /// Every shipped asset carries `currentColor`, the property GTK's symbolic
    /// recolouring keys on. An asset with a hardcoded colour still renders —
    /// it just silently ignores the theme, which is invisible against a dark
    /// UI where "slightly wrong grey" looks fine.
    #[test]
    fn every_asset_uses_currentcolor_and_symbolic_naming() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/icons");
        let mut checked = 0;
        for entry in std::fs::read_dir(dir).expect("icons/ readable") {
            let path = entry.expect("dir entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("svg") {
                continue;
            }
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            assert!(
                name.ends_with("-symbolic"),
                "{name}: assets must end in -symbolic or GTK will not recolour them"
            );
            let body = std::fs::read_to_string(&path).expect("asset readable");
            assert!(
                body.contains("currentColor"),
                "{name}: no currentColor — this icon would render in a fixed \
                 colour and silently ignore the widget's CSS color"
            );
            checked += 1;
        }
        assert!(checked > 0, "no assets checked — icons/ is empty?");
    }
}
