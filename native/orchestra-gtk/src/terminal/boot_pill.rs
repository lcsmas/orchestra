//! Boot-pill state machine (plan §5.2), pure logic so it's unit-testable.
//!
//! On agent start the pane shows a "Resuming previous session… / Starting
//! agent…" pill. It clears on the FIRST of: ≥2 KiB of output, any keystroke,
//! the agent exiting, or a 20 s timeout — then fades out over 250 ms. Mirrors
//! `Terminal.tsx`'s cold-boot resume pill.

/// Bytes of output that dismiss the pill (matches the renderer's threshold).
pub const CLEAR_BYTES: usize = 2048;
/// Fallback dismiss timeout.
pub const CLEAR_TIMEOUT_MS: u64 = 20_000;
/// Fade-out duration once dismissed.
pub const FADE_MS: u64 = 250;

/// What text the pill shows while visible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PillKind {
    /// Fresh spawn.
    Starting,
    /// `--continue` resume of a prior session.
    Resuming,
}

impl PillKind {
    pub fn label(self) -> &'static str {
        match self {
            PillKind::Starting => "Starting agent…",
            PillKind::Resuming => "Resuming previous session…",
        }
    }
}

/// Events that can dismiss the pill.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Output(usize),
    Keystroke,
    Exit,
    Timeout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Hidden,
    Visible,
    /// Dismissed; a fade is in flight (widget still present until it ends).
    Fading,
}

/// Tracks pill visibility. `feed`/`on_*` return `true` exactly once — on the
/// transition from Visible to Fading — so the caller starts the fade animation
/// a single time.
#[derive(Debug)]
pub struct BootPill {
    phase: Phase,
    kind: PillKind,
    bytes_seen: usize,
}

impl BootPill {
    /// Create a hidden pill.
    pub fn new() -> Self {
        Self {
            phase: Phase::Hidden,
            kind: PillKind::Starting,
            bytes_seen: 0,
        }
    }

    /// Show the pill (agent (re)start). Resets the output counter.
    pub fn show(&mut self, kind: PillKind) {
        self.phase = Phase::Visible;
        self.kind = kind;
        self.bytes_seen = 0;
    }

    #[cfg_attr(not(test), allow(dead_code))] // queried in tests; API for panes
    pub fn is_visible(&self) -> bool {
        self.phase == Phase::Visible
    }

    #[cfg_attr(not(test), allow(dead_code))] // queried in tests; API for panes
    pub fn kind(&self) -> PillKind {
        self.kind
    }

    /// Apply a dismiss trigger. Returns `true` iff this call is what dismissed a
    /// currently-visible pill (so the caller runs the fade exactly once).
    pub fn apply(&mut self, trigger: Trigger) -> bool {
        if self.phase != Phase::Visible {
            return false;
        }
        let dismiss = match trigger {
            Trigger::Output(n) => {
                self.bytes_seen = self.bytes_seen.saturating_add(n);
                self.bytes_seen >= CLEAR_BYTES
            }
            Trigger::Keystroke | Trigger::Exit | Trigger::Timeout => true,
        };
        if dismiss {
            self.phase = Phase::Fading;
        }
        dismiss
    }

    /// Called when the fade animation finishes.
    pub fn finish_fade(&mut self) {
        if self.phase == Phase::Fading {
            self.phase = Phase::Hidden;
        }
    }
}

impl Default for BootPill {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_pill_ignores_triggers() {
        let mut p = BootPill::new();
        assert!(!p.is_visible());
        assert!(!p.apply(Trigger::Keystroke));
        assert!(!p.apply(Trigger::Output(9999)));
    }

    #[test]
    fn keystroke_dismisses_once() {
        let mut p = BootPill::new();
        p.show(PillKind::Resuming);
        assert!(p.is_visible());
        assert_eq!(p.kind(), PillKind::Resuming);
        assert!(p.apply(Trigger::Keystroke)); // first dismiss returns true
        assert!(!p.is_visible());
        assert!(!p.apply(Trigger::Keystroke)); // already fading → false
        assert!(!p.apply(Trigger::Exit));
    }

    #[test]
    fn output_accumulates_to_threshold() {
        let mut p = BootPill::new();
        p.show(PillKind::Starting);
        assert!(!p.apply(Trigger::Output(CLEAR_BYTES - 1)));
        assert!(p.is_visible());
        assert!(p.apply(Trigger::Output(1))); // crosses 2 KiB
        assert!(!p.is_visible());
    }

    #[test]
    fn exit_and_timeout_dismiss() {
        for t in [Trigger::Exit, Trigger::Timeout] {
            let mut p = BootPill::new();
            p.show(PillKind::Starting);
            assert!(p.apply(t));
            assert!(!p.is_visible());
        }
    }

    #[test]
    fn fade_completes_to_hidden() {
        let mut p = BootPill::new();
        p.show(PillKind::Starting);
        p.apply(Trigger::Timeout);
        p.finish_fade();
        // A new show after a completed fade works again.
        p.show(PillKind::Resuming);
        assert!(p.is_visible());
    }
}
