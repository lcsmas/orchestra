//! Accounts, usage metering, and the per-account login flow (plan §5.4).
//!
//! Structure mirrors the Electron renderer's component split:
//!
//! - [`usage_bars`] — the 5h/7d(/Fable) strip + all-accounts hover panel
//!   (`UsageBars.tsx`).
//! - [`settings`] — the accounts CRUD window (`AccountsSettings.tsx`).
//! - [`login_modal`] — feed-mode VTE hosting the `account-login:<id>` PTY
//!   (`AccountLoginModal.tsx`).
//! - [`login_web`] — per-account WebKitGTK OAuth windows, the GTK-side
//!   replacement for `src/main/login-browser.ts` (§4 login-browser bridge).
//! - [`badge`] — workspace/repo account badges + the migrate menu
//!   (`AccountBadge.tsx`), reusable by the sidebar workstream.
//! - [`logic`] — the pure ports, parity-tested against the TS originals.
//!
//! One [`AccountsController`] owns the renderer-store slice of this domain
//! (accounts, per-account usage, workspace→account map, global usage) and
//! every open accounts window. The app shell forwards backend events and
//! login-PTY bytes here; components call back into the controller for RPC.

pub mod badge;
pub mod logic;
pub mod login_modal;
pub mod login_web;
pub mod settings;
pub mod usage_bars;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gtk::glib;
use gtk::prelude::*;
use serde::de::DeserializeOwned;
use serde_json::Value;

use orchestra_rpc::events::UiEvent;
use orchestra_rpc::types::{Account, AccountUsageStatus, UsageSnapshot, WorkspaceAccount};

use crate::backend::Backend;

/// The store slice this domain renders from — the GTK mirror of the Zustand
/// slices `UsageBars.tsx`/`AccountBadge.tsx` subscribe to.
#[derive(Debug, Default)]
pub struct AccountsState {
    pub accounts: Vec<Account>,
    pub account_usage: HashMap<String, AccountUsageStatus>,
    pub workspace_accounts: HashMap<String, WorkspaceAccount>,
    pub global_usage: Option<UsageSnapshot>,
    pub active_workspace: Option<String>,
}

impl AccountsState {
    /// Label for an account id, if the account still exists.
    pub fn account_label(&self, id: &str) -> Option<String> {
        self.accounts
            .iter()
            .find(|a| a.id == id)
            .map(|a| a.label.clone())
    }
}

pub struct AccountsController {
    backend: Rc<dyn Backend>,
    main_window: gtk::Window,
    state: RefCell<AccountsState>,
    usage_bars: usage_bars::UsageBars,
    login_web: login_web::LoginWebManager,
    login_modal: RefCell<Option<login_modal::LoginModal>>,
    /// Repaint hooks of live badges/menus (sidebar rows register here);
    /// invoked with the fresh state on every store change.
    listeners: RefCell<Vec<Box<dyn Fn(&AccountsState, i64)>>>,
}

impl AccountsController {
    pub fn new(backend: Rc<dyn Backend>, main_window: gtk::Window) -> Rc<Self> {
        let ctrl = Rc::new(Self {
            backend,
            main_window,
            state: RefCell::new(AccountsState::default()),
            usage_bars: usage_bars::UsageBars::new(),
            login_web: login_web::LoginWebManager::default(),
            login_modal: RefCell::new(None),
            listeners: RefCell::new(Vec::new()),
        });
        ctrl.usage_bars.wire(&ctrl);
        ctrl
    }

    /// Epoch ms "now" — the GTK stand-in for `Date.now()`.
    pub fn now_ms() -> i64 {
        glib::real_time() / 1000
    }

    /// The usage-bars strip widget for the sidebar footer.
    pub fn usage_bars_root(&self) -> gtk::Widget {
        self.usage_bars.root().clone().upcast()
    }

    pub fn main_window(&self) -> &gtk::Window {
        &self.main_window
    }

    /// Initial hydration, mirroring what the Electron renderer pulls on load.
    /// Every call degrades gracefully — an unwired/errored backend just means
    /// empty slices (the bars hide themselves, settings shows the error).
    pub fn bootstrap(self: &Rc<Self>) {
        {
            let mut st = self.state.borrow_mut();
            if let Ok(accounts) = self.call_typed::<Vec<Account>>("listAccounts", vec![]) {
                st.accounts = accounts;
            }
            if let Ok(usage) = self.call_typed::<Option<UsageSnapshot>>("getUsage", vec![]) {
                st.global_usage = usage;
            }
            if let Ok(map) =
                self.call_typed::<HashMap<String, AccountUsageStatus>>("getAllAccountUsage", vec![])
            {
                st.account_usage = map;
            }
            if let Ok(map) =
                self.call_typed::<HashMap<String, WorkspaceAccount>>("getWorkspaceAccounts", vec![])
            {
                st.workspace_accounts = map;
            }
        }
        self.render();

        // Minute tick: refresh the relative stamps ("updated Xm ago",
        // countdowns) like the TS components' 60s setInterval.
        let weak = Rc::downgrade(self);
        glib::timeout_add_seconds_local(60, move || match weak.upgrade() {
            Some(ctrl) => {
                ctrl.render();
                glib::ControlFlow::Continue
            }
            None => glib::ControlFlow::Break,
        });
    }

    pub fn set_active_workspace(self: &Rc<Self>, id: Option<String>) {
        self.state.borrow_mut().active_workspace = id;
        self.render();
    }

    /// Badges/menus born after bootstrap register their repaint hook here and
    /// get an immediate first paint.
    pub fn add_render_listener(self: &Rc<Self>, f: Box<dyn Fn(&AccountsState, i64)>) {
        f(&self.state.borrow(), Self::now_ms());
        self.listeners.borrow_mut().push(f);
    }

    fn render(self: &Rc<Self>) {
        let now = Self::now_ms();
        let st = self.state.borrow();
        self.usage_bars.update(&st, now);
        for l in self.listeners.borrow().iter() {
            l(&st, now);
        }
    }

    // ---- backend plumbing ----------------------------------------------------

    /// Generic call with a typed result. Errors become strings (the same
    /// message the Electron renderer would surface from a rejected promise).
    pub(crate) fn call_typed<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Vec<Value>,
    ) -> Result<T, String> {
        let v = self
            .backend
            .call(method, params)
            .map_err(|e| e.to_string())?;
        serde_json::from_value(v).map_err(|e| format!("{method}: bad result shape: {e}"))
    }

    /// Fire-and-forget call where only success/failure matters.
    pub(crate) fn call_unit(&self, method: &str, params: Vec<Value>) -> Result<(), String> {
        self.backend
            .call(method, params)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub(crate) fn pty_write(&self, id: &str, bytes: &[u8]) {
        if let Err(e) = self.backend.pty_write(id, bytes) {
            eprintln!("[accounts] ptyWrite {id}: {e}");
        }
    }

    // ---- windows ---------------------------------------------------------------

    pub fn open_settings(self: &Rc<Self>) {
        settings::open(self);
    }

    /// Open the `claude /login` terminal modal for an account (settings' Login
    /// button). One at a time — a second request refocuses the first.
    pub fn open_login_modal(self: &Rc<Self>, account_id: &str, label: &str) {
        if let Some(modal) = self.login_modal.borrow().as_ref() {
            if modal.account_id() == account_id {
                modal.present();
                return;
            }
        }
        // Different account: drop (closes) any previous modal first.
        self.close_login_modal();
        let modal = login_modal::LoginModal::open(self, account_id, label);
        *self.login_modal.borrow_mut() = Some(modal);
    }

    /// Called by the modal when it is closing (any path). Stops the PTY and
    /// closes the account's OAuth window, like the TS cleanup + loginStop.
    pub(crate) fn login_modal_closed(self: &Rc<Self>, account_id: &str) {
        self.login_modal.borrow_mut().take();
        let _ = self.call_unit("accountLoginStop", vec![Value::from(account_id)]);
        self.login_web.close(account_id);
    }

    /// Drop the current modal (if any) as part of opening a different one:
    /// close it silently and run the same PTY-stop + OAuth-close cleanup its
    /// own close path would, without recursing back through the modal.
    fn close_login_modal(self: &Rc<Self>) {
        if let Some(modal) = self.login_modal.borrow_mut().take() {
            let account_id = modal.account_id().to_string();
            modal.close_silent();
            let _ = self.call_unit("accountLoginStop", vec![Value::from(account_id.as_str())]);
            self.login_web.close(&account_id);
        }
    }

    // ---- event routing ---------------------------------------------------------

    /// Backend `event` frames relevant to this domain. The app shell calls
    /// this for every decoded event; irrelevant channels fall through.
    pub fn handle_event(self: &Rc<Self>, ev: &UiEvent) {
        match ev {
            UiEvent::UsageUpdate(snap) => {
                self.state.borrow_mut().global_usage = Some((**snap).clone());
                self.render();
            }
            UiEvent::AccountUsageUpdate(map) => {
                self.state.borrow_mut().account_usage = map.clone();
                self.render();
            }
            UiEvent::WorkspaceAccountsUpdate(map) => {
                self.state.borrow_mut().workspace_accounts = map.clone();
                self.render();
            }
            UiEvent::AccountLoginDone { account_id } => {
                // Token landed: the backend already stopped the PTY and its
                // watcher; close the modal + OAuth window and refresh badges.
                let matching = self
                    .login_modal
                    .borrow()
                    .as_ref()
                    .is_some_and(|m| m.account_id() == account_id);
                if matching {
                    if let Some(m) = self.login_modal.borrow_mut().take() {
                        m.close_silent();
                    }
                }
                self.login_web.close(account_id);
                let _ = self.call_unit("refreshAccounts", vec![]);
            }
            UiEvent::AccountsLoginUrl(req) => {
                let label = self
                    .state
                    .borrow()
                    .account_label(&req.account_id)
                    .unwrap_or_else(|| req.account_id.clone());
                self.login_web
                    .open(&self.main_window, &req.account_id, &req.url, &label);
            }
            UiEvent::PtyExit { id, code } => {
                if let Some(acct) = id.strip_prefix("account-login:") {
                    let matching = self
                        .login_modal
                        .borrow()
                        .as_ref()
                        .is_some_and(|m| m.account_id() == acct);
                    if matching {
                        if let Some(m) = self.login_modal.borrow().as_ref() {
                            m.on_pty_exit(*code);
                        }
                        // Freshly-authenticated badge fills in immediately
                        // (AccountLoginModal.tsx onPtyExit).
                        let _ = self.call_unit("refreshAccounts", vec![]);
                    }
                }
            }
            // JSON-form ptyData (fixtures / non-binary backends).
            UiEvent::PtyData { id, data } => {
                self.handle_pty_data(id, data.as_bytes());
            }
            _ => {}
        }
    }

    /// Binary `ptyData` frames. Only the login PTY is ours; workspace ids
    /// belong to the terminal workstream.
    pub fn handle_pty_data(self: &Rc<Self>, id: &str, bytes: &[u8]) {
        if let Some(acct) = id.strip_prefix("account-login:") {
            if let Some(m) = self.login_modal.borrow().as_ref() {
                if m.account_id() == acct {
                    m.feed(bytes);
                }
            }
        }
    }
}
