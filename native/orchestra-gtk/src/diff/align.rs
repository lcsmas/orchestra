//! Side-by-side diff alignment (plan §5.3): map an old/new content pair onto
//! parallel rows for the two GtkSourceView panes — the substitute for Monaco's
//! DiffEditor layout engine (§0: same information, different chrome).
//!
//! Line pairing uses the `similar` crate's line diff; each Replace block pairs
//! its first min(old, new) lines as changed rows (with intra-line word
//! highlights, also via `similar`) and pads the shorter side with filler rows
//! so both panes always have IDENTICAL row counts — that invariant is what
//! lets the two panes share one scroll adjustment for perfectly synced
//! scrolling.
//!
//! Pure module: no GTK — unit-tests without a display.

use similar::{ChangeTag, DiffTag, TextDiff};

/// What one aligned row means for a single pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellKind {
    /// Line unchanged on both sides.
    Context,
    /// Line exists only on this side (pure insert/delete), or the changed
    /// variant of a paired line.
    Changed,
    /// No line on this side — filler keeping the panes aligned.
    Filler,
}

/// One pane's half of an aligned row.
#[derive(Debug, Clone, PartialEq)]
pub struct Cell {
    pub kind: CellKind,
    /// The line's text (no trailing newline). Empty for filler.
    pub text: String,
    /// Intra-line highlight ranges, as BYTE offsets into `text` (word-level
    /// inserts/deletes from the paired line's word diff). Only non-empty on
    /// `Changed` cells that are paired with a counterpart.
    pub ranges: Vec<(usize, usize)>,
}

/// One row of the side-by-side view: the old (left) and new (right) cells.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub old: Cell,
    pub new: Cell,
}

fn context(text: &str) -> Cell {
    Cell {
        kind: CellKind::Context,
        text: text.into(),
        ranges: Vec::new(),
    }
}

fn changed(text: &str, ranges: Vec<(usize, usize)>) -> Cell {
    Cell {
        kind: CellKind::Changed,
        text: text.into(),
        ranges,
    }
}

fn filler() -> Cell {
    Cell {
        kind: CellKind::Filler,
        text: String::new(),
        ranges: Vec::new(),
    }
}

fn line_text(s: &str) -> &str {
    let s = s.strip_suffix('\n').unwrap_or(s);
    s.strip_suffix('\r').unwrap_or(s)
}

/// Word-level intra-line diff of a paired old/new line: byte ranges of the
/// deleted words in `old` and the inserted words in `new`. Adjacent ranges
/// merge so a run of changed words highlights as one span.
fn word_ranges(old: &str, new: &str) -> (Vec<(usize, usize)>, Vec<(usize, usize)>) {
    let diff = TextDiff::from_words(old, new);
    let mut old_ranges: Vec<(usize, usize)> = Vec::new();
    let mut new_ranges: Vec<(usize, usize)> = Vec::new();
    let (mut old_off, mut new_off) = (0usize, 0usize);
    let push = |ranges: &mut Vec<(usize, usize)>, start: usize, end: usize| {
        if let Some(last) = ranges.last_mut() {
            if last.1 == start {
                last.1 = end;
                return;
            }
        }
        ranges.push((start, end));
    };
    for change in diff.iter_all_changes() {
        let len = change.value().len();
        match change.tag() {
            ChangeTag::Equal => {
                old_off += len;
                new_off += len;
            }
            ChangeTag::Delete => {
                push(&mut old_ranges, old_off, old_off + len);
                old_off += len;
            }
            ChangeTag::Insert => {
                push(&mut new_ranges, new_off, new_off + len);
                new_off += len;
            }
        }
    }
    (old_ranges, new_ranges)
}

/// Align `old` and `new` content into parallel rows. Both sides of the result
/// always have the same length (the panes scroll in lockstep).
pub fn align(old: &str, new: &str) -> Vec<Row> {
    let diff = TextDiff::from_lines(old, new);
    let old_lines: Vec<&str> = old.split_inclusive('\n').collect();
    let new_lines: Vec<&str> = new.split_inclusive('\n').collect();
    let mut rows = Vec::new();

    for op in diff.ops() {
        let or = op.old_range();
        let nr = op.new_range();
        match op.tag() {
            DiffTag::Equal => {
                for (o, n) in or.zip(nr) {
                    rows.push(Row {
                        old: context(line_text(old_lines[o])),
                        new: context(line_text(new_lines[n])),
                    });
                }
            }
            DiffTag::Delete => {
                for o in or {
                    rows.push(Row {
                        old: changed(line_text(old_lines[o]), Vec::new()),
                        new: filler(),
                    });
                }
            }
            DiffTag::Insert => {
                for n in nr {
                    rows.push(Row {
                        old: filler(),
                        new: changed(line_text(new_lines[n]), Vec::new()),
                    });
                }
            }
            DiffTag::Replace => {
                let paired = or.len().min(nr.len());
                for i in 0..paired {
                    let o = line_text(old_lines[or.start + i]);
                    let n = line_text(new_lines[nr.start + i]);
                    let (old_ranges, new_ranges) = word_ranges(o, n);
                    rows.push(Row {
                        old: changed(o, old_ranges),
                        new: changed(n, new_ranges),
                    });
                }
                for o in (or.start + paired)..or.end {
                    rows.push(Row {
                        old: changed(line_text(old_lines[o]), Vec::new()),
                        new: filler(),
                    });
                }
                for n in (nr.start + paired)..nr.end {
                    rows.push(Row {
                        old: filler(),
                        new: changed(line_text(new_lines[n]), Vec::new()),
                    });
                }
            }
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(rows: &[Row]) -> Vec<(CellKind, CellKind)> {
        rows.iter().map(|r| (r.old.kind, r.new.kind)).collect()
    }

    #[test]
    fn identical_content_is_all_context() {
        let rows = align("a\nb\n", "a\nb\n");
        assert_eq!(
            kinds(&rows),
            vec![
                (CellKind::Context, CellKind::Context),
                (CellKind::Context, CellKind::Context)
            ]
        );
        assert_eq!(rows[0].old.text, "a");
        assert_eq!(rows[0].new.text, "a");
    }

    #[test]
    fn pure_insert_pads_the_old_side() {
        // The Electron fixture diff: "one\ntwo\nthree\n" → "one\nTWO\nthree\nfour\n".
        let rows = align("one\ntwo\nthree\n", "one\nTWO\nthree\nfour\n");
        assert_eq!(
            kinds(&rows),
            vec![
                (CellKind::Context, CellKind::Context),
                (CellKind::Changed, CellKind::Changed),
                (CellKind::Context, CellKind::Context),
                (CellKind::Filler, CellKind::Changed),
            ]
        );
        assert_eq!(rows[3].old.text, "");
        assert_eq!(rows[3].new.text, "four");
    }

    #[test]
    fn pure_delete_pads_the_new_side() {
        let rows = align("a\nb\nc\n", "a\nc\n");
        assert_eq!(
            kinds(&rows),
            vec![
                (CellKind::Context, CellKind::Context),
                (CellKind::Changed, CellKind::Filler),
                (CellKind::Context, CellKind::Context),
            ]
        );
    }

    #[test]
    fn replace_pairs_lines_and_pads_the_shorter_side() {
        let rows = align("x1\nx2\nx3\nz\n", "y1\nz\n");
        // 3 old lines replaced by 1 new: first pairs, other two pad right.
        assert_eq!(
            kinds(&rows),
            vec![
                (CellKind::Changed, CellKind::Changed),
                (CellKind::Changed, CellKind::Filler),
                (CellKind::Changed, CellKind::Filler),
                (CellKind::Context, CellKind::Context),
            ]
        );
    }

    #[test]
    fn both_sides_always_have_equal_row_counts() {
        for (old, new) in [
            ("", "a\nb\nc\n"),
            ("a\nb\nc\n", ""),
            ("fn main() {}\n", "fn main() { println!(); }\nmore\n"),
            ("a\nb\nc\nd\ne\n", "a\nX\nY\nd\n"),
        ] {
            let rows = align(old, new);
            // Every row has exactly one old and one new cell by construction —
            // the real assertion is that filler placement kept text order.
            let old_texts: Vec<&str> = rows
                .iter()
                .filter(|r| r.old.kind != CellKind::Filler)
                .map(|r| r.old.text.as_str())
                .collect();
            let expect_old: Vec<&str> =
                old.split_inclusive('\n').map(line_text).collect();
            assert_eq!(old_texts, expect_old, "old side order for {old:?}");
            let new_texts: Vec<&str> = rows
                .iter()
                .filter(|r| r.new.kind != CellKind::Filler)
                .map(|r| r.new.text.as_str())
                .collect();
            let expect_new: Vec<&str> =
                new.split_inclusive('\n').map(line_text).collect();
            assert_eq!(new_texts, expect_new, "new side order for {new:?}");
        }
    }

    #[test]
    fn intra_line_word_ranges_cover_the_changed_words() {
        let rows = align("let count = compute(a, b);\n", "let total = compute(a, c);\n");
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        // Old highlights cover "count" and "b"; new cover "total" and "c".
        let old_hl: Vec<&str> = row
            .old
            .ranges
            .iter()
            .map(|&(s, e)| &row.old.text[s..e])
            .collect();
        let new_hl: Vec<&str> = row
            .new
            .ranges
            .iter()
            .map(|&(s, e)| &row.new.text[s..e])
            .collect();
        assert!(old_hl.concat().contains("count"), "old: {old_hl:?}");
        assert!(old_hl.concat().contains("b"), "old: {old_hl:?}");
        assert!(new_hl.concat().contains("total"), "new: {new_hl:?}");
        assert!(new_hl.concat().contains("c"), "new: {new_hl:?}");
        // Ranges are valid byte offsets on char boundaries.
        for &(s, e) in row.old.ranges.iter().chain(row.new.ranges.iter()) {
            assert!(s < e);
            assert!(row.old.text.len().max(row.new.text.len()) >= e);
        }
    }

    #[test]
    fn unchanged_separator_keeps_spans_distinct() {
        // "beta"/"gamma" both change but the space between them does not, so —
        // like Monaco's char-level highlight — they stay two separate spans
        // rather than one blob swallowing the unchanged whitespace.
        let (old_r, new_r) = word_ranges("alpha beta gamma", "alpha BETA GAMMA");
        assert_eq!(old_r, vec![(6, 10), (11, 16)], "{old_r:?}");
        assert_eq!(new_r, vec![(6, 10), (11, 16)], "{new_r:?}");
    }

    #[test]
    fn truly_adjacent_change_tokens_merge() {
        // Two consecutive changed tokens with NO equal token between them
        // (word + the immediately-following punctuation both differ) coalesce
        // into one contiguous range on each side.
        let (old_r, new_r) = word_ranges("foo!", "bar?");
        assert_eq!(old_r, vec![(0, 4)], "{old_r:?}");
        assert_eq!(new_r, vec![(0, 4)], "{new_r:?}");
    }

    #[test]
    fn crlf_lines_render_without_the_cr() {
        let rows = align("a\r\nb\r\n", "a\r\nc\r\n");
        assert_eq!(rows[0].old.text, "a");
        assert_eq!(rows[1].new.text, "c");
    }
}
