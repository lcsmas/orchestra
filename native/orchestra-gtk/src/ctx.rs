//! Shared context for the main-pane widget tree (toolbar / diff / banners):
//! one handle to the backend seam plus the toplevel window (dialog parent,
//! visibility checks for the visible-polls). Kept deliberately thin — it IS
//! the point where the B2 async transport slots in later: every widget calls
//! through [`Ctx::call`], so swapping the synchronous seam for the connection
//! actor touches exactly one place.

use std::cell::RefCell;
use std::rc::Rc;

use orchestra_rpc::types::Workspace;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::backend::Backend;

pub struct Ctx {
    pub window: gtk::Window,
    backend: RefCell<Option<Rc<dyn Backend>>>,
    /// Hook for mutations that return an updated `Workspace` (queuePrompt,
    /// switchBranch, …): the app shell wires this to refresh its list + the
    /// main pane so every surface sees the new state at once.
    on_workspace_mutated: RefCell<Option<Box<dyn Fn(Workspace)>>>,
}

impl Ctx {
    pub fn new(window: gtk::Window) -> Rc<Self> {
        Rc::new(Self {
            window,
            backend: RefCell::new(None),
            on_workspace_mutated: RefCell::new(None),
        })
    }

    pub fn set_backend(&self, backend: Option<Rc<dyn Backend>>) {
        *self.backend.borrow_mut() = backend;
    }

    pub fn backend(&self) -> Option<Rc<dyn Backend>> {
        self.backend.borrow().clone()
    }

    /// Generic `OrchestraAPI` call (docs/ui-rpc-protocol.md §4).
    pub fn call(&self, method: &str, params: Vec<Value>) -> Result<Value, String> {
        match self.backend() {
            Some(b) => b.call(method, params).map_err(|e| e.to_string()),
            None => Err("no backend attached".into()),
        }
    }

    /// [`Ctx::call`] + deserialize into the typed mirror.
    pub fn call_typed<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Vec<Value>,
    ) -> Result<T, String> {
        let v = self.call(method, params)?;
        serde_json::from_value(v).map_err(|e| format!("{method}: bad response shape: {e}"))
    }

    pub fn set_on_workspace_mutated(&self, f: impl Fn(Workspace) + 'static) {
        *self.on_workspace_mutated.borrow_mut() = Some(Box::new(f));
    }

    pub fn notify_workspace_mutated(&self, ws: Workspace) {
        if let Some(f) = self.on_workspace_mutated.borrow().as_ref() {
            f(ws);
        }
    }

    /// Frontend-local `openExternal` (protocol §4: frontends SHOULD open
    /// locally rather than round-trip the backend).
    pub fn open_external(&self, url: &str) {
        gtk::UriLauncher::new(url).launch(
            Some(&self.window),
            gtk::gio::Cancellable::NONE,
            |res| {
                if let Err(e) = res {
                    eprintln!("[open-external] {e}");
                }
            },
        );
    }

    /// Keystrokes into a workspace PTY (the 0x02 fast path).
    pub fn pty_write(&self, id: &str, bytes: &[u8]) {
        if let Some(b) = self.backend() {
            if let Err(e) = b.pty_write(id, bytes) {
                eprintln!("[pty-write] {id}: {e}");
            }
        }
    }
}
