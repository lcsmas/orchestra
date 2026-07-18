//! Serde mirrors of the TypeScript wire types.
//!
//! Sources of truth: `src/shared/types.ts`, `src/shared/accounts.ts`,
//! `src/shared/self-tune.ts`, `src/shared/resources.ts`,
//! `src/shared/worktree-sizes.ts`, and `src/shared/ipc.ts` for method-shaped
//! results. Rules (plan §7): `rename_all = "camelCase"`, every TS-optional
//! field is `Option<T>`, unknown fields tolerated (serde's default — no
//! `deny_unknown_fields` anywhere), closed string unions become enums whose
//! renames match the TS literals exactly. Conformance fixtures
//! (`tests/conformance.rs`) are the drift gate.

pub mod accounts;
pub mod app;
pub mod git;
pub mod linear;
pub mod repo;
pub mod resources;
pub mod self_tune;
pub mod usage;
pub mod workspace;

pub use accounts::*;
pub use app::*;
pub use git::*;
pub use linear::*;
pub use repo::*;
pub use resources::*;
pub use self_tune::*;
pub use usage::*;
pub use workspace::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_tolerates_unknown_and_missing_fields() {
        let raw = r#"{
            "id":"x","name":"repo · branch","repoPath":"/r","worktreePath":"/w",
            "branch":"b","baseBranch":"main","createdAt":1752854400000,
            "status":"running","agent":"claude",
            "someFutureField":{"nested":true}
        }"#;
        let ws: Workspace = serde_json::from_str(raw).unwrap();
        assert_eq!(ws.status, WorkspaceStatus::Running);
        assert!(ws.host.is_none());
        assert!(!ws.is_scratch_like());
    }

    #[test]
    fn workspace_host_is_kind_tagged() {
        let h: WorkspaceHost =
            serde_json::from_str(r#"{"kind":"sandbox","endpoint":"ws://h:8787"}"#).unwrap();
        assert_eq!(
            h,
            WorkspaceHost::Sandbox {
                endpoint: "ws://h:8787".into()
            }
        );
        let local: WorkspaceHost = serde_json::from_str(r#"{"kind":"local"}"#).unwrap();
        assert_eq!(local, WorkspaceHost::Local);
    }

    #[test]
    fn optional_fields_skip_on_serialize() {
        let raw = r#"{
            "id":"x","name":"n","repoPath":"/r","worktreePath":"/w",
            "branch":"b","baseBranch":"main","createdAt":1,
            "status":"idle","agent":"claude"
        }"#;
        let ws: Workspace = serde_json::from_str(raw).unwrap();
        let v = serde_json::to_value(&ws).unwrap();
        assert!(
            v.get("archived").is_none(),
            "absent optional must not serialize as null"
        );
    }

    #[test]
    fn usage_error_kind_literals_match_ts() {
        for (kind, wire) in [
            (UsageErrorKind::NoDir, "\"no-dir\""),
            (UsageErrorKind::NotLoggedIn, "\"not-logged-in\""),
            (UsageErrorKind::NoScope, "\"no-scope\""),
            (UsageErrorKind::RateLimited, "\"rate-limited\""),
            (UsageErrorKind::Error, "\"error\""),
        ] {
            assert_eq!(serde_json::to_string(&kind).unwrap(), wire);
        }
    }

    #[test]
    fn pr_state_is_uppercase() {
        assert_eq!(
            serde_json::to_string(&PrState::Merged).unwrap(),
            "\"MERGED\""
        );
    }

    #[test]
    fn app_process_stat_type_field() {
        let s: AppProcessStat =
            serde_json::from_str(r#"{"type":"GPU","pid":42,"cpuPct":1.5,"memBytes":1024}"#)
                .unwrap();
        assert_eq!(s.process_type, "GPU");
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["type"], "GPU");
    }
}
