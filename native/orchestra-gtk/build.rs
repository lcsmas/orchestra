// Version lockstep (plan §9): the GTK app carries the REPO version — the one
// bump in package.json versions both artifacts. build.rs reads it at compile
// time and exposes it as ORCHESTRA_APP_VERSION; code uses
// `crate::app_version()` (never CARGO_PKG_VERSION, which is the crate's own
// 0.1.x and deliberately not the product version).

use std::path::Path;

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let pkg = Path::new(&manifest).join("../../package.json");
    println!("cargo:rerun-if-changed={}", pkg.display());
    let raw = std::fs::read_to_string(&pkg)
        .unwrap_or_else(|e| panic!("cannot read {} for version lockstep: {e}", pkg.display()));
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).expect("repo package.json parses as JSON");
    let version = parsed["version"]
        .as_str()
        .expect("repo package.json has a string version field");
    println!("cargo:rustc-env=ORCHESTRA_APP_VERSION={version}");
}
