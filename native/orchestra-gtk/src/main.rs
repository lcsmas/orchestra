// Native GTK4 frontend for Orchestra — thin binary over the orchestra_gtk lib.
// See docs/gtk4-port-plan.md (§5.6 shell, §8.4 remote control) and
// native/README.md for the rootless build recipe.

use std::path::PathBuf;

use gtk::gio;
use orchestra_gtk::app::{App, Init};

fn main() {
    // Our own flags are parsed (and hidden from GTK) here; everything else is
    // ignored so future GTK/GLib args pass through harmlessly.
    let mut remote_control: Option<PathBuf> = None;
    let mut stop_daemon_on_exit = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--remote-control" {
            remote_control = args.next().map(PathBuf::from);
        } else if let Some(path) = arg.strip_prefix("--remote-control=") {
            remote_control = Some(PathBuf::from(path));
        } else if arg == "--stop-daemon-on-exit" {
            // Opt in to SIGTERMing a daemon WE spawned when the window closes.
            // Default off — plan §1.1 rule 3: agents keep running headless.
            stop_daemon_on_exit = true;
        }
    }

    // DBus single-instance for the FRONTEND (plan §5.6; the backend lock is
    // separate). Harness runs opt out: parallel smoke tests — sibling agents
    // run them concurrently on this machine — must not DBus-activate each
    // other's instance instead of launching their own.
    let flags = if remote_control.is_some() {
        gio::ApplicationFlags::NON_UNIQUE
    } else {
        gio::ApplicationFlags::default()
    };
    let gtk_app = gtk::Application::builder()
        .application_id("dev.orchestra.gtk")
        .flags(flags)
        .build();

    // The stylesheet is loaded in App::init — set_global_css needs an open
    // display, which from_app doesn't guarantee this early.
    let app = relm4::RelmApp::from_app(gtk_app).with_args(vec![]);
    app.run::<App>(Init {
        remote_control,
        stop_daemon_on_exit,
    });
}
