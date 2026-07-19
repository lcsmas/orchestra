//! Host grouping (plan §5.1) — pure port of `src/renderer/host-grouping.ts`:
//! the per-node sidebar sections a repo's workspaces bucket into when some of
//! them run in a sandbox. No GTK — unit-tested without a display.

use orchestra_rpc::types::WorkspaceHost;

/// Stable key for the machine a workspace runs on: `"local"` for the local
/// node-pty default (host absent or kind `local`), or `sandbox:<endpoint>`
/// for a sandbox-hosted one. Used to group a repo's workspaces by node and to
/// persist per-node collapse state (`hostKeyOf`).
pub fn host_key_of(host: Option<&WorkspaceHost>) -> String {
    match host {
        Some(WorkspaceHost::Sandbox { endpoint }) => format!("sandbox:{endpoint}"),
        _ => "local".into(),
    }
}

/// Human label for a node header. Local is "This machine"; a sandbox shows
/// its endpoint host (the ws:// URL's host:port), falling back to the raw
/// endpoint string when it isn't a parseable URL (`hostLabel`).
pub fn host_label(host_key: &str) -> String {
    if host_key == "local" {
        return "This machine".into();
    }
    let endpoint = host_key.strip_prefix("sandbox:").unwrap_or(host_key);
    match url_host(endpoint) {
        Some(host) if !host.is_empty() => host,
        _ => endpoint.to_string(),
    }
}

/// `new URL(endpoint).host` for the endpoint shapes we see (`ws://h:8787`,
/// with optional path/userinfo). None when there's no `scheme://` at all —
/// the TS `new URL` throws there and the caller falls back to the raw string.
fn url_host(endpoint: &str) -> Option<String> {
    let (_, rest) = endpoint.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    // Strip userinfo if present; the host:port part is what the TS shows.
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    Some(host.to_string())
}

/// Order items into per-node groups WITHOUT reordering within a node (the
/// user's drag order is preserved inside each group). Local always sorts
/// first; sandbox nodes follow in first-seen order. Returns `None` when every
/// item is local — the caller then renders the flat list unchanged, so the
/// common single-machine case shows no node headers at all (`groupByHost`).
pub fn group_by_host<T>(
    items: &[T],
    host_of: impl Fn(&T) -> Option<&WorkspaceHost>,
) -> Option<Vec<(String, Vec<usize>)>>
where
{
    let mut order: Vec<String> = Vec::new();
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let k = host_key_of(host_of(item));
        match order.iter().position(|o| o == &k) {
            Some(pos) => groups[pos].push(i),
            None => {
                order.push(k);
                groups.push(vec![i]);
            }
        }
    }
    // Nothing remote → no grouping; preserve the flat rendering exactly.
    if order.iter().all(|k| k == "local") {
        return None;
    }
    let mut zipped: Vec<(String, Vec<usize>)> = order.into_iter().zip(groups).collect();
    // Local first; sandbox nodes keep first-seen order (stable sort).
    zipped.sort_by_key(|(k, _)| (k != "local") as u8);
    Some(zipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(endpoint: &str) -> Option<WorkspaceHost> {
        Some(WorkspaceHost::Sandbox {
            endpoint: endpoint.into(),
        })
    }

    #[test]
    fn host_keys() {
        assert_eq!(host_key_of(None), "local");
        assert_eq!(host_key_of(Some(&WorkspaceHost::Local)), "local");
        assert_eq!(
            host_key_of(sandbox("ws://h:8787").as_ref()),
            "sandbox:ws://h:8787"
        );
    }

    #[test]
    fn host_labels() {
        assert_eq!(host_label("local"), "This machine");
        assert_eq!(
            host_label("sandbox:ws://sandbox-host:8787"),
            "sandbox-host:8787"
        );
        assert_eq!(host_label("sandbox:ws://h:8787/path"), "h:8787");
        // Unparseable endpoint falls back to the raw string.
        assert_eq!(host_label("sandbox:not a url"), "not a url");
    }

    #[test]
    fn all_local_yields_none() {
        // The flat-identical property the ledger calls out: an all-local repo
        // must render exactly the flat list, so grouping returns None.
        let items = vec![None, Some(WorkspaceHost::Local), None];
        assert!(group_by_host(&items, |h| h.as_ref()).is_none());
        let empty: Vec<Option<WorkspaceHost>> = vec![];
        assert!(group_by_host(&empty, |h| h.as_ref()).is_none());
    }

    #[test]
    fn local_first_then_sandboxes_in_first_seen_order() {
        let items = vec![
            sandbox("ws://b:1"),
            None,
            sandbox("ws://a:2"),
            sandbox("ws://b:1"),
            None,
        ];
        let groups = group_by_host(&items, |h| h.as_ref()).unwrap();
        let keys: Vec<&str> = groups.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["local", "sandbox:ws://b:1", "sandbox:ws://a:2"]);
        // Drag order preserved inside each group (indices ascending).
        assert_eq!(groups[0].1, vec![1, 4]);
        assert_eq!(groups[1].1, vec![0, 3]);
        assert_eq!(groups[2].1, vec![2]);
    }
}
