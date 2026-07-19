// Render every chime recipe to `<outdir>/<id>.wav` (48 kHz mono 16-bit).
// Used by E2E scripts to assert the rendered audio; the app itself embeds
// the same bytes via orchestra-gtk's build.rs.

fn main() {
    let outdir = match std::env::args().nth(1) {
        Some(d) => std::path::PathBuf::from(d),
        None => {
            eprintln!("usage: chime-gen <outdir>");
            std::process::exit(2);
        }
    };
    std::fs::create_dir_all(&outdir).expect("create outdir");
    for recipe in chime_gen::recipes() {
        if recipe.id == "none" {
            continue;
        }
        let wav = chime_gen::render_wav(&recipe);
        let path = outdir.join(format!("{}.wav", recipe.id));
        std::fs::write(&path, &wav).expect("write wav");
        println!("{}\t{} bytes\t{}", recipe.id, wav.len(), recipe.name);
    }
}
