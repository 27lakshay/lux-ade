//! Typed wire contracts: the single authority for daemon operations and feed frames (D02).
//!
//! Each domain submodule owns its request, response and frame types and lists
//! them as [`OperationSpec`]s and [`FrameSpec`]s. [`DOMAINS`] is the only shared
//! list, so parallel work on different domains does not edit one central file.
//! [`bundle`] renders every contract as one JSON Schema bundle, which
//! `pnpm contract:generate` turns into `packages/contracts`.
use schemars::{JsonSchema, Schema, SchemaGenerator, generate::SchemaSettings};
use serde::Serialize;
use serde_json::{Map, Value, json};

/// A one-value string type for a reply's `type` tag. Schemars ignores
/// `#[serde(tag)]` on structs, so tagged replies carry the tag as a field.
macro_rules! wire_tag {
    ($name:ident, $value:literal) => {
        #[doc = concat!("The `", $value, "` type tag.")]
        #[derive(
            serde::Serialize,
            serde::Deserialize,
            schemars::JsonSchema,
            Clone,
            Copy,
            Debug,
            Default,
            PartialEq,
            Eq,
        )]
        #[schemars(inline)]
        pub enum $name {
            #[default]
            #[serde(rename = $value)]
            Tag,
        }
    };
}

pub mod accounts;
pub mod activity;
pub mod agents;
pub mod browser;
pub mod checkpoints;
pub mod commands;
pub mod context;
pub mod conversations;
pub mod daemon;
pub mod devices;
pub mod files;
pub mod history;
pub mod hooks;
pub mod mcp;
pub mod orchestration;
pub mod placement;
pub mod plugins;
pub mod providers;
pub mod remote;
pub mod repository;
pub mod resources;
pub mod retention;
pub mod review;
pub mod scripts;
pub mod services;
pub mod skills;
pub mod terminals;
pub mod usage;
pub mod workspaces;
pub mod worktrees;

/// Every domain that declares contracts, in bundle order.
pub const DOMAINS: &[Domain] = &[
    Domain {
        name: "workspaces",
        operations: workspaces::operations,
        frames: workspaces::frames,
    },
    Domain {
        name: "conversations",
        operations: conversations::operations,
        frames: conversations::frames,
    },
    Domain {
        name: "agents",
        operations: agents::operations,
        frames: agents::frames,
    },
    Domain {
        name: "accounts",
        operations: accounts::operations,
        frames: accounts::frames,
    },
    Domain {
        name: "terminals",
        operations: terminals::operations,
        frames: terminals::frames,
    },
    Domain {
        name: "services",
        operations: services::operations,
        frames: services::frames,
    },
    Domain {
        name: "review",
        operations: review::operations,
        frames: review::frames,
    },
    Domain {
        name: "worktrees",
        operations: worktrees::operations,
        frames: worktrees::frames,
    },
    Domain {
        name: "scripts",
        operations: scripts::operations,
        frames: scripts::frames,
    },
    Domain {
        name: "files",
        operations: files::operations,
        frames: files::frames,
    },
    Domain {
        name: "daemon",
        operations: daemon::operations,
        frames: daemon::frames,
    },
    Domain {
        name: "activity",
        operations: activity::operations,
        frames: activity::frames,
    },
    Domain {
        name: "mcp",
        operations: mcp::operations,
        frames: mcp::frames,
    },
    Domain {
        name: "skills",
        operations: skills::operations,
        frames: skills::frames,
    },
    Domain {
        name: "plugins",
        operations: plugins::operations,
        frames: plugins::frames,
    },
    Domain {
        name: "orchestration",
        operations: orchestration::operations,
        frames: orchestration::frames,
    },
    Domain {
        name: "history",
        operations: history::operations,
        frames: history::frames,
    },
    Domain {
        name: "resources",
        operations: resources::operations,
        frames: resources::frames,
    },
    Domain {
        name: "checkpoints",
        operations: checkpoints::operations,
        frames: checkpoints::frames,
    },
    Domain {
        name: "usage",
        operations: usage::operations,
        frames: usage::frames,
    },
    Domain {
        name: "remote",
        operations: remote::operations,
        frames: remote::frames,
    },
    Domain {
        name: "retention",
        operations: retention::operations,
        frames: retention::frames,
    },
    Domain {
        name: "browser",
        operations: browser::operations,
        frames: browser::frames,
    },
    Domain {
        name: "repository",
        operations: repository::operations,
        frames: repository::frames,
    },
    Domain {
        name: "hooks",
        operations: hooks::operations,
        frames: hooks::frames,
    },
    Domain {
        name: "providers",
        operations: providers::operations,
        frames: providers::frames,
    },
    Domain {
        name: "devices",
        operations: devices::operations,
        frames: devices::frames,
    },
    Domain {
        name: "placement",
        operations: placement::operations,
        frames: placement::frames,
    },
    Domain {
        name: "commands",
        operations: commands::operations,
        frames: commands::frames,
    },
    Domain {
        name: "context",
        operations: context::operations,
        frames: context::frames,
    },
];

pub struct Domain {
    pub name: &'static str,
    pub operations: fn() -> Vec<OperationSpec>,
    pub frames: fn() -> Vec<FrameSpec>,
}

/// The durability tier of an operation (proposed architecture, section 4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    /// Reads state. Retrying is free.
    Query,
    /// Converges on the same state when repeated. Carries target and caller attribution.
    IdempotentCommand,
    /// Carries an operation ID, a daemon-computed fingerprint, a receipt and reconciliation.
    EffectCommand,
}

type SchemaFn = fn(&mut SchemaGenerator) -> Schema;

/// One daemon operation. The request type describes every field except `op`,
/// which the bundle adds from `name`.
pub struct OperationSpec {
    pub name: &'static str,
    pub tier: Tier,
    request: SchemaFn,
    response: SchemaFn,
}

impl OperationSpec {
    pub fn new<Request: JsonSchema, Response: JsonSchema>(name: &'static str, tier: Tier) -> Self {
        Self {
            name,
            tier,
            request: subschema::<Request>,
            response: subschema::<Response>,
        }
    }
}

/// One `session.subscribe` feed frame, identified by its `type` tag.
pub struct FrameSpec {
    pub kind: &'static str,
    frame: SchemaFn,
}

impl FrameSpec {
    pub fn new<Frame: JsonSchema>(kind: &'static str) -> Self {
        Self {
            kind,
            frame: subschema::<Frame>,
        }
    }
}

fn subschema<T: JsonSchema>(generator: &mut SchemaGenerator) -> Schema {
    generator.subschema_for::<T>()
}

/// JSON numbers above 2^53 - 1 lose precision in JavaScript clients.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const DEFINITIONS: &str = "#/$defs/";

/// Render every contract as one JSON Schema 2020-12 bundle.
///
/// Requests use the deserialize contract (what the daemon accepts) and
/// responses and frames use the serialize contract (what it sends). Both share
/// one `$defs` map; a type whose two contracts differ must be split.
pub fn bundle() -> Value {
    let mut requests = SchemaSettings::draft2020_12()
        .for_deserialize()
        .into_generator();
    let mut replies = SchemaSettings::draft2020_12()
        .for_serialize()
        .into_generator();
    let mut operations = Vec::new();
    let mut frames = Vec::new();
    let mut request_names = Vec::new();
    for domain in DOMAINS {
        for spec in (domain.operations)() {
            let request = reference(&(spec.request)(&mut requests));
            let response = reference(&(spec.response)(&mut replies));
            request_names.push((request.clone(), spec.name));
            operations.push(
                json!({"name": spec.name, "domain": domain.name, "tier": spec.tier,
                "request": request, "response": response}),
            );
        }
        for spec in (domain.frames)() {
            let frame = reference(&(spec.frame)(&mut replies));
            frames.push(json!({"type": spec.kind, "domain": domain.name, "frame": frame}));
        }
    }
    let mut definitions = replies.take_definitions(true);
    for (name, schema) in requests.take_definitions(true) {
        match definitions.get(&name) {
            Some(existing) if existing != &schema => {
                panic!("{name} has different request and reply schemas; split the type")
            }
            _ => {
                definitions.insert(name, schema);
            }
        }
    }
    for (name, op) in request_names {
        let request = definitions
            .get_mut(&name)
            .and_then(Value::as_object_mut)
            .unwrap_or_else(|| panic!("{op} request must be a named struct"));
        add_operation(request, &name, op);
    }
    let mut bundle = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "ade-contracts",
        "operations": operations,
        "frames": frames,
        "$defs": definitions,
    });
    safe_integers(&mut bundle["$defs"]);
    bundle
}

/// A request struct describes one operation's body; the wire line also carries
/// `op`. Unknown request fields are rejected at the client boundary.
fn add_operation(request: &mut Map<String, Value>, name: &str, op: &str) {
    assert!(
        request.get("type") == Some(&json!("object")),
        "{name} request must be an object"
    );
    let properties = request
        .entry("properties")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .expect("properties object");
    assert!(
        properties
            .insert("op".into(), json!({"const": op}))
            .is_none(),
        "{name} is shared by more than one operation"
    );
    let required = request
        .entry("required")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .expect("required array");
    required.insert(0, json!("op"));
    request.insert("additionalProperties".into(), json!(false));
}

fn reference(schema: &Schema) -> String {
    schema
        .get("$ref")
        .and_then(Value::as_str)
        .and_then(|reference| reference.strip_prefix(DEFINITIONS))
        .expect("contract types must be named structs")
        .to_owned()
}

/// Cap integers to the range JavaScript represents exactly, and drop the
/// Rust-specific `format` names (`uint64`, `int64`) that validators do not know.
fn safe_integers(value: &mut Value) {
    match value {
        Value::Object(object) => {
            let integer = match object.get("type") {
                Some(Value::String(kind)) => kind == "integer",
                Some(Value::Array(kinds)) => kinds.contains(&json!("integer")),
                _ => false,
            };
            if integer {
                object.remove("format");
                let minimum = object.get("minimum").and_then(Value::as_i64);
                object.insert(
                    "minimum".into(),
                    json!(minimum.map_or(-MAX_SAFE_INTEGER, |m| m.max(-MAX_SAFE_INTEGER))),
                );
                let maximum = object.get("maximum").and_then(Value::as_i64);
                object.insert(
                    "maximum".into(),
                    json!(maximum.map_or(MAX_SAFE_INTEGER, |m| m.min(MAX_SAFE_INTEGER))),
                );
            }
            object.values_mut().for_each(safe_integers);
        }
        Value::Array(items) => items.iter_mut().for_each(safe_integers),
        _ => {}
    }
}

#[cfg(test)]
mod tests;
