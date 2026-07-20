//! App-font loading (plan §5.2): register the bundled "Orchestra Symbols"
//! subset with fontconfig so VTE renders the circled-number status glyphs
//! (①②③ …, U+2460+) at the correct MONOSPACE advance.
//!
//! Without it those code points fall back to a proportional system font whose
//! 1em advance gets squished by VTE's cell rescale — the exact bug fixed in the
//! Electron renderer by bundling the same subset (the glyphs carry a 0.6em mono
//! advance). JetBrains Mono itself is resolved by name from the system.
//!
//! REGISTERING IS ONLY HALF OF IT. Fontconfig will not hand Pango a face nobody
//! asked for, so the subset also has to be NAMED in the font description —
//! that's the second family in [`super::terminal_font`]. For most of this
//! module's life it was registered but unnamed AND mis-named internally, so the
//! very glyphs it exists for still fell back: U+2460 measured 2.22 cells against
//! a 9px cell and overflowed. Both halves are needed; either alone is a no-op.
//!
//! fontconfig has no gtk4-rs wrapper for app fonts, so we bind the two C
//! entry points directly. libfontconfig is already linked transitively through
//! pango/gtk, so no extra link flags are needed.

use std::ffi::c_void;
use std::os::raw::{c_char, c_int};

/// The subset TTF, embedded so the binary is self-contained.
///
/// IF YOU REGENERATE THIS FILE, CHECK ITS INTERNAL FAMILY NAME FIRST:
///
/// ```text
/// fc-query --format '%{family}\n' orchestra-symbols.ttf   # must be "Orchestra Symbols"
/// ```
///
/// The subset is cut from Adwaita Mono and inherited that family name in its
/// `name` table. Fontconfig matches on the INTERNAL name, so while it was
/// called "Adwaita Mono" nothing could request it — [`load_app_fonts`] returned
/// success, the face was registered, the glyphs painted, and only the ADVANCE
/// was wrong (U+2460 measured 2.22 cells against a 9px cell, overflowing and
/// shifting the rest of the line). Every signal short of measuring an advance
/// reported healthy, which is why it survived several review passes.
///
/// The Electron half cannot warn you: its `@font-face` ASSIGNS the family name
/// (`styles.css:28`), so the same mis-named file works there by accident of CSS
/// semantics. Naming it correctly here is what makes `terminal_font()`'s
/// fallback list reachable at all.
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The subset's `name` table must say "Orchestra Symbols".
    ///
    /// This asserts the property that actually broke. Registration succeeding
    /// is NOT the property: while the file was named "Adwaita Mono",
    /// [`load_app_fonts`] returned success and the glyphs painted — only the
    /// advance was wrong. A test gating on registration would have passed for
    /// this bug's entire life, so it gates on the name instead.
    ///
    /// Parsed straight from the embedded bytes rather than via fontconfig, so
    /// it holds in a headless test env with no font config at all.
    #[test]
    fn subset_declares_orchestra_symbols_family() {
        let names = name_table_strings(ORCHESTRA_SYMBOLS_TTF);
        assert!(
            names.iter().any(|n| n == "Orchestra Symbols"),
            "orchestra-symbols.ttf must declare family \"Orchestra Symbols\" — \
             fontconfig matches on the internal name, so a subset still carrying \
             its source family (\"Adwaita Mono\") is unreachable by name and its \
             glyphs fall back at the wrong advance. Found: {names:?}"
        );
        // Negative control: the source family must be gone, otherwise this test
        // would also pass on a file carrying BOTH names.
        assert!(
            !names.iter().any(|n| n == "Adwaita Mono"),
            "subset still carries the source family name: {names:?}"
        );
    }

    /// Every glyph must sit on the 0.6-em monospace advance the cell assumes.
    /// A subset regenerated from a proportional face would break the grid while
    /// still registering and painting fine.
    #[test]
    fn subset_glyphs_are_monospace_advance() {
        let (upem, advances) = hmtx_advances(ORCHESTRA_SYMBOLS_TTF);
        assert_eq!(upem, 1000, "unexpected unitsPerEm");
        for adv in &advances {
            assert_eq!(
                *adv, 600,
                "non-mono advance {adv}/{upem} em in the symbol subset (want 600 = 0.60 em)"
            );
        }
        assert!(!advances.is_empty(), "no advances parsed — probe is broken");
    }

    /// Minimal big-endian TrueType `name`-table reader (IDs 1/4/6/16).
    fn name_table_strings(font: &[u8]) -> Vec<String> {
        let (off, _) = table(font, b"name").expect("name table");
        let count = be16(font, off + 2) as usize;
        let storage = off + be16(font, off + 4) as usize;
        let mut out = Vec::new();
        for i in 0..count {
            let rec = off + 6 + 12 * i;
            let (plat, len, str_off) = (
                be16(font, rec),
                be16(font, rec + 8) as usize,
                be16(font, rec + 10) as usize,
            );
            let bytes = &font[storage + str_off..storage + str_off + len];
            // platform 3 (Windows) is UTF-16BE; platform 1 (Mac) is single-byte.
            let s = if plat == 3 {
                bytes
                    .chunks_exact(2)
                    .map(|c| u16::from_be_bytes([c[0], c[1]]))
                    .collect::<Vec<_>>()
                    .into_iter()
                    .filter_map(|u| char::from_u32(u as u32))
                    .collect()
            } else {
                bytes.iter().map(|&b| b as char).collect::<String>()
            };
            out.push(s);
        }
        out
    }

    /// Returns (unitsPerEm, every advance width in `hmtx`).
    fn hmtx_advances(font: &[u8]) -> (u16, Vec<u16>) {
        let (head, _) = table(font, b"head").expect("head");
        let upem = be16(font, head + 18);
        let (hhea, _) = table(font, b"hhea").expect("hhea");
        let n = be16(font, hhea + 34) as usize;
        let (hmtx, _) = table(font, b"hmtx").expect("hmtx");
        ((upem), (0..n).map(|i| be16(font, hmtx + 4 * i)).collect())
    }

    fn table(font: &[u8], tag: &[u8; 4]) -> Option<(usize, usize)> {
        let n = be16(font, 4) as usize;
        (0..n).find_map(|i| {
            let rec = 12 + 16 * i;
            (&font[rec..rec + 4] == tag)
                .then(|| (be32(font, rec + 8) as usize, be32(font, rec + 12) as usize))
        })
    }

    fn be16(b: &[u8], o: usize) -> u16 {
        u16::from_be_bytes([b[o], b[o + 1]])
    }
    fn be32(b: &[u8], o: usize) -> u32 {
        u32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
    }
}
