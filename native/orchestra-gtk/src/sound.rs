//! Chime playback + sound picker (plan §5.5, parity: `src/renderer/chime.ts`
//! and `SoundSettings.tsx`).
//!
//! The ~20 chime recipes are rendered to WAV at build time (build.rs →
//! chime-gen) and embedded in the binary. Playback goes through a GStreamer
//! `playbin`: the selected WAV is spilled once to
//! `$ORCHESTRA_HOME/gtk-chimes/<id>.wav` (playbin wants a URI, and a stable
//! on-disk copy also gives E2E something to assert). Selection persists in
//! `gtk-ui-state.json` (`notificationSound`), defaulting to chime.ts's
//! `knock`.
//!
//! Audio failure is never fatal: a box with no audio server (headless sway
//! E2E) just logs and stays silent, like a muted desktop would.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use gstreamer as gst;
use gstreamer::prelude::*;
use gtk::glib;
use gtk::prelude::*;

use crate::state::UiState;

/// One embedded chime: metadata straight from the recipe table (same ids,
/// names, order as chime.ts's SOUNDS list) plus the rendered WAV bytes.
pub struct ChimeAsset {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub wav: &'static [u8],
}

include!(concat!(env!("OUT_DIR"), "/chime_assets.rs"));

/// chime.ts `DEFAULT_ID`.
pub const DEFAULT_SOUND_ID: &str = "knock";

pub fn sounds() -> &'static [ChimeAsset] {
    CHIMES
}

fn asset(id: &str) -> Option<&'static ChimeAsset> {
    CHIMES.iter().find(|c| c.id == id)
}

/// The persisted selection, falling back to the default exactly like
/// chime.ts `getSelectedSoundId` (unknown ids reset to default).
pub fn selected_sound_id(state: &UiState) -> &'static str {
    state
        .notification_sound
        .as_deref()
        .and_then(|id| asset(id))
        .map(|c| c.id)
        .unwrap_or(DEFAULT_SOUND_ID)
}

pub struct SoundPlayer {
    spill_dir: PathBuf,
    /// Lazily initialized; None = not tried yet, Some(false) = init failed
    /// (no audio stack) and playback stays a silent no-op.
    gst_ready: RefCell<Option<bool>>,
    /// The last playbin, replaced (and stopped) on each play so chimes never
    /// overlap and nothing leaks across plays.
    current: RefCell<Option<gst::Element>>,
}

impl SoundPlayer {
    pub fn new(orchestra_home: &Path) -> Self {
        Self {
            spill_dir: orchestra_home.join("gtk-chimes"),
            gst_ready: RefCell::new(None),
            current: RefCell::new(None),
        }
    }

    fn ensure_gst(&self) -> bool {
        let mut ready = self.gst_ready.borrow_mut();
        if let Some(ok) = *ready {
            return ok;
        }
        let ok = match gst::init() {
            Ok(()) => true,
            Err(e) => {
                eprintln!("[sound] gstreamer init failed — chimes disabled: {e}");
                false
            }
        };
        *ready = Some(ok);
        ok
    }

    /// Write the embedded WAV next to the state file (idempotent; rewrites
    /// only if missing or size-drifted from the embedded bytes).
    fn spill(&self, chime: &ChimeAsset) -> Option<PathBuf> {
        let path = self.spill_dir.join(format!("{}.wav", chime.id));
        let fresh = std::fs::metadata(&path)
            .map(|m| m.len() == chime.wav.len() as u64)
            .unwrap_or(false);
        if !fresh {
            if let Err(e) = std::fs::create_dir_all(&self.spill_dir) {
                eprintln!("[sound] cannot create {}: {e}", self.spill_dir.display());
                return None;
            }
            if let Err(e) = std::fs::write(&path, chime.wav) {
                eprintln!("[sound] cannot write {}: {e}", path.display());
                return None;
            }
        }
        Some(path)
    }

    /// Play a chime by id. `none`/unknown ids are silent no-ops.
    pub fn play(&self, id: &str) {
        let Some(chime) = asset(id) else { return };
        if chime.wav.is_empty() || !self.ensure_gst() {
            return;
        }
        let Some(path) = self.spill(chime) else { return };
        let playbin = match gst::ElementFactory::make("playbin")
            .property("uri", format!("file://{}", path.display()))
            .build()
        {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[sound] playbin unavailable: {e}");
                return;
            }
        };
        if let Err(e) = playbin.set_state(gst::State::Playing) {
            eprintln!("[sound] could not play chime '{id}': {e}");
            return;
        }
        // Replace (and stop) whatever played before.
        if let Some(prev) = self.current.borrow_mut().replace(playbin) {
            let _ = prev.set_state(gst::State::Null);
        }
    }

    /// E2E probe (plan §5.5 audio check): route the chime through a fakesink
    /// and report whether the pipeline reached PLAYING — proves decode +
    /// pipeline health without needing an audio server.
    pub fn check(&self, id: &str) -> bool {
        let Some(chime) = asset(id) else {
            return false;
        };
        if chime.wav.is_empty() || !self.ensure_gst() {
            return false;
        }
        let Some(path) = self.spill(chime) else {
            return false;
        };
        let build_fakesink = || {
            gst::ElementFactory::make("fakesink")
                .build()
                .expect("fakesink is in gstreamer core")
        };
        let playbin = match gst::ElementFactory::make("playbin")
            .property("uri", format!("file://{}", path.display()))
            .property("audio-sink", build_fakesink())
            .property("video-sink", build_fakesink())
            .build()
        {
            Ok(p) => p,
            Err(_) => return false,
        };
        let ok = playbin.set_state(gst::State::Playing).is_ok()
            && playbin
                .state(gst::ClockTime::from_seconds(5))
                .0
                .is_ok();
        let _ = playbin.set_state(gst::State::Null);
        ok
    }
}

// ---- picker dialog (SoundSettings.tsx parity) -------------------------------

/// Open the notification-sound picker: click a row to preview and select
/// (persisted immediately via `on_select`), per-row ▶ previews without
/// closing, Done closes. Widget names (`sound-settings`, `sound-row-<id>`,
/// `sound-done`) serve the remote-control harness.
pub fn open_sound_settings(
    parent: &gtk::Window,
    player: Rc<SoundPlayer>,
    selected: &str,
    on_select: impl Fn(&str) + 'static,
) {
    let win = gtk::Window::builder()
        .modal(true)
        .transient_for(parent)
        .resizable(false)
        .decorated(false)
        .default_width(420)
        .build();
    win.set_widget_name("sound-settings");
    win.add_css_class("orch-dialog");
    win.add_css_class("sound-settings");

    let content = gtk::Box::new(gtk::Orientation::Vertical, 8);
    content.add_css_class("dlg-box");

    let title = gtk::Label::new(Some("Notification sound"));
    title.set_xalign(0.0);
    title.add_css_class("dlg-title");
    content.append(&title);

    let hint = gtk::Label::new(Some(
        "Plays when an agent finishes working. Click a row to preview and select.",
    ));
    hint.set_xalign(0.0);
    hint.set_wrap(true);
    hint.add_css_class("dlg-body");
    content.append(&hint);

    let list = gtk::ListBox::new();
    list.set_selection_mode(gtk::SelectionMode::None);
    list.add_css_class("sound-list");
    let on_select = Rc::new(on_select);

    let scroll = gtk::ScrolledWindow::new();
    scroll.set_hscrollbar_policy(gtk::PolicyType::Never);
    scroll.set_min_content_height(380);
    scroll.set_child(Some(&list));
    content.append(&scroll);

    // The row's "radio dot" widgets, so selection can restyle all rows.
    let dots: Rc<RefCell<Vec<(String, gtk::Box)>>> = Rc::new(RefCell::new(Vec::new()));

    for chime in sounds() {
        let row = gtk::ListBoxRow::new();
        row.set_widget_name(&format!("sound-row-{}", chime.id));
        row.set_activatable(true);
        let h = gtk::Box::new(gtk::Orientation::Horizontal, 10);
        h.add_css_class("sound-row");

        let dot = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        dot.add_css_class("sound-radio");
        if chime.id == selected {
            dot.add_css_class("selected");
        }
        dot.set_valign(gtk::Align::Center);
        h.append(&dot);
        dots.borrow_mut().push((chime.id.to_string(), dot));

        let meta = gtk::Box::new(gtk::Orientation::Vertical, 1);
        let name = gtk::Label::new(Some(chime.name));
        name.set_xalign(0.0);
        name.add_css_class("sound-name");
        let desc = gtk::Label::new(Some(chime.description));
        desc.set_xalign(0.0);
        desc.add_css_class("sound-desc");
        meta.append(&name);
        meta.append(&desc);
        meta.set_hexpand(true);
        h.append(&meta);

        if chime.id != "none" {
            let play = gtk::Button::from_icon_name("media-playback-start-symbolic");
            play.set_widget_name(&format!("sound-play-{}", chime.id));
            play.add_css_class("sound-play");
            play.set_valign(gtk::Align::Center);
            play.set_tooltip_text(Some(&format!("Preview {}", chime.name)));
            let player = player.clone();
            let id = chime.id;
            play.connect_clicked(move |_| player.play(id));
            h.append(&play);
        }

        row.set_child(Some(&h));
        list.append(&row);
    }

    {
        let player = player.clone();
        let on_select = on_select.clone();
        let dots = dots.clone();
        list.connect_row_activated(move |_, row| {
            let name = row.widget_name();
            let Some(id) = name.strip_prefix("sound-row-") else {
                return;
            };
            for (dot_id, dot) in dots.borrow().iter() {
                if dot_id == id {
                    dot.add_css_class("selected");
                } else {
                    dot.remove_css_class("selected");
                }
            }
            on_select(id);
            player.play(id);
        });
    }

    let buttons = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    buttons.set_halign(gtk::Align::End);
    buttons.add_css_class("dlg-buttons");
    let done = gtk::Button::with_label("Done");
    done.set_widget_name("sound-done");
    done.add_css_class("suggested");
    {
        let win = win.clone();
        done.connect_clicked(move |_| win.close());
    }
    buttons.append(&done);
    content.append(&buttons);

    win.set_child(Some(&content));

    let keys = gtk::EventControllerKey::new();
    {
        let win = win.clone();
        keys.connect_key_pressed(move |_, key, _, _| match key {
            gtk::gdk::Key::Escape | gtk::gdk::Key::Return | gtk::gdk::Key::KP_Enter => {
                win.close();
                glib::Propagation::Stop
            }
            _ => glib::Propagation::Proceed,
        });
    }
    win.add_controller(keys);

    win.present();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_chimes_mirror_the_recipe_list() {
        assert_eq!(CHIMES.len(), 23);
        assert_eq!(CHIMES[0].id, "double-knock");
        assert_eq!(CHIMES.last().unwrap().id, "none");
        assert!(CHIMES.last().unwrap().wav.is_empty());
        // Every audible chime carries a WAV with the RIFF magic.
        for c in CHIMES.iter().filter(|c| c.id != "none") {
            assert!(c.wav.len() > 44, "chime '{}' has no audio", c.id);
            assert_eq!(&c.wav[..4], b"RIFF", "chime '{}' is not a WAV", c.id);
        }
    }

    #[test]
    fn selection_falls_back_like_chime_ts() {
        let mut state = UiState::default();
        assert_eq!(selected_sound_id(&state), "knock");
        state.notification_sound = Some("tada".into());
        assert_eq!(selected_sound_id(&state), "tada");
        state.notification_sound = Some("not-a-sound".into());
        assert_eq!(selected_sound_id(&state), "knock");
        state.notification_sound = Some("none".into());
        assert_eq!(selected_sound_id(&state), "none");
    }
}
