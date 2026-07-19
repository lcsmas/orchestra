//! Rust port of the pure usage-limit logic in `src/shared/accounts.ts`
//! (`usageLimitedUntil`, `canAutoFlushQueue`) plus `formatResetsIn` from
//! `src/renderer/components/UsageBars.tsx` — the PromptQueueBanner's brain
//! (plan §5.3). Test vectors mirror `src/shared/accounts.test.ts` so the two
//! implementations can never drift silently.
//!
//! Pure module: no GTK, no backend — unit-tests without a display.

use orchestra_rpc::types::{UsageData, UsageSnapshot, UsageWindowDetail};

/// The slice of usage data the limit check needs — `UsageWindows` in
/// accounts.ts. Both the per-account `UsageData` and the global poller's
/// `UsageSnapshot` convert into it.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageWindows {
    pub five_hour: UsageWindowDetail,
    pub seven_day: UsageWindowDetail,
    /// Pay-as-you-go utilization 0–100, None when not enabled.
    pub extra_utilization: Option<f64>,
}

impl From<&UsageData> for UsageWindows {
    fn from(d: &UsageData) -> Self {
        Self {
            five_hour: d.five_hour.clone(),
            seven_day: d.seven_day.clone(),
            extra_utilization: d.extra_utilization,
        }
    }
}

impl From<&UsageSnapshot> for UsageWindows {
    fn from(s: &UsageSnapshot) -> Self {
        Self {
            five_hour: UsageWindowDetail {
                utilization: s.five_hour.utilization,
                resets_at: s.five_hour.resets_at.clone(),
            },
            seven_day: UsageWindowDetail {
                utilization: s.seven_day.utilization,
                resets_at: s.seven_day.resets_at.clone(),
            },
            extra_utilization: s.extra_utilization,
        }
    }
}

/// Port of `usageLimitedUntil` (accounts.ts): when `data` says the account is
/// blocked by a usage limit, the epoch ms at which the LAST blocked window
/// resets (both windows must clear before Claude answers again); None when the
/// account is usable. A window blocks at utilization ≥ 100. Extra usage
/// (pay-as-you-go) absorbs the overflow: while it's enabled and itself under
/// 100%, a maxed 5h/7d window does NOT block. A blocked window whose
/// `resets_at` is missing/unparsable contributes `now` — i.e. "limited, reset
/// time unknown, re-check on fresh data".
pub fn usage_limited_until(data: &UsageWindows, now_ms: i64) -> Option<i64> {
    if let Some(extra) = data.extra_utilization {
        if extra < 100.0 {
            return None;
        }
    }
    let mut until: Option<i64> = None;
    for w in [&data.five_hour, &data.seven_day] {
        if w.utilization < 100.0 {
            continue;
        }
        let at = parse_iso_ms(&w.resets_at).unwrap_or(now_ms);
        until = Some(match until {
            None => at,
            Some(prev) => prev.max(at),
        });
    }
    until
}

/// Port of `canAutoFlushQueue` (accounts.ts): whether a workspace's queued
/// prompts may be auto-delivered. Conservative: needs a usage reading that
/// (a) exists with data, (b) was fetched AFTER the newest prompt was queued,
/// and (c) shows the account un-limited.
pub fn can_auto_flush_queue(
    newest_queued_at: i64,
    usage: Option<(i64, Option<&UsageWindows>)>,
    now_ms: i64,
) -> bool {
    let Some((fetched_at, Some(data))) = usage else {
        return false;
    };
    if fetched_at <= newest_queued_at {
        return false;
    }
    usage_limited_until(data, now_ms).is_none()
}

/// Port of `formatResetsIn` (UsageBars.tsx): "resets in 1d 2h" / "resets in
/// 2h 5m" / "resets in 12m" / "resets now"; "" when `resets_at` is unparsable.
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

/// Epoch ms right now — the `Date.now()` of the ports above.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---- ISO-8601 parsing --------------------------------------------------------

/// Parse the ISO-8601 timestamps the usage endpoint emits
/// (`2026-07-12T14:00:00Z`, optional fractional seconds, `Z` or `±HH:MM`
/// offset) into epoch ms — the subset of `Date.parse` these fields use.
/// Dependency-free on purpose: pulling in chrono/time for one format isn't
/// worth the tree. Returns None on anything malformed.
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let bytes = s.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> { s.get(r)?.parse::<i64>().ok() };
    let year = num(0..4)?;
    let month = num(5..7)?;
    let day = num(8..10)?;
    let hour = num(11..13)?;
    let min = num(14..16)?;
    let sec = num(17..19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || min > 59 || sec > 60 {
        return None;
    }

    // Fractional seconds + offset tail.
    let mut i = 19;
    let mut millis: i64 = 0;
    if bytes.get(i) == Some(&b'.') {
        let start = i + 1;
        let mut end = start;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end == start {
            return None;
        }
        // First three digits are milliseconds; further precision truncates.
        let frac = &s[start..end.min(start + 3)];
        let scale = 10_i64.pow(3 - frac.len() as u32);
        millis = frac.parse::<i64>().ok()? * scale;
        i = end;
    }
    let offset_min: i64 = match bytes.get(i) {
        Some(&b'Z') if i + 1 == bytes.len() => 0,
        Some(&(sign @ b'+' | sign @ b'-')) => {
            let rest = s.get(i + 1..)?;
            let (h, m) = match rest.len() {
                5 if rest.as_bytes()[2] == b':' => (
                    rest[0..2].parse::<i64>().ok()?,
                    rest[3..5].parse::<i64>().ok()?,
                ),
                4 => (
                    rest[0..2].parse::<i64>().ok()?,
                    rest[2..4].parse::<i64>().ok()?,
                ),
                _ => return None,
            };
            let total = h * 60 + m;
            if sign == b'-' {
                -total
            } else {
                total
            }
        }
        _ => return None,
    };

    // Howard Hinnant's days-from-civil: civil date → days since 1970-01-01.
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (month + 9) % 12; // Mar=0 … Feb=11
    let doy = (153 * mp + 2) / 5 + day - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    let days = era * 146097 + doe - 719468;

    let secs = days * 86_400 + hour * 3_600 + min * 60 + sec - offset_min * 60;
    Some(secs * 1_000 + millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors accounts.test.ts: NOW / RESET_5H / RESET_7D.
    const NOW: i64 = 1_783_857_600_000; // Date.parse('2026-07-12T12:00:00Z')
    const RESET_5H: &str = "2026-07-12T14:00:00Z";
    const RESET_7D: &str = "2026-07-15T00:00:00Z";
    const RESET_5H_MS: i64 = NOW + 2 * 3_600_000;
    const RESET_7D_MS: i64 = NOW + (12 + 2 * 24) * 3_600_000;

    fn windows(five: f64, seven: f64, extra: Option<f64>) -> UsageWindows {
        UsageWindows {
            five_hour: UsageWindowDetail {
                utilization: five,
                resets_at: RESET_5H.into(),
            },
            seven_day: UsageWindowDetail {
                utilization: seven,
                resets_at: RESET_7D.into(),
            },
            extra_utilization: extra,
        }
    }

    #[test]
    fn parse_iso_matches_date_parse() {
        assert_eq!(parse_iso_ms("2026-07-12T12:00:00Z"), Some(NOW));
        assert_eq!(parse_iso_ms(RESET_5H), Some(RESET_5H_MS));
        assert_eq!(parse_iso_ms(RESET_7D), Some(RESET_7D_MS));
        // Epoch + fractional + explicit offsets.
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.250Z"), Some(250));
        assert_eq!(parse_iso_ms("2026-07-12T14:00:00+02:00"), Some(NOW));
        assert_eq!(parse_iso_ms("2026-07-12T10:00:00-02:00"), Some(NOW));
        // Leap-year day and a pre-March date (the yoe branch).
        assert_eq!(
            parse_iso_ms("2024-02-29T00:00:00Z"),
            Some(1_709_164_800_000)
        );
        // Malformed.
        assert_eq!(parse_iso_ms(""), None);
        assert_eq!(parse_iso_ms("not a date"), None);
        assert_eq!(parse_iso_ms("2026-13-01T00:00:00Z"), None);
        assert_eq!(parse_iso_ms("2026-07-12T14:00:00"), None); // no offset
    }

    #[test]
    fn null_while_both_windows_under_100() {
        assert_eq!(usage_limited_until(&windows(97.0, 42.0, None), NOW), None);
        assert_eq!(usage_limited_until(&windows(0.0, 0.0, None), NOW), None);
    }

    #[test]
    fn returns_the_blocked_window_reset_time() {
        assert_eq!(
            usage_limited_until(&windows(100.0, 42.0, None), NOW),
            Some(RESET_5H_MS)
        );
        assert_eq!(
            usage_limited_until(&windows(12.0, 100.0, None), NOW),
            Some(RESET_7D_MS)
        );
    }

    #[test]
    fn takes_the_later_reset_when_both_blocked() {
        assert_eq!(
            usage_limited_until(&windows(100.0, 100.0, None), NOW),
            Some(RESET_7D_MS)
        );
    }

    #[test]
    fn enabled_extra_usage_under_100_absorbs_a_maxed_window() {
        assert_eq!(
            usage_limited_until(&windows(100.0, 100.0, Some(3.0)), NOW),
            None
        );
    }

    #[test]
    fn maxed_extra_usage_no_longer_absorbs() {
        assert_eq!(
            usage_limited_until(&windows(100.0, 42.0, Some(100.0)), NOW),
            Some(RESET_5H_MS)
        );
    }

    #[test]
    fn falls_back_to_now_for_a_blocked_window_without_parsable_reset() {
        let data = UsageWindows {
            five_hour: UsageWindowDetail {
                utilization: 100.0,
                resets_at: String::new(),
            },
            seven_day: UsageWindowDetail {
                utilization: 10.0,
                resets_at: RESET_7D.into(),
            },
            extra_utilization: None,
        };
        assert_eq!(usage_limited_until(&data, NOW), Some(NOW));
    }

    #[test]
    fn can_auto_flush_requires_a_post_queue_unlimited_reading() {
        let queued_at = NOW;
        let ok = windows(3.0, 3.0, None);
        let limited = windows(100.0, 3.0, None);
        // No reading at all, or no data on it → hold.
        assert!(!can_auto_flush_queue(queued_at, None, NOW));
        assert!(!can_auto_flush_queue(
            queued_at,
            Some((NOW + 60_000, None)),
            NOW
        ));
        // Reading predates (or ties) the queue instant → can't prove the reset.
        assert!(!can_auto_flush_queue(
            queued_at,
            Some((NOW - 60_000, Some(&ok))),
            NOW
        ));
        assert!(!can_auto_flush_queue(
            queued_at,
            Some((NOW, Some(&ok))),
            NOW
        ));
        // Fresh reading but still limited → hold.
        assert!(!can_auto_flush_queue(
            queued_at,
            Some((NOW + 60_000, Some(&limited))),
            NOW
        ));
        // Fresh reading, un-limited → flush.
        assert!(can_auto_flush_queue(
            queued_at,
            Some((NOW + 60_000, Some(&ok))),
            NOW
        ));
    }

    #[test]
    fn format_resets_in_matches_usagebars() {
        assert_eq!(format_resets_in(RESET_5H, NOW), "resets in 2h 0m");
        assert_eq!(format_resets_in(RESET_7D, NOW), "resets in 2d 12h");
        assert_eq!(
            format_resets_in("2026-07-12T12:25:00Z", NOW),
            "resets in 25m"
        );
        assert_eq!(format_resets_in("2026-07-12T11:00:00Z", NOW), "resets now");
        assert_eq!(format_resets_in("", NOW), "");
    }
}
