//! Pure ports of the accounts/usage display logic (plan §5.4). Behavioral
//! sources of truth: `AccountBadge.tsx` (loginColor, severity, token/age
//! formats, error vocabulary), `UsageBars.tsx` (countdowns, updated-ago,
//! panel row sorting) and `accounts.ts:expandConfigDir`. Every port is
//! locked to the TS originals with parity vectors computed by running the
//! actual TS expressions under node — if a test here fails after editing,
//! the two apps have visibly diverged.
//!
//! No GTK in this module: everything unit-tests without a display.

use std::collections::HashMap;

use orchestra_rpc::types::UsageErrorKind;

/// `loginColor` (`AccountBadge.tsx:39`): stable, distinct color per login
/// name. MUST hash identically to the TS — same account, same hue in both
/// apps. JS iterates UTF-16 code units (`charCodeAt`) with 32-bit signed
/// wrap-around (`| 0`), so we hash `encode_utf16()`, not bytes or chars.
pub fn login_color(name: &str) -> String {
    let mut hash: i32 = 0;
    for unit in name.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as i32);
    }
    // JS `%` truncates toward zero exactly like Rust's, so this double-mod
    // idiom transfers verbatim.
    let hue = ((hash % 360) + 360) % 360;
    format!("hsl({hue}, 55%, 68%)")
}

/// Label of the default (unpinned) login — `DEFAULT_LOGIN_LABEL` in
/// `AccountBadge.tsx:361`. The color hash above is keyed on this string, so
/// it must match the TS constant byte-for-byte.
pub const DEFAULT_LOGIN_LABEL: &str = "default";

/// The same login color as `login_color`, as `#rrggbb` — Pango markup and
/// GTK CSS providers don't take `hsl()`. Saturation/lightness fixed at the
/// TS band (55% / 68%).
pub fn login_color_hex(name: &str) -> String {
    let hsl = login_color(name);
    let hue: f64 = hsl
        .strip_prefix("hsl(")
        .and_then(|s| s.split(',').next())
        .and_then(|h| h.parse().ok())
        .unwrap_or(0.0);
    hsl_to_hex(hue, 55.0, 68.0)
}

/// Standard HSL→RGB, byte-rounded like CSS engines do.
fn hsl_to_hex(h: f64, s: f64, l: f64) -> String {
    let s = s / 100.0;
    let l = l / 100.0;
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - (((h / 60.0) % 2.0) - 1.0).abs());
    let m = l - c / 2.0;
    let (r, g, b) = match h {
        h if h < 60.0 => (c, x, 0.0),
        h if h < 120.0 => (x, c, 0.0),
        h if h < 180.0 => (0.0, c, x),
        h if h < 240.0 => (0.0, x, c),
        h if h < 300.0 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let to = |v: f64| ((v + m) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", to(r), to(g), to(b))
}

/// Clamp a raw 0–100 utilization to an integer percent for display
/// (`clampPct`). `f64::round` matches `Math.round` for every non-negative
/// input; negatives differ on halves but clamp to 0 either way.
pub fn clamp_pct(util: f64) -> u8 {
    (util.round().clamp(0.0, 100.0)) as u8
}

/// Severity band for a percent (`severityClass` / `severityVar`):
/// ≥90 critical, ≥75 warning, else normal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Ok,
    Warn,
    Crit,
}

pub fn severity(pct: u8) -> Severity {
    if pct >= 90 {
        Severity::Crit
    } else if pct >= 75 {
        Severity::Warn
    } else {
        Severity::Ok
    }
}

impl Severity {
    /// CSS class suffix shared by the badge and the bar fill styling.
    pub fn css(self) -> &'static str {
        match self {
            Severity::Ok => "ok",
            Severity::Warn => "warn",
            Severity::Crit => "crit",
        }
    }
}

/// Parse an ISO-8601 timestamp to epoch milliseconds. Stands in for JS
/// `Date.parse`; glib's parser covers the RFC 3339 shapes the usage API
/// emits (`resetsAt` is `''` when unknown → None, matching `Date.parse`'s
/// NaN path).
pub fn parse_iso_ms(iso: &str) -> Option<i64> {
    let dt = gtk::glib::DateTime::from_iso8601(iso, None).ok()?;
    Some(dt.to_unix() * 1000 + i64::from(dt.microsecond()) / 1000)
}

/// `formatResetsIn` (`UsageBars.tsx:38`): "resets in 3h 12m" / "resets in
/// 2d 4h" / "resets now"; empty for an unparseable/empty timestamp.
pub fn format_resets_in(resets_at: &str, now_ms: i64) -> String {
    let Some(target) = parse_iso_ms(resets_at) else {
        return String::new();
    };
    let ms = target - now_ms;
    if ms <= 0 {
        return "resets now".into();
    }
    let mins = ms / 60_000;
    let days = mins / 1440;
    let hours = (mins % 1440) / 60;
    let m = mins % 60;
    if days > 0 {
        format!("resets in {days}d {hours}h")
    } else if hours > 0 {
        format!("resets in {hours}h {m}m")
    } else {
        format!("resets in {m}m")
    }
}

/// `formatUpdatedAgo` (`UsageBars.tsx:55`): snapshot age at minute
/// granularity; empty for a missing/zero timestamp.
pub fn format_updated_ago(fetched_at_ms: i64, now_ms: i64) -> String {
    if fetched_at_ms <= 0 {
        return String::new();
    }
    let mins = (now_ms - fetched_at_ms).max(0) / 60_000;
    if mins < 1 {
        return "updated just now".into();
    }
    let days = mins / 1440;
    let hours = (mins % 1440) / 60;
    let m = mins % 60;
    if days > 0 {
        format!("updated {days}d {hours}h ago")
    } else if hours > 0 {
        format!("updated {hours}h {m}m ago")
    } else {
        format!("updated {m}m ago")
    }
}

/// `ageText` (`AccountBadge.tsx:21`): coarse age for badge tooltips.
pub fn age_text(fetched_at_ms: i64, now_ms: i64) -> String {
    let age_min = (now_ms - fetched_at_ms) / 60_000;
    if age_min <= 0 {
        "just now".into()
    } else {
        format!("{age_min}m ago")
    }
}

/// `formatTokens` (`AccountBadge.tsx:80`): 41679 → "42k", 1240000 → "1.2M".
pub fn format_tokens(n: u64) -> String {
    if n < 1000 {
        return n.to_string();
    }
    if n < 1_000_000 {
        let k = n as f64 / 1000.0;
        return if k < 10.0 {
            format!("{k:.1}k")
        } else {
            format!("{}k", k.round() as u64)
        };
    }
    let m = n as f64 / 1_000_000.0;
    if m < 10.0 {
        format!("{m:.1}M")
    } else {
        format!("{}M", m.round() as u64)
    }
}

/// `errorText` (shared vocabulary of `AccountBadge.tsx:48` and
/// `UsageBars.tsx:69`).
pub fn error_text(kind: Option<UsageErrorKind>) -> &'static str {
    match kind {
        Some(UsageErrorKind::NoScope) => "no usage scope",
        Some(UsageErrorKind::RateLimited) => "rate limited",
        Some(UsageErrorKind::NotLoggedIn) => "not logged in",
        Some(UsageErrorKind::NoDir) => "no config dir",
        _ => "usage unavailable",
    }
}

/// `errorTitle` (`AccountBadge.tsx:63`): the long tooltip explanation.
pub fn error_title(label: &str, kind: Option<UsageErrorKind>) -> String {
    match kind {
        Some(UsageErrorKind::NoScope) => format!(
            "{label}: this account's token lacks the user:profile OAuth scope, so usage can't be read"
        ),
        Some(UsageErrorKind::RateLimited) => {
            format!("{label}: usage endpoint is rate-limiting us — will retry")
        }
        Some(UsageErrorKind::NotLoggedIn) => format!(
            "{label}: no login found in this account's config dir — use the Login button in account settings"
        ),
        Some(UsageErrorKind::NoDir) => format!(
            "{label}: the account's config dir doesn't exist — check the path in account settings"
        ),
        _ => format!("{label}: usage temporarily unavailable"),
    }
}

/// `expandConfigDir` (`accounts.ts:142`): `~`/`${VAR}`/`$VAR` template
/// expansion, unresolved references become ''. Drives the live preview under
/// the config-dir field in AccountsSettings.
pub fn expand_config_dir(template: &str, home: &str, source: &HashMap<String, String>) -> String {
    let trimmed = template.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let with_home = if trimmed == "~" {
        home.to_string()
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else {
        trimmed.to_string()
    };

    // `${NAME}` / `$NAME` with NAME = [A-Za-z_][A-Za-z0-9_]* — a hand-rolled
    // scan of the TS regex so we don't pull in a regex crate for one pattern.
    let mut out = String::with_capacity(with_home.len());
    let bytes = with_home.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'$' {
            let start = i;
            while i < bytes.len() && bytes[i] != b'$' {
                i += 1;
            }
            out.push_str(&with_home[start..i]);
            continue;
        }
        let (name, end) = if bytes.get(i + 1) == Some(&b'{') {
            match scan_var_name(bytes, i + 2) {
                // `${NAME}` must close; an unclosed/empty brace is literal.
                Some(end) if bytes.get(end) == Some(&b'}') => (&with_home[i + 2..end], end + 1),
                _ => {
                    out.push('$');
                    i += 1;
                    continue;
                }
            }
        } else {
            match scan_var_name(bytes, i + 1) {
                Some(end) => (&with_home[i + 1..end], end),
                None => {
                    out.push('$');
                    i += 1;
                    continue;
                }
            }
        };
        if let Some(v) = source.get(name) {
            out.push_str(v);
        }
        i = end;
    }
    out
}

/// Scan a `[A-Za-z_][A-Za-z0-9_]*` identifier starting at `start`; returns
/// the exclusive end index, or None if the first byte doesn't qualify.
fn scan_var_name(bytes: &[u8], start: usize) -> Option<usize> {
    let first = *bytes.get(start)?;
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return None;
    }
    let mut end = start + 1;
    while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
        end += 1;
    }
    Some(end)
}

/// `defaultDirFor` (`AccountsSettings.tsx:65`): label → suggested config dir,
/// e.g. "work" → `~/.claude-work`.
pub fn default_dir_for(label: &str) -> String {
    let lower = label.trim().to_lowercase();
    let mut slug = String::with_capacity(lower.len());
    let mut pending_dash = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-') {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            pending_dash = false;
            slug.push(c);
        } else {
            pending_dash = true;
        }
    }
    let slug = slug.trim_matches('-');
    format!("~/.claude-{slug}")
}

/// The hover panel's ordering (`UsageBars.tsx:351`): active login first, then
/// hotter (max of 5h/7d/fable utilization) first. Rows with no readable usage
/// carry hotness -1 so they sink below live ones.
pub fn row_sort_key(is_active: bool, hotness: f64) -> (i8, i64) {
    // f64 keys aren't Ord; scale to integer per-mille for a total order (the
    // TS comparator subtracts raw floats — utilizations are percentages, so
    // per-mille keeps every meaningful distinction).
    (
        if is_active { 0 } else { 1 },
        -(hotness * 1000.0).round() as i64,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vectors computed by running the literal TS functions under node
    // (see AccountBadge.tsx / UsageBars.tsx / AccountsSettings.tsx).
    #[test]
    fn login_color_matches_ts_hash() {
        let vectors = [
            ("default", "hsl(345, 55%, 68%)"),
            ("work", "hsl(1, 55%, 68%)"),
            ("perso", "hsl(73, 55%, 68%)"),
            ("mc", "hsl(238, 55%, 68%)"),
            ("team-α", "hsl(137, 55%, 68%)"),
            ("émile", "hsl(86, 55%, 68%)"),
            ("日本語", "hsl(143, 55%, 68%)"),
            ("a", "hsl(97, 55%, 68%)"),
            ("", "hsl(0, 55%, 68%)"),
            ("Fable", "hsl(264, 55%, 68%)"),
            ("mobile-club", "hsl(257, 55%, 68%)"),
            // Astral char: JS charCodeAt sees the surrogate pair as two units.
            ("😀cat", "hsl(139, 55%, 68%)"),
            ("Z", "hsl(90, 55%, 68%)"),
        ];
        for (name, expected) in vectors {
            assert_eq!(login_color(name), expected, "loginColor({name:?})");
        }
    }

    #[test]
    fn login_color_hex_matches_css_hsl() {
        // Same hues as the parity vectors above, converted with the standard
        // CSS HSL→RGB formula (vectors from node).
        assert_eq!(login_color_hex("default"), "#da8197"); // hue 345
        assert_eq!(login_color_hex("work"), "#da8281"); // hue 1
        assert_eq!(login_color_hex("perso"), "#c7da81"); // hue 73
        assert_eq!(login_color_hex(""), "#da8181"); // hue 0
        assert_eq!(login_color_hex("mc"), "#8184da"); // hue 238
    }

    #[test]
    fn severity_thresholds() {
        assert_eq!(severity(0), Severity::Ok);
        assert_eq!(severity(74), Severity::Ok);
        assert_eq!(severity(75), Severity::Warn);
        assert_eq!(severity(89), Severity::Warn);
        assert_eq!(severity(90), Severity::Crit);
        assert_eq!(severity(100), Severity::Crit);
    }

    #[test]
    fn clamp_pct_matches_math_round() {
        assert_eq!(clamp_pct(-3.0), 0);
        assert_eq!(clamp_pct(0.4), 0);
        assert_eq!(clamp_pct(0.5), 1);
        assert_eq!(clamp_pct(99.4), 99);
        assert_eq!(clamp_pct(107.0), 100);
    }

    #[test]
    fn format_resets_in_matches_ts() {
        let now = parse_iso_ms("2026-07-18T12:00:00Z").unwrap();
        assert_eq!(
            format_resets_in("2026-07-18T12:05:30Z", now),
            "resets in 5m"
        );
        assert_eq!(
            format_resets_in("2026-07-18T15:12:00Z", now),
            "resets in 3h 12m"
        );
        assert_eq!(
            format_resets_in("2026-07-20T16:30:00Z", now),
            "resets in 2d 4h"
        );
        assert_eq!(format_resets_in("2026-07-18T11:00:00Z", now), "resets now");
        assert_eq!(format_resets_in("garbage", now), "");
        assert_eq!(format_resets_in("", now), "");
    }

    #[test]
    fn format_updated_ago_matches_ts() {
        let now = 1_800_000_000_000_i64;
        assert_eq!(format_updated_ago(0, now), "");
        assert_eq!(format_updated_ago(now - 30_000, now), "updated just now");
        assert_eq!(format_updated_ago(now - 90_000, now), "updated 1m ago");
        assert_eq!(format_updated_ago(now - 3_700_000, now), "updated 1h 1m ago");
        assert_eq!(
            format_updated_ago(now - 90_000_000, now),
            "updated 1d 1h ago"
        );
    }

    #[test]
    fn format_tokens_matches_ts() {
        let vectors: [(u64, &str); 12] = [
            (0, "0"),
            (999, "999"),
            (1000, "1.0k"),
            (9950, "9.9k"),
            (41679, "42k"),
            (99500, "100k"),
            (100_499, "100k"),
            (999_499, "999k"),
            (1_000_000, "1.0M"),
            (1_240_000, "1.2M"),
            (9_950_000, "9.9M"),
            (12_400_000, "12M"),
        ];
        for (n, expected) in vectors {
            assert_eq!(format_tokens(n), expected, "formatTokens({n})");
        }
    }

    #[test]
    fn expand_config_dir_matches_ts() {
        let home = "/home/u";
        let src: HashMap<String, String> = [
            ("HOME".to_string(), "/home/u".to_string()),
            ("ACCT".to_string(), "work".to_string()),
        ]
        .into();
        let x = |t: &str| expand_config_dir(t, home, &src);
        assert_eq!(x(""), "");
        assert_eq!(x("   "), "");
        assert_eq!(x("~"), "/home/u");
        assert_eq!(x("~/.claude-work"), "/home/u/.claude-work");
        assert_eq!(x("~abc"), "~abc"); // ~ only expands as a path segment
        assert_eq!(x("${HOME}/.claude-${ACCT}"), "/home/u/.claude-work");
        assert_eq!(x("$HOME/.claude-$ACCT"), "/home/u/.claude-work");
        assert_eq!(x("$MISSING/x"), "/x"); // unresolved → ''
        assert_eq!(x("${MISSING}"), "");
        assert_eq!(x("a$"), "a$"); // bare $ stays literal
        assert_eq!(x("${"), "${"); // unclosed brace stays literal
        assert_eq!(x("$1x"), "$1x"); // digits can't start a name
        assert_eq!(x("  ~/.claude  "), "/home/u/.claude"); // trimmed
    }

    #[test]
    fn default_dir_for_matches_ts() {
        assert_eq!(default_dir_for("work"), "~/.claude-work");
        assert_eq!(default_dir_for("  Work Stuff "), "~/.claude-work-stuff");
        assert_eq!(default_dir_for("Émile!!"), "~/.claude-mile");
        assert_eq!(default_dir_for(""), "~/.claude-");
        assert_eq!(default_dir_for("a.b_c-d"), "~/.claude-a.b_c-d");
    }

    #[test]
    fn panel_rows_sort_active_first_then_hottest() {
        let mut rows = vec![
            ("cold", row_sort_key(false, 10.0)),
            ("error", row_sort_key(false, -1.0)),
            ("active", row_sort_key(true, 0.0)),
            ("hot", row_sort_key(false, 97.5)),
        ];
        rows.sort_by_key(|(_, k)| *k);
        let order: Vec<_> = rows.iter().map(|(n, _)| *n).collect();
        assert_eq!(order, vec!["active", "hot", "cold", "error"]);
    }

    #[test]
    fn error_vocabulary_matches_ts() {
        assert_eq!(error_text(Some(UsageErrorKind::NoScope)), "no usage scope");
        assert_eq!(
            error_text(Some(UsageErrorKind::RateLimited)),
            "rate limited"
        );
        assert_eq!(
            error_text(Some(UsageErrorKind::NotLoggedIn)),
            "not logged in"
        );
        assert_eq!(error_text(Some(UsageErrorKind::NoDir)), "no config dir");
        assert_eq!(error_text(Some(UsageErrorKind::Error)), "usage unavailable");
        assert_eq!(error_text(None), "usage unavailable");
    }
}
