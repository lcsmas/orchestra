//! Native GTK4 frontend for Orchestra (plan: docs/gtk4-port-plan.md, M1-A3).
//!
//! Library + thin binary split so the modules are unit-testable and the
//! dead-code lint sees the public surface M2 workstreams will consume.

pub mod accounts;
pub mod app;
pub mod backend;
pub mod banners;
pub mod ctx;
pub mod dialogs;
pub mod diff;
pub mod main_pane;
pub mod remote_control;
pub mod sidebar;
pub mod state;
pub mod toolbar;
pub mod usage_limit;
