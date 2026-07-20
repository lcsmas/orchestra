//! App-font loading (plan §5.2): register the bundled "Orchestra Symbols"
//! subset with fontconfig so VTE renders the circled-number status glyphs
//! (①②③ …, U+2460+) at the correct MONOSPACE advance.
//!
//! Without it those code points fall back to a proportional system font whose
//! 1em advance gets squished by VTE's cell rescale — the exact bug fixed in the
//! Electron renderer by bundling the same subset (the glyphs carry a 0.6em mono
//! advance). JetBrains Mono itself is resolved by name from the system.
//!
//! fontconfig has no gtk4-rs wrapper for app fonts, so we bind the two C
//! entry points directly. libfontconfig is already linked transitively through
//! pango/gtk, so no extra link flags are needed.

use std::ffi::c_void;
use std::os::raw::{c_char, c_int};

/// The subset TTF, embedded so the binary is self-contained.
const ORCHESTRA_SYMBOLS_TTF: &[u8] = include_bytes!("../../assets/fonts/orchestra-symbols.ttf");

/// Inter — the UI face, embedded for the same reason the symbol subset is.
///
/// The Electron renderer pulls Inter from Google Fonts in `index.html`, so its
/// UI text is Inter on any machine with a network. Nothing equivalent existed
/// here: `theme.css` declared no font-family at all, so every label fell
/// through to the gtk-font-name setting (Adwaita Sans on this box). That is a
/// whole-app typeface difference — measured Inter vs Adwaita Sans on all 21
/// text roles shared by the two frontends — and it is invisible to a CSS diff
/// because the divergence is in a rule that ISN'T THERE.
///
/// Bundling rather than depending on the system: Inter is not a Fedora default
/// (fontconfig on this machine has zero Inter entries across 2673 fonts), so a
/// system dependency would silently fall back to Adwaita Sans again on exactly
/// the machines the bug was reported from. These are the four upright weights
/// the renderer's stylesheet actually requests (400/500/600/700); italics and
/// the Display optical size are omitted because no rule asks for them.
/// SIL OFL 1.1, same terms as the symbol subset — see Inter-OFL.txt.
const INTER_FACES: &[(&str, &[u8])] = &[
    (
        "Inter-Regular.ttf",
        include_bytes!("../../assets/fonts/Inter-Regular.ttf"),
    ),
    (
        "Inter-Medium.ttf",
        include_bytes!("../../assets/fonts/Inter-Medium.ttf"),
    ),
    (
        "Inter-SemiBold.ttf",
        include_bytes!("../../assets/fonts/Inter-SemiBold.ttf"),
    ),
    (
        "Inter-Bold.ttf",
        include_bytes!("../../assets/fonts/Inter-Bold.ttf"),
    ),
];

unsafe extern "C" {
    /// `FcConfigGetCurrent()` — the process's current global config.
    fn FcConfigGetCurrent() -> *mut c_void;
    /// `FcConfigAppFontAddFile()` — add a font FILE to a config's application
    /// font set (the mem-face variant isn't in fontconfig's public ABI).
    /// Returns FcTrue (1) on success.
    fn FcConfigAppFontAddFile(config: *mut c_void, file: *const c_char) -> c_int;
}

/// Register the bundled fonts with fontconfig's application font set for this
/// process: Orchestra Symbols (terminal glyphs) and the four Inter weights the
/// UI is styled in. Call once, BEFORE the stylesheet is applied and before the
/// first terminal is built — a `font-family: Inter` rule that resolves before
/// the face is registered falls back permanently for that widget.
///
/// Best-effort per face: a failure means that face falls back (a cosmetic
/// regression, never a crash), so errors are logged, not propagated. Each face
/// is reported by name so a silent partial failure — three weights registered
/// and one not, which renders as one stray weight — is visible in the log
/// rather than showing up later as an unexplained typeface difference.
pub fn load_app_fonts() {
    if let Err(e) = register("orchestra-symbols.ttf", ORCHESTRA_SYMBOLS_TTF) {
        eprintln!("[fonts] Orchestra Symbols not registered: {e}");
    }
    for (name, bytes) in INTER_FACES {
        if let Err(e) = register(name, bytes) {
            eprintln!("[fonts] {name} not registered: {e}");
        }
    }
}

fn register(file_name: &str, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let dir = std::env::temp_dir().join("orchestra-gtk-fonts");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(file_name);
    // Rewrite each launch (cheap) so a truncated prior write can't stick.
    let mut f = std::fs::File::create(&path)?;
    f.write_all(bytes)?;
    drop(f);
    let c_path = std::ffi::CString::new(path.to_string_lossy().as_bytes())
        .map_err(|_| std::io::Error::other("font path has interior NUL"))?;
    let ok = unsafe { FcConfigAppFontAddFile(FcConfigGetCurrent(), c_path.as_ptr()) };
    if ok == 0 {
        return Err(std::io::Error::other("FcConfigAppFontAddFile failed"));
    }
    Ok(())
}
