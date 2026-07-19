//! Per-account WebKitGTK OAuth windows — the GTK replacement for
//! `src/main/login-browser.ts` (plan §0 approved the WebKitGTK 6 substitution;
//! §4 routes `accounts:loginUrl` events here).
//!
//! Why not the system browser: the whole point of a configured account is a
//! DIFFERENT claude.ai login, but the system browser's one cookie jar is
//! already the user's main account — "log in account B" would silently
//! re-authorize A. So each account gets a WebView bound to its own **persistent
//! `NetworkSession`** rooted at `<orchestra_home>/gtk-login-partitions/<id>`:
//! an isolated cookie jar on disk per account (E2E proves two accounts → two
//! distinct dirs), and a later re-login lands on that account's remembered
//! session. This mirrors login-browser.ts's `persist:claude-login-<id>`.
//!
//! The UA is normalized (embedded-webview markers stripped) exactly like
//! login-browser.ts:36 so Google OAuth doesn't reject the window as a webview.
//! Right-click offers an "Open in system browser" escape hatch. Windows close
//! on login-done / stop.
//!
//! KNOWN WALL (plan §5.4): claude.ai's consent POST carries arkose+hcaptcha
//! attestation; automating the final consent click always 400s. We open the
//! window, isolate cookies, and navigate the OAuth page — the final human
//! click on the sign-in page is the documented manual step.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gtk::gio;
use gtk::glib;
use gtk::prelude::*;
use webkit6::prelude::*;
use webkit6::{NetworkSession, WebView};

use crate::state;

/// One window per account; a second URL while open re-navigates + refocuses.
///
/// The window map lives behind an `Rc` so a window's own close-request handler
/// (a `'static` closure) can remove its entry — `LoginWebManager` is a field
/// of the controller and can't be captured by reference into a signal handler.
#[derive(Default)]
pub struct LoginWebManager {
    windows: Rc<RefCell<HashMap<String, gtk::Window>>>,
    /// Persistent NetworkSessions are kept alive for the process so their
    /// cookie jars stay open across re-logins of the same account.
    sessions: RefCell<HashMap<String, NetworkSession>>,
}

impl LoginWebManager {
    /// Open (or refocus + re-navigate) the OAuth window for `account_id`.
    pub fn open(&self, parent: &gtk::Window, account_id: &str, url: &str, label: &str) {
        if let Some(win) = self.windows.borrow().get(account_id) {
            if let Some(view) = web_view_of(win) {
                view.load_uri(url);
            }
            win.present();
            return;
        }

        let session = self
            .sessions
            .borrow_mut()
            .entry(account_id.to_string())
            .or_insert_with(|| new_persistent_session(account_id))
            .clone();

        let view = WebView::builder().network_session(&session).build();
        view.set_widget_name("account-login-web");
        normalize_user_agent(&view);

        attach_context_menu(&view);

        // IdP popups ("Continue with Google") inherit the same session so the
        // isolation holds; non-web schemes go to the OS. Returning a widget
        // keeps the popup in-app; returning None denies it.
        {
            let session = session.clone();
            view.connect_create(move |_view, action| {
                let child_url = action
                    .request()
                    .and_then(|r| r.uri())
                    .map(|u| u.to_string())
                    .unwrap_or_default();
                if child_url.starts_with("https:") || child_url.starts_with("http:") {
                    let popup = WebView::builder().network_session(&session).build();
                    normalize_user_agent(&popup);
                    attach_context_menu(&popup);
                    let win = gtk::Window::builder()
                        .default_width(560)
                        .default_height(760)
                        .title("Log in")
                        .child(&popup)
                        .build();
                    win.present();
                    return Some(popup.upcast());
                }
                open_external(&child_url);
                None
            });
        }

        let window = gtk::Window::builder()
            .title(format!("Log in — {label}"))
            .default_width(560)
            .default_height(760)
            .transient_for(parent)
            .child(&view)
            .build();
        window.set_widget_name(&format!("account-login-web-window-{account_id}"));
        window.add_css_class("account-login-web-window");

        // Drop our entry when the window is closed by the WM.
        {
            let account_id = account_id.to_string();
            let windows = self.windows.clone();
            window.connect_close_request(move |_| {
                windows.borrow_mut().remove(&account_id);
                glib::Propagation::Proceed
            });
        }

        view.load_uri(url);
        window.present();
        self.windows
            .borrow_mut()
            .insert(account_id.to_string(), window);
    }

    /// Close an account's OAuth window if open (login watcher detected the
    /// token, or the login PTY stopped).
    pub fn close(&self, account_id: &str) {
        if let Some(win) = self.windows.borrow_mut().remove(account_id) {
            win.close();
        }
    }
}

/// Build a persistent NetworkSession rooted at this account's partition dir.
/// Both the data and cache directories live under
/// `<orchestra_home>/gtk-login-partitions/<id>` so E2E can point ORCHESTRA_HOME
/// at a temp dir and assert two accounts produce two on-disk cookie jars.
fn new_persistent_session(account_id: &str) -> NetworkSession {
    let base = state::orchestra_home()
        .join("gtk-login-partitions")
        .join(sanitize(account_id));
    let data = base.join("data");
    let cache = base.join("cache");
    let _ = std::fs::create_dir_all(&data);
    let _ = std::fs::create_dir_all(&cache);
    NetworkSession::new(data.to_str(), cache.to_str())
}

/// Keep a partition id filesystem-safe (account ids are UUIDs today, but be
/// defensive — a stray `/` would escape the partitions dir).
fn sanitize(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Strip the Electron/Orchestra tokens from the WebView's user agent so it
/// reads as plain Chrome (`login-browser.ts:36`). WebKitGTK's default UA has
/// no such tokens, but a caller may have set one; normalize defensively and,
/// when the default is empty, leave WebKit's own UA in place.
fn normalize_user_agent(view: &WebView) {
    let Some(settings) = webkit6::prelude::WebViewExt::settings(view) else {
        return;
    };
    if let Some(ua) = settings.user_agent() {
        let cleaned = strip_webview_markers(ua.as_str());
        if cleaned != ua.as_str() {
            settings.set_user_agent(Some(&cleaned));
        }
    }
}

/// Pure port of the UA-strip regex `/\s(?:Electron|Orchestra)\/\S+/gi` — remove
/// every ` Electron/x.y` / ` Orchestra/x.y` token (case-insensitive), where the
/// version run is any non-whitespace. Unit-tested against node-computed vectors.
pub fn strip_webview_markers(ua: &str) -> String {
    let bytes = ua.as_bytes();
    let mut out = String::with_capacity(ua.len());
    let mut i = 0;
    while i < bytes.len() {
        // A match starts at a whitespace followed by the marker word.
        if bytes[i].is_ascii_whitespace() {
            if let Some(after) = match_marker(bytes, i + 1) {
                // Require the `/<non-space>+` run after the word.
                if bytes.get(after) == Some(&b'/') {
                    let mut j = after + 1;
                    let run_start = j;
                    while j < bytes.len() && !bytes[j].is_ascii_whitespace() {
                        j += 1;
                    }
                    if j > run_start {
                        // Whole ` Word/run` is dropped.
                        i = j;
                        continue;
                    }
                }
            }
        }
        // Not a marker: copy this UTF-8 char whole.
        let ch_len = utf8_len(bytes[i]);
        out.push_str(&ua[i..i + ch_len]);
        i += ch_len;
    }
    out
}

/// If `Electron`/`Orchestra` (case-insensitive) begins at `start`, return the
/// index just past the word; else None.
fn match_marker(bytes: &[u8], start: usize) -> Option<usize> {
    for word in [b"electron".as_slice(), b"orchestra".as_slice()] {
        if bytes.len() >= start + word.len()
            && bytes[start..start + word.len()]
                .iter()
                .zip(word)
                .all(|(a, b)| a.to_ascii_lowercase() == *b)
        {
            return Some(start + word.len());
        }
    }
    None
}

fn utf8_len(first: u8) -> usize {
    match first {
        b if b < 0x80 => 1,
        b if b >> 5 == 0b110 => 2,
        b if b >> 4 == 0b1110 => 3,
        _ => 4,
    }
}

/// Right-click menu: Back / Reload / Copy URL / Open in system browser, the
/// GTK mirror of `login-browser.ts:attachContextMenu`. Returning `true` from
/// the handler installs our custom menu.
fn attach_context_menu(view: &WebView) {
    view.connect_context_menu(|view, menu, _hit| {
        menu.remove_all();
        let url = view.uri().map(|u| u.to_string()).unwrap_or_default();

        let group = gio::SimpleActionGroup::new();

        let back = gio::SimpleAction::new("back", None);
        {
            let view = view.clone();
            back.connect_activate(move |_, _| {
                if view.can_go_back() {
                    view.go_back();
                }
            });
        }
        back.set_enabled(view.can_go_back());
        group.add_action(&back);

        let reload = gio::SimpleAction::new("reload", None);
        {
            let view = view.clone();
            reload.connect_activate(move |_, _| view.reload());
        }
        group.add_action(&reload);

        let copy = gio::SimpleAction::new("copy_url", None);
        {
            let view = view.clone();
            let url = url.clone();
            copy.connect_activate(move |_, _| {
                view.clipboard().set_text(&url);
            });
        }
        group.add_action(&copy);

        let external = gio::SimpleAction::new("open_external", None);
        {
            let url = url.clone();
            external.connect_activate(move |_, _| open_external(&url));
        }
        group.add_action(&external);

        // The menu items reference the "ctx." action group installed on the
        // view for the menu's lifetime.
        view.insert_action_group("ctx", Some(&group));

        menu.append(&webkit6::ContextMenuItem::from_gaction(&back, "Back", None));
        menu.append(&webkit6::ContextMenuItem::from_gaction(
            &reload, "Reload", None,
        ));
        menu.append(&webkit6::ContextMenuItem::from_gaction(
            &copy, "Copy URL", None,
        ));
        menu.append(&webkit6::ContextMenuItem::from_gaction(
            &external,
            "Open in system browser",
            None,
        ));
        true
    });
}

/// Hand a URL to the system browser (the escape hatch + non-web child URLs).
fn open_external(url: &str) {
    if url.is_empty() {
        return;
    }
    if let Err(e) = gio::AppInfo::launch_default_for_uri(url, gio::AppLaunchContext::NONE) {
        eprintln!("[accounts] open-external {url}: {e}");
    }
}

/// The direct WebView child of a login window, if any (for re-navigation).
fn web_view_of(win: &gtk::Window) -> Option<WebView> {
    win.child().and_then(|c| c.downcast::<WebView>().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vectors computed by running the literal TS regex under node:
    //   ua.replace(/\s(?:Electron|Orchestra)\/\S+/gi, '')
    #[test]
    fn strip_webview_markers_matches_ts_regex() {
        let cases = [
            (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Electron/32.1.0 Orchestra/0.5.90 Safari/537.36",
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Safari/537.36",
            ),
            (
                "Chrome/120.0.0.0 Electron/28.0.0",
                "Chrome/120.0.0.0",
            ),
            // Case-insensitive.
            ("A/1 electron/9 B/2", "A/1 B/2"),
            ("A/1 ORCHESTRA/9.9 B/2", "A/1 B/2"),
            // No marker → unchanged.
            ("Mozilla/5.0 Chrome/120", "Mozilla/5.0 Chrome/120"),
            // Word without the `/run` isn't a token.
            ("plain Electron here", "plain Electron here"),
            // Two markers back-to-back.
            ("X/1 Electron/2 Orchestra/3", "X/1"),
        ];
        for (input, expected) in cases {
            assert_eq!(strip_webview_markers(input), expected, "UA {input:?}");
        }
    }

    #[test]
    fn sanitize_keeps_partitions_contained() {
        assert_eq!(sanitize("a1b2-c3"), "a1b2-c3");
        assert_eq!(sanitize("../escape"), ".._escape");
        assert_eq!(sanitize("a/b"), "a_b");
    }
}
