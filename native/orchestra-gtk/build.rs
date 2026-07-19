//! Link `libfontconfig` for the app-font registration in `terminal::fonts`
//! (fontconfig is present transitively via pango but not on the link line, so
//! its `FcConfig*` symbols are otherwise undefined). It ships with GTK/pango,
//! so no localdeps addition is needed — just the link flag.
fn main() {
    // Link by exact soname (`-l:libfontconfig.so.1`) rather than `-lfontconfig`:
    // the rootless localdeps prefix has no `-devel` `libfontconfig.so` symlink,
    // so the plain `-l` form can't resolve. The soname is ABI-stable.
    println!("cargo:rustc-link-arg=-l:libfontconfig.so.1");
}
