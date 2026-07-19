//! Pure helpers shared by the Resources / Insights overlays — the Rust ports
//! of the formatting and coloring functions in `ResourcesView.tsx`,
//! `UsageBars.tsx`, and `AccountBadge.tsx`, plus the per-agent CPU trace ring.
//!
//! Kept dependency-light and unit-tested so the numbers on screen provably
//! match what Electron shows, and so the ring's flatline-decay behavior is
//! pinned regardless of the widget code around it.

/// `HISTORY_LEN` (`ResourcesView.tsx`): 90 samples at the 2s poll = 3 minutes
/// of fleet-CPU sparkline history.
pub const HISTORY_LEN: usize = 90;

/// `SAMPLE_MS` (`ResourcesView.tsx`): the Resources poll cadence, ms.
pub const SAMPLE_MS: u32 = 2000;

/// `formatBytes` (`ResourcesView.tsx`): binary units, one decimal above KB,
/// no decimal for bytes. `0` renders as "0 B".
pub fn format_bytes(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
    if bytes == 0 {
        return "0 B".to_string();
    }
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} {}", value as u64, UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// `formatCpu` (`ResourcesView.tsx`): percent-of-one-core with no decimals;
/// "0%" when idle.
pub fn format_cpu(pct: f64) -> String {
    format!("{}%", pct.round() as i64)
}

/// `formatTokens` (`ResourcesView.tsx`): context token counts as "12.3k" /
/// "1.2M", bare integer below 1000.
pub fn format_tokens(tokens: u64) -> String {
    if tokens >= 1_000_000 {
        format!("{:.1}M", tokens as f64 / 1_000_000.0)
    } else if tokens >= 1000 {
        format!("{:.1}k", tokens as f64 / 1000.0)
    } else {
        tokens.to_string()
    }
}

/// Token-limit severity tiers (`UsageBars.tsx` severityVar): ≥90 red, ≥75
/// yellow, else the accent hue. This is the ONLY place yellow/red are used on
/// the Resources page — CPU/mem stay accent-hued (plan §5.5 color discipline).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Normal,
    Warn,
    Critical,
}

impl Severity {
    pub fn of(utilization: f64) -> Self {
        if utilization >= 90.0 {
            Severity::Critical
        } else if utilization >= 75.0 {
            Severity::Warn
        } else {
            Severity::Normal
        }
    }

    /// CSS class for a usage meter's fill at this severity.
    pub fn meter_class(self) -> &'static str {
        match self {
            Severity::Normal => "meter-normal",
            Severity::Warn => "meter-warn",
            Severity::Critical => "meter-critical",
        }
    }
}

/// `loginColor` (`AccountBadge.tsx`): a stable per-login hue. JS hashes over
/// UTF-16 code units with `hash = (hash * 31 + code) | 0` (32-bit wrapping
/// signed), then `hsl(hash mod 360, 55%, 68%)`. Ported exactly — the color
/// must match the badge the sidebar/accounts pane draws for the same login.
pub fn login_color(id: &str) -> String {
    let mut hash: i32 = 0;
    for unit in id.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as i32);
    }
    let hue = hash.rem_euclid(360);
    format!("hsl({hue}, 55%, 68%)")
}

/// `formatResetsIn` (`UsageBars.tsx`): "resets in 2h 5m" / "in 45m" / "in <1m"
/// from now-relative ms until reset. Past/zero → "now".
pub fn format_resets_in(ms_until: i64) -> String {
    if ms_until <= 0 {
        return "now".to_string();
    }
    let mins = ms_until / 60_000;
    if mins >= 60 {
        let h = mins / 60;
        let m = mins % 60;
        format!("{h}h {m}m")
    } else if mins >= 1 {
        format!("{mins}m")
    } else {
        "<1m".to_string()
    }
}

/// `formatUpdatedAgo` (`ResourcesView.tsx`): "updated just now" / "12s ago" /
/// "3m ago" from a now-relative age in ms.
pub fn format_updated_ago(ms_ago: i64) -> String {
    if ms_ago < 5_000 {
        return "just now".to_string();
    }
    let secs = ms_ago / 1000;
    if secs < 60 {
        format!("{secs}s ago")
    } else {
        format!("{}m ago", secs / 60)
    }
}

/// Per-agent CPU trace ring: a fixed-length client-side history of one agent's
/// CPU, drawn as a mini-sparkline in its Resources row. `SAMPLES` = 90 at the
/// 2s poll = 3 minutes (`ResourcesView.tsx` per-row trace).
///
/// The decay rule mirrors Electron: when an agent stops reporting (dropped
/// from the snapshot), its trace pushes **0** each tick so the line visibly
/// decays to the baseline instead of freezing at its last value.
#[derive(Debug, Clone)]
pub struct TraceRing {
    samples: Vec<f64>,
    cap: usize,
}

impl TraceRing {
    pub const SAMPLES: usize = 90;

    pub fn new() -> Self {
        Self::with_capacity(Self::SAMPLES)
    }

    pub fn with_capacity(cap: usize) -> Self {
        Self {
            samples: Vec::with_capacity(cap),
            cap: cap.max(1),
        }
    }

    /// Push one CPU sample, evicting the oldest past capacity.
    pub fn push(&mut self, cpu: f64) {
        if self.samples.len() == self.cap {
            self.samples.remove(0);
        }
        self.samples.push(cpu.max(0.0));
    }

    /// Push a decay sample (0) — the agent went missing this tick.
    pub fn decay(&mut self) {
        self.push(0.0);
    }

    /// True once every sample is at (or below) the baseline — the row can be
    /// dropped from the table.
    pub fn is_flat(&self) -> bool {
        self.samples.iter().all(|&v| v <= 0.0)
    }

    pub fn samples(&self) -> &[f64] {
        &self.samples
    }

    /// Peak sample, for scaling the sparkline (Electron scales to
    /// `max(100, peak)` so a >100% multi-core spike still fits).
    pub fn peak(&self) -> f64 {
        self.samples.iter().cloned().fold(0.0, f64::max)
    }
}

impl Default for TraceRing {
    fn default() -> Self {
        Self::new()
    }
}

/// Sparkline scale: never below 100 so a normal <1-core agent uses the bottom
/// of the range, but a multi-core spike (>100%) still fits (`Spark` in
/// `ResourcesView.tsx`).
pub fn spark_scale(peak: f64) -> f64 {
    peak.max(100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_bytes_matches_electron() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(1536), "1.5 KB");
        assert_eq!(format_bytes(1024 * 1024), "1.0 MB");
        assert_eq!(format_bytes(3_400_000_000), "3.2 GB");
    }

    #[test]
    fn format_cpu_and_tokens() {
        assert_eq!(format_cpu(0.0), "0%");
        assert_eq!(format_cpu(35.4), "35%");
        assert_eq!(format_cpu(35.6), "36%");
        assert_eq!(format_tokens(0), "0");
        assert_eq!(format_tokens(999), "999");
        assert_eq!(format_tokens(12_300), "12.3k");
        assert_eq!(format_tokens(1_200_000), "1.2M");
    }

    #[test]
    fn severity_tiers_match_usage_bars() {
        assert_eq!(Severity::of(0.0), Severity::Normal);
        assert_eq!(Severity::of(74.9), Severity::Normal);
        assert_eq!(Severity::of(75.0), Severity::Warn);
        assert_eq!(Severity::of(89.9), Severity::Warn);
        assert_eq!(Severity::of(90.0), Severity::Critical);
        assert_eq!(Severity::of(100.0), Severity::Critical);
    }

    #[test]
    fn login_color_matches_js_hash() {
        // Reference values computed with the JS algorithm:
        //   let h=0; for(const c of id) h=(h*31+c.charCodeAt(0))|0; h%360 (rem_euclid)
        // "default": hash → hue 133; "mc": 'm'=109,'c'=99 → 109*31+99=3478 → 3478%360=238
        assert_eq!(login_color("mc"), "hsl(238, 55%, 68%)");
        // Stable + deterministic across calls.
        assert_eq!(login_color("perso"), login_color("perso"));
        // Always a valid hue.
        for id in ["default", "mc", "perso", "🙂", ""] {
            let c = login_color(id);
            assert!(c.starts_with("hsl("));
        }
    }

    #[test]
    fn resets_and_updated_formatting() {
        assert_eq!(format_resets_in(-1), "now");
        assert_eq!(format_resets_in(0), "now");
        assert_eq!(format_resets_in(30_000), "<1m");
        assert_eq!(format_resets_in(45 * 60_000), "45m");
        assert_eq!(format_resets_in(125 * 60_000), "2h 5m");

        assert_eq!(format_updated_ago(1000), "just now");
        assert_eq!(format_updated_ago(12_000), "12s ago");
        assert_eq!(format_updated_ago(200_000), "3m ago");
    }

    #[test]
    fn trace_ring_evicts_at_capacity() {
        let mut ring = TraceRing::with_capacity(3);
        ring.push(10.0);
        ring.push(20.0);
        ring.push(30.0);
        ring.push(40.0);
        assert_eq!(ring.samples(), &[20.0, 30.0, 40.0]);
        assert_eq!(ring.peak(), 40.0);
    }

    #[test]
    fn trace_ring_decays_to_flat() {
        let mut ring = TraceRing::with_capacity(3);
        ring.push(50.0);
        assert!(!ring.is_flat());
        // Enough decay ticks push every live sample out.
        ring.decay();
        ring.decay();
        ring.decay();
        assert!(ring.is_flat());
        assert_eq!(ring.samples(), &[0.0, 0.0, 0.0]);
    }

    #[test]
    fn spark_scale_floors_at_100() {
        assert_eq!(spark_scale(0.0), 100.0);
        assert_eq!(spark_scale(45.0), 100.0);
        assert_eq!(spark_scale(250.0), 250.0);
    }
}
