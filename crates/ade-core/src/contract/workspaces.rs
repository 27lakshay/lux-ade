//! Workspace and catalog contracts.
use super::{FrameSpec, OperationSpec, Tier};
use crate::model::Catalogue;
use crate::provider::Descriptor;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![OperationSpec::new::<CatalogGetRequest, CatalogFrame>(
        "catalog.get",
        Tier::Query,
    )]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![FrameSpec::new::<CatalogFrame>("catalog")]
}

/// `catalog.get`: read the profile's workspaces, conversations and windows.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct CatalogGetRequest {}

wire_tag!(CatalogTag, "catalog");

/// The `catalog.get` reply and the `catalog` feed frame.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct CatalogFrame {
    #[serde(rename = "type")]
    pub tag: CatalogTag,
    pub catalog: Catalogue,
    pub providers: Vec<Descriptor>,
    pub boot_id: String,
    pub revision: u64,
}
