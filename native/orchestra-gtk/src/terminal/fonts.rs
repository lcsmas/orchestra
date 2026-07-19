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

unsafe extern "C" {
    /// `FcConfigGetCurrent()` — the process's current global config.
    fn FcConfigGetCurrent() -> *mut c_void;
    /// `FcConfigAppFontAddFile()` — add a font FILE to a config's application
    /// font set (the mem-face variant isn't in fontconfig's public ABI).
    /// Returns FcTrue (1) on success.
    fn FcConfigAppFontAddFile(config: *mut c_void, file: *const c_char) -> c_int;
}

/// Register the bundled Orchestra Symbols font with fontconfig's application
/// font set for this process. Call once, before the first terminal is built.
/// Best-effort: a failure just means the status glyphs fall back (a cosmetic
/// regression, never a crash), so errors are logged, not propagated.
pub fn load_app_fonts() {
    if let Err(e) = load_via_tempfile() {
        eprintln!("[fonts] Orchestra Symbols not registered: {e}");
    }
}

fn load_via_tempfile() -> std::io::Result<()> {
    use std::io::Write as _;
    let dir = std::env::temp_dir().join("orchestra-gtk-fonts");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("orchestra-symbols.ttf");
    // Rewrite each launch (cheap) so a truncated prior write can't stick.
    let mut f = std::fs::File::create(&path)?;
    f.write_all(ORCHESTRA_SYMBOLS_TTF)?;
    drop(f);
    let c_path = std::ffi::CString::new(path.to_string_lossy().as_bytes())
        .map_err(|_| std::io::Error::other("font path has interior NUL"))?;
    let ok = unsafe { FcConfigAppFontAddFile(FcConfigGetCurrent(), c_path.as_ptr()) };
    if ok == 0 {
        return Err(std::io::Error::other("FcConfigAppFontAddFile failed"));
    }
    Ok(())
}
