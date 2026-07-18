//! Mirrors of the Linear-integration shapes in `src/shared/types.ts`.

use serde::{Deserialize, Serialize};

/// `LinearIssue` (`types.ts:321`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearIssue {
    /// Canonical issue identifier, e.g. `NMC-261`.
    pub identifier: String,
    pub url: String,
    pub title: String,
}

/// `LinearKeySource` (`types.ts:351`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinearKeySource {
    Stored,
    Env,
    None,
}

/// `LinearKeyCheck` (`types.ts:354`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearKeyCheck {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
