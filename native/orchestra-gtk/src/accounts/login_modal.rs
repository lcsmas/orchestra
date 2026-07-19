//! The `claude /login` terminal modal (`AccountLoginModal.tsx` port).
//!
//! A modal window hosting an interactive `claude /login` running inside an
//! account's config dir, over a dedicated login PTY (`account-login:<id>`).
//! The TS uses xterm; here we embed a minimal **feed-mode VTE** local to the
//! modal (plan §5.4 explicitly says not to wait for the terminal workstream's
//! shared module): PTY bytes go straight to `Terminal::feed`, keystrokes come
//! back through `connect_commit` and are written to the PTY. That's all a login
//! flow needs — no scrollback search, links, or the workspace terminal's agent
//! machinery.
//!
//! Lifecycle mirrors the TS: on open, size the VTE and call `accountLoginStart`
//! with the initial cols/rows; on PTY exit, print a notice and flip the button
//! to "Done"; while the PTY is alive a backdrop/decor close is the explicit
//! Close button only (a stray dismiss would kill an in-flight OAuth dance). All
//! close paths route through [`AccountsController::login_modal_closed`], which
//! stops the PTY and the OAuth window.

use std::cell::Cell;
use std::rc::Rc;

use gtk::glib;
use gtk::prelude::*;
use serde_json::Value;
use vte4::prelude::*;
use vte4::Terminal;

use super::AccountsController;

pub struct LoginModal {
    window: gtk::Window,
    terminal: Terminal,
    account_id: String,
    button: gtk::Button,
    /// True once the PTY has exited — gates the backdrop-close and the button
    /// label ("Close" → "Done").
    exited: Rc<Cell<bool>>,
    /// True while we intentionally tear down (silent close): suppresses the
    /// close-request handler's controller callback so we don't re-enter.
    closing: Rc<Cell<bool>>,
}

impl LoginModal {
    /// Open the login modal for `account_id` and kick off the PTY.
    pub fn open(ctrl: &Rc<AccountsController>, account_id: &str, label: &str) -> Self {
        let window = gtk::Window::builder()
            .modal(true)
            .transient_for(ctrl.main_window())
            .title(format!("Log in — {label}"))
            .default_width(760)
            .default_height(520)
            .build();
        window.set_widget_name("account-login-modal");
        window.add_css_class("account-login-modal");

        let content = gtk::Box::new(gtk::Orientation::Vertical, 0);

        // Header: title + subtitle explaining the isolated sign-in window.
        let header = gtk::Box::new(gtk::Orientation::Vertical, 2);
        header.add_css_class("modal-header");
        let title = gtk::Label::new(Some(&format!("Log in — {label}")));
        title.add_css_class("modal-title");
        title.set_xalign(0.0);
        let sub = gtk::Label::new(Some(
            "Running `claude /login` in this account's config dir — the sign-in page opens \
             in an isolated window with its own session, so it won't reuse your browser's \
             claude.ai login",
        ));
        sub.add_css_class("modal-sub");
        sub.set_xalign(0.0);
        sub.set_wrap(true);
        header.append(&title);
        header.append(&sub);
        content.append(&header);

        // Feed-mode VTE.
        let terminal = Terminal::new();
        terminal.set_widget_name("account-login-term");
        terminal.add_css_class("account-login-term");
        terminal.set_input_enabled(true);
        terminal.set_scrollback_lines(5000);
        terminal.set_cursor_blink_mode(vte4::CursorBlinkMode::On);
        terminal.set_vexpand(true);
        terminal.set_hexpand(true);
        terminal.set_color_background(&gtk::gdk::RGBA::new(0.102, 0.122, 0.149, 1.0)); // #1a1f26
        terminal.set_color_foreground(&gtk::gdk::RGBA::new(0.902, 0.914, 0.937, 1.0)); // #e6e9ef
        content.append(&terminal);

        // Footer with the Close/Done button.
        let footer = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        footer.add_css_class("modal-footer");
        footer.set_halign(gtk::Align::End);
        let button = gtk::Button::with_label("Close");
        button.set_widget_name("account-login-close");
        button.add_css_class("suggested");
        footer.append(&button);
        content.append(&footer);

        window.set_child(Some(&content));

        let exited = Rc::new(Cell::new(false));
        let closing = Rc::new(Cell::new(false));

        // Keystrokes → PTY (the VTE is display-only; we own the write path).
        {
            let ctrl = ctrl.clone();
            let pty_id = format!("account-login:{account_id}");
            terminal.connect_commit(move |_term, text, _size| {
                ctrl.pty_write(&pty_id, text.as_bytes());
            });
        }

        // Close button: user-initiated close.
        {
            let window = window.clone();
            button.connect_clicked(move |_| window.close());
        }

        // Window close: while the PTY is alive, only the button (or an event
        // close) should get here — either way route through the controller so
        // it stops the PTY + OAuth window, unless we're tearing down silently.
        {
            let ctrl = ctrl.clone();
            let account_id = account_id.to_string();
            let closing = closing.clone();
            window.connect_close_request(move |_| {
                if !closing.get() {
                    ctrl.clone().login_modal_closed(&account_id);
                }
                glib::Propagation::Proceed
            });
        }

        window.present();
        terminal.grab_focus();

        // Kick the PTY once the VTE has a real size. VTE lays out on the frame
        // clock, so defer a tick and read its cell grid; fall back to 80×24.
        {
            let ctrl = ctrl.clone();
            let terminal = terminal.clone();
            let account_id = account_id.to_string();
            glib::idle_add_local_once(move || {
                // VTE cell grid. Fall back to 80×24 until the widget has laid
                // out its first frame.
                let cols = terminal.column_count();
                let rows = terminal.row_count();
                let (cols, rows) = if cols < 2 || rows < 2 {
                    (80, 24)
                } else {
                    (cols, rows)
                };
                if let Err(e) = ctrl.call_unit(
                    "accountLoginStart",
                    vec![
                        Value::from(account_id.as_str()),
                        Value::from(cols),
                        Value::from(rows),
                    ],
                ) {
                    terminal.feed(
                        format!("\r\n\x1b[31mFailed to start login: {e}\x1b[0m\r\n").as_bytes(),
                    );
                }
            });
        }

        Self {
            window,
            terminal,
            account_id: account_id.to_string(),
            button,
            exited,
            closing,
        }
    }

    pub fn account_id(&self) -> &str {
        &self.account_id
    }

    /// Re-focus an already-open modal (a repeat Login for the same account).
    pub fn present(&self) {
        self.window.present();
    }

    /// Feed a chunk of PTY output into the terminal.
    pub fn feed(&self, bytes: &[u8]) {
        self.terminal.feed(bytes);
    }

    /// The login PTY exited: print a notice, flip the button to "Done", and
    /// mark exited so a backdrop close now dismisses freely.
    pub fn on_pty_exit(&self, code: i32) {
        self.terminal.feed(
            format!(
                "\r\n\x1b[33m[login session ended (code {code}) — you can close this]\x1b[0m\r\n"
            )
            .as_bytes(),
        );
        self.exited.set(true);
        self.button.set_label("Done");
    }

    /// Close without re-triggering the controller cleanup (used when the
    /// controller itself is closing us, e.g. on `accountLoginDone`).
    pub fn close_silent(&self) {
        self.closing.set(true);
        self.window.close();
    }
}
