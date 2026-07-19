//! Desktop notifications (plan §5.5/§5.6 notifications item): GNotification
//! on `uiNotify` events.
//!
//! Focus parity comes for free: the backend's `fireFinished`/`fireNeedsInput`
//! (src/main/activity.ts) already suppress the notification when ANY client
//! reports focus (the `focus` frame, OR'd across clients), so every `uiNotify`
//! that reaches us is meant to be shown. Clicking the notification triggers
//! the app-level `focus-workspace` action, which presents the window and
//! selects the workspace.

use gtk::gio;
use gtk::glib;
use gtk::prelude::*;

use orchestra_rpc::types::{UiNotify, UiNotifyKind};

/// Install the `app.focus-workspace(<wsId>)` action the notifications target.
pub fn install_focus_action(app: &gtk::Application, on_focus: impl Fn(String) + 'static) {
    let action = gio::SimpleAction::new("focus-workspace", Some(glib::VariantTy::STRING));
    action.connect_activate(move |_, param| {
        if let Some(id) = param.and_then(|v| v.str()) {
            on_focus(id.to_string());
        }
    });
    app.add_action(&action);
}

/// Post (or replace) the notification for a workspace. One notification id
/// per workspace, so a follow-up "needs input" replaces a stale "finished"
/// instead of stacking — matching the Electron toast's practical behavior.
pub fn show(app: &gtk::Application, n: &UiNotify) {
    let notification = gio::Notification::new(&n.title);
    notification.set_body(Some(&n.body));
    notification.set_priority(match n.kind {
        UiNotifyKind::Finished => gio::NotificationPriority::Normal,
        UiNotifyKind::NeedsInput => gio::NotificationPriority::High,
    });
    notification
        .set_default_action_and_target_value("app.focus-workspace", Some(&n.ws_id.to_variant()));
    app.send_notification(Some(&format!("orchestra-ws-{}", n.ws_id)), &notification);
}
