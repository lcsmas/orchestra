//! Language guess for the diff panes — the GtkSourceView-id analog of
//! DiffView.tsx's `guessLanguage` extension table. The widget resolves the id
//! through `sourceview5::LanguageManager` (and falls back to the manager's
//! own filename glob matching for anything not in the table), but the table
//! itself stays pure so it unit-tests without a display.

/// GtkSourceView language id for a file path, from its extension — mirrors
/// the Electron table (DiffView.tsx `guessLanguage`) translated to the ids
/// GtkSourceView 5 ships. None = let the LanguageManager's glob matching (or
/// plain text) take over.
pub fn language_id_for_path(path: &str) -> Option<&'static str> {
    let (_, ext) = path.rsplit_once('.')?;
    let ext = ext.to_ascii_lowercase();
    // The Electron map's monaco ids, translated to GtkSourceView lang-spec ids
    // (`typescript` → `typescript`, `shell` → `sh`, …). Keys match 1:1.
    Some(match ext.as_str() {
        "ts" => "typescript",
        "tsx" => "typescript-jsx",
        "js" => "js",
        "jsx" => "jsx",
        "json" => "json",
        "md" => "markdown",
        "py" => "python3",
        "go" => "go",
        "rs" => "rust",
        "java" => "java",
        "rb" => "ruby",
        "css" => "css",
        "scss" => "scss",
        "html" => "html",
        "yml" | "yaml" => "yaml",
        "sh" => "sh",
        "sql" => "sql",
        "toml" => "toml",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_the_electron_table() {
        assert_eq!(language_id_for_path("src/main.rs"), Some("rust"));
        assert_eq!(language_id_for_path("src/shared/types.ts"), Some("typescript"));
        assert_eq!(language_id_for_path("App.tsx"), Some("typescript-jsx"));
        assert_eq!(language_id_for_path("a/b/util.js"), Some("js"));
        assert_eq!(language_id_for_path("conf.yml"), Some("yaml"));
        assert_eq!(language_id_for_path("conf.yaml"), Some("yaml"));
        assert_eq!(language_id_for_path("run.sh"), Some("sh"));
        assert_eq!(language_id_for_path("Cargo.toml"), Some("toml"));
        assert_eq!(language_id_for_path("script.py"), Some("python3"));
    }

    #[test]
    fn is_case_insensitive_on_the_extension() {
        assert_eq!(language_id_for_path("README.MD"), Some("markdown"));
    }

    #[test]
    fn unknown_or_missing_extension_is_none() {
        assert_eq!(language_id_for_path("Makefile"), None);
        assert_eq!(language_id_for_path("weird.xyz"), None);
        assert_eq!(language_id_for_path(""), None);
    }
}
