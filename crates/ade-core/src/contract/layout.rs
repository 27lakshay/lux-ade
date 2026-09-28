//! Windows and layouts (F008, F011): which workspace each window shows, and
//! each window's panes and tabs for each workspace. The daemon owns them, so
//! the CLI, the SDK and any UI read and change the same layouts; a UI draws
//! them and turns gestures into commands.
//!
//! A tab names what it shows with a [`TabTarget`]; its title comes from the
//! target's own record. [`crate::layout::apply`] is the one implementation of
//! every [`LayoutAction`]; the daemon runs it and stores the result.
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<WindowListRequest, WindowList>("window.list", Tier::Query),
        // The caller names the window, so a retry finds the window it made.
        OperationSpec::new::<WindowCreateRequest, WindowAck>(
            "window.create",
            Tier::IdempotentCommand,
        ),
        // Closing keeps the record and its layouts; a repeat changes nothing.
        OperationSpec::new::<WindowCloseRequest, WindowAck>(
            "window.close",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<WindowReopenRequest, WindowAck>(
            "window.reopen",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<WindowSetBoundsRequest, WindowAck>(
            "window.set_bounds",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<WindowShowWorkspaceRequest, WindowAck>(
            "window.show_workspace",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<WindowSetViewStateRequest, WindowAck>(
            "window.set_view_state",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<LayoutGetRequest, LayoutReply>("layout.get", Tier::Query),
        // Callers supply every new ID, so a retry of an action that creates a
        // pane or tab finds it made. A toggle is retried safely with
        // `expected_revision`: the daemon recognises the repeat of its last
        // action from the same revision and returns that result.
        OperationSpec::new::<LayoutApplyRequest, LayoutApplied>(
            "layout.apply",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<LayoutReplaceRequest, LayoutApplied>(
            "layout.replace",
            Tier::IdempotentCommand,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![
        FrameSpec::new::<WindowChanged>("window_changed"),
        FrameSpec::new::<LayoutChanged>("layout_changed"),
        FrameSpec::new::<LayoutRemoved>("layout_removed"),
    ]
}

/// The schema of a field that is a value or null and always present. A
/// plain `Option` field is optional in the request contract and required in
/// the reply contract, and [`Layout`] travels both ways.
struct Nullable<T>(std::marker::PhantomData<T>);

impl<T: JsonSchema> JsonSchema for Nullable<T> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> std::borrow::Cow<'static, str> {
        <Option<T>>::schema_name()
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        <Option<T>>::json_schema(generator)
    }
}

/// What a tab shows. Records are named by ID; a file or diff by its path
/// inside the layout's workspace.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TabTarget {
    Conversation {
        id: String,
    },
    Terminal {
        id: String,
    },
    Browser {
        id: String,
    },
    File {
        path: String,
    },
    Diff {
        path: String,
        staged: bool,
    },
    /// A conversation not started yet: the composer for a new one.
    NewConversation,
}

/// Whether a window is on screen. A closed window keeps its record, its
/// bounds and its layouts, and comes back as it was on `window.reopen`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WindowState {
    Open,
    Closed,
}

/// A window's position and size, in screen points. The daemon checks only
/// that they are finite and positive; a UI applies its own minimum size.
// Floats in this module are plain JSON numbers in the schema: the bundle does
// not strip schemars' `double` format.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq)]
pub struct WindowBounds {
    #[schemars(with = "serde_json::Number")]
    pub x: f64,
    #[schemars(with = "serde_json::Number")]
    pub y: f64,
    #[schemars(with = "serde_json::Number")]
    pub width: f64,
    #[schemars(with = "serde_json::Number")]
    pub height: f64,
}

/// Per-window view state a second UI on the same window shares. Focus,
/// scroll, hover and drag state stay local to each UI.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default, PartialEq, Eq)]
pub struct WindowView {
    /// Project IDs whose rows the navigator shows collapsed.
    pub collapsed_projects: Vec<String>,
    /// Workspaces this window showed, most recent first; the first is the
    /// one it shows now.
    pub recent_workspaces: Vec<String>,
}

/// A window: which workspace it shows, where it is and its view state. Its
/// panes and tabs are in one [`LayoutRecord`] per workspace it has shown.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct Window {
    pub id: String,
    /// The workspace the window shows.
    pub workspace_id: String,
    pub state: WindowState,
    /// Null until a UI sets them.
    pub bounds: Option<WindowBounds>,
    pub view: WindowView,
}

/// The two sidebars. They only ever swap sides with each other and never hold panes.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SidebarId {
    Navigator,
    Inspector,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Left,
    Right,
}

/// `row`: side by side; `column`: stacked.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SplitDirection {
    Row,
    Column,
}

/// Where a dragged tab or pane lands on a pane: one of its edges (a split) or its centre.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DropZone {
    Left,
    Right,
    Top,
    Bottom,
    Centre,
}

/// An outer edge of the whole centre area.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Edge {
    Left,
    Right,
    Top,
    Bottom,
}

/// One tab: a stable ID in its layout and what it shows.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct Tab {
    pub id: String,
    pub target: TabTarget,
}

wire_tag!(PaneTag, "pane");
wire_tag!(SplitTag, "split");

/// A leaf of the pane tree: a strip of tabs.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct PaneNode {
    #[serde(rename = "type")]
    pub tag: PaneTag,
    pub id: String,
    /// Tab IDs, in strip order.
    pub tabs: Vec<String>,
    #[schemars(with = "Nullable<String>")]
    pub active: Option<String>,
}

/// Two or more nodes side by side (`row`) or stacked (`column`).
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct SplitNode {
    #[serde(rename = "type")]
    pub tag: SplitTag,
    pub id: String,
    pub direction: SplitDirection,
    pub children: Vec<LayoutNode>,
    /// Percentages of the split, one per child, summing to 100.
    #[schemars(with = "Vec<serde_json::Number>")]
    pub sizes: Vec<f64>,
}

/// A pane or a split, told apart by `type`. Each variant's struct carries its
/// own tag, so clients get one flat type per node.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum LayoutNode {
    Pane(PaneNode),
    Split(SplitNode),
}

impl LayoutNode {
    pub fn id(&self) -> &str {
        match self {
            Self::Pane(pane) => &pane.id,
            Self::Split(split) => &split.id,
        }
    }
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
pub struct SidebarFlags {
    pub navigator: bool,
    pub inspector: bool,
}

/// Sidebar widths in pixels, from 200 to 480.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
pub struct SidebarWidths {
    pub navigator: u32,
    pub inspector: u32,
}

/// One window's arrangement of one workspace: the sidebars and the tree of
/// panes in the centre with their tabs.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct Layout {
    /// `[left, right]`.
    pub sidebars: [SidebarId; 2],
    pub collapsed: SidebarFlags,
    pub widths: SidebarWidths,
    /// Every tab placed in a pane, by ID.
    pub tabs: BTreeMap<String, Tab>,
    pub root: LayoutNode,
    pub focused_pane: String,
    /// A pane shown alone across the whole centre, or null. Always the focused pane.
    #[schemars(with = "Nullable<String>")]
    pub maximized: Option<String>,
}

/// A stored layout: one per window and workspace, with a revision that
/// grows by one with each change.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct LayoutRecord {
    pub window_id: String,
    pub workspace_id: String,
    /// 0 for a layout never changed: the default the daemon gives a window
    /// the first time it shows a workspace.
    pub revision: u64,
    pub layout: Layout,
}

/// Every change to a layout. New pane and tab IDs come in with the action,
/// so applying it is deterministic and a retry finds what the first made.
/// Actions naming a pane, split or tab that is not there change nothing.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LayoutAction {
    SwapSidebars,
    /// Collapses or expands whichever sidebar is on that side.
    ToggleSide {
        side: Side,
    },
    SetCollapsed {
        sidebar: SidebarId,
        collapsed: bool,
    },
    /// Clamped to 200–480 and rounded to whole pixels.
    SetWidth {
        sidebar: SidebarId,
        #[schemars(with = "serde_json::Number")]
        width: f64,
    },
    /// Opens after the active tab of `pane_id` (the focused pane when
    /// omitted) and activates it. The target must exist
    /// (`tab_target_missing`). Opening a tab ID already in the layout with
    /// the same target activates it.
    OpenTab {
        tab: Tab,
        #[serde(default)]
        pane_id: Option<String>,
    },
    ActivateTab {
        tab_id: String,
    },
    /// Takes the tab out of its layout. A pane it empties goes, unless it is
    /// the last one.
    CloseTab {
        tab_id: String,
    },
    /// Moves a tab into a pane's strip at `index` (clamped to the strip).
    MoveTab {
        tab_id: String,
        pane_id: String,
        index: u64,
    },
    /// Drops a tab on a pane: its centre joins the pane, an edge splits it
    /// into a new pane `new_pane_id`.
    DropTab {
        tab_id: String,
        pane_id: String,
        zone: DropZone,
        new_pane_id: String,
    },
    SplitPane {
        pane_id: String,
        direction: SplitDirection,
        new_pane_id: String,
    },
    /// A pane dropped on another's centre trades places with it; on an edge
    /// it moves beside it.
    MovePane {
        pane_id: String,
        target_id: String,
        zone: DropZone,
    },
    SwapPanes {
        pane_id: String,
        target_id: String,
    },
    /// Gives a tab a new pane along an outer edge of the centre.
    DockTab {
        tab_id: String,
        edge: Edge,
        new_pane_id: String,
    },
    DockPane {
        pane_id: String,
        edge: Edge,
    },
    /// Closes the pane and its tabs. The last pane only empties.
    ClosePane {
        pane_id: String,
    },
    FocusPane {
        pane_id: String,
    },
    /// Sizes are percentages, one per child, each positive, summing to 100.
    SetSplitSizes {
        split_id: String,
        #[schemars(with = "Vec<serde_json::Number>")]
        sizes: Vec<f64>,
    },
    ToggleMaximize {
        pane_id: String,
    },
    /// One split, or every split when `split_id` is omitted.
    EqualizeSplits {
        #[serde(default)]
        split_id: Option<String>,
    },
    /// Sidebars back to their default sides, widths and open; splits even.
    /// Panes and tabs stay.
    ResetLayout,
}

/// `window.list`: every window of the profile, open and closed.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct WindowListRequest {}

wire_tag!(WindowListTag, "windows");
wire_tag!(WindowTag, "window");
wire_tag!(LayoutTag, "layout");
wire_tag!(WindowChangedTag, "window_changed");
wire_tag!(LayoutChangedTag, "layout_changed");
wire_tag!(LayoutRemovedTag, "layout_removed");

/// The `window.list` reply, in creation order.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WindowList {
    #[serde(rename = "type")]
    pub tag: WindowListTag,
    pub windows: Vec<Window>,
}

/// `window.create`: a window on a workspace, open, with a default layout.
/// Creating an existing window ID on the same workspace returns it
/// unchanged; on another workspace it is refused.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WindowCreateRequest {
    /// The caller's ID for the new window.
    pub window_id: String,
    pub workspace_id: String,
    #[serde(default)]
    pub bounds: Option<WindowBounds>,
}

/// `window.close`: hide the window. Its record and layouts stay.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WindowCloseRequest {
    pub window_id: String,
}

/// `window.reopen`: show a closed window again, as it was.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WindowReopenRequest {
    pub window_id: String,
}

/// `window.set_bounds`: record the window's position and size.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WindowSetBoundsRequest {
    pub window_id: String,
    pub bounds: WindowBounds,
}

/// `window.show_workspace`: which workspace the window shows. It moves to
/// the front of `recent_workspaces`; its layout is kept per workspace.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WindowShowWorkspaceRequest {
    pub window_id: String,
    pub workspace_id: String,
}

/// `window.set_view_state`: the project rows the navigator shows collapsed.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WindowSetViewStateRequest {
    pub window_id: String,
    pub collapsed_projects: Vec<String>,
}

/// The reply of every window command: the window as it now stands.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WindowAck {
    #[serde(rename = "type")]
    pub tag: WindowTag,
    pub window: Window,
}

/// `layout.get`: one window's layout for one workspace.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct LayoutGetRequest {
    pub window_id: String,
    /// The workspace; the one the window shows when omitted.
    #[serde(default)]
    pub workspace_id: Option<String>,
}

/// The `layout.get` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct LayoutReply {
    #[serde(rename = "type")]
    pub tag: LayoutTag,
    pub layout: LayoutRecord,
}

/// `layout.apply`: apply one action to a window's layout for a workspace.
///
/// Closing a tab follows its target (daemon-authority decision 5): when the
/// change removes the last tab of a shell terminal from this layout, that
/// terminal closes first, as `terminal.close` would, and its tabs leave every
/// layout. A busy one refuses the change with `terminal_busy`, listing each
/// busy terminal in `terminals`, unless `force` is true. Service, script and
/// Conversation terminal tabs, and every other target, only leave the layout.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct LayoutApplyRequest {
    pub window_id: String,
    /// The workspace; the one the window shows when omitted.
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub action: LayoutAction,
    /// The revision the caller last saw. A stale one is refused with
    /// `layout_conflict`, except for the repeat of the last applied action
    /// from that revision, which returns its result.
    #[serde(default)]
    pub expected_revision: Option<u64>,
    /// Close busy shell terminals whose tabs this change removes. Without
    /// it a busy one refuses the whole change with `terminal_busy`.
    #[serde(default)]
    pub force: Option<bool>,
}

/// `layout.replace`: store a whole layout, such as one imported from an
/// older client. It must be well formed and its tab targets must exist.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct LayoutReplaceRequest {
    pub window_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub layout: Layout,
    #[serde(default)]
    pub expected_revision: Option<u64>,
    /// Close busy shell terminals whose tabs this change removes. Without
    /// it a busy one refuses the whole change with `terminal_busy`.
    #[serde(default)]
    pub force: Option<bool>,
}

/// The `layout.apply` and `layout.replace` reply. `changed` is false when
/// the layout was already so; its revision then stays.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct LayoutApplied {
    #[serde(rename = "type")]
    pub tag: LayoutTag,
    pub layout: LayoutRecord,
    pub changed: bool,
}

/// The `window_changed` feed frame: a window was created or changed.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WindowChanged {
    #[serde(rename = "type")]
    pub tag: WindowChangedTag,
    pub window: Window,
    pub boot_id: String,
    pub revision: u64,
}

/// The `layout_changed` feed frame. `layout.revision` is the layout's own
/// revision; a client keeps the higher of it and what `layout.get` gave.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct LayoutChanged {
    #[serde(rename = "type")]
    pub tag: LayoutChangedTag,
    pub layout: LayoutRecord,
    pub boot_id: String,
    pub revision: u64,
}

/// The `layout_removed` feed frame: a removed workspace took its layouts.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct LayoutRemoved {
    #[serde(rename = "type")]
    pub tag: LayoutRemovedTag,
    pub window_id: String,
    pub workspace_id: String,
    pub boot_id: String,
    pub revision: u64,
}

#[cfg(test)]
mod tests {
    //! Each operation's request and reply against the generated schema, in
    //! the shape a client sends and the daemon replies.
    use super::super::bundle;
    use super::*;
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

    fn errors(name: &str, value: &Value) -> Vec<String> {
        let bundle = bundle();
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": bundle["$defs"],
            "$ref": format!("#/$defs/{name}"),
        });
        let validator = jsonschema::validator_for(&schema).expect("generated schema compiles");
        validator
            .iter_errors(value)
            .map(|e| e.to_string())
            .collect()
    }

    fn spec(op: &str) -> Value {
        bundle()["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|spec| spec["name"] == op)
            .unwrap_or_else(|| panic!("{op} is registered"))
            .clone()
    }

    /// Validates `value` as `op`'s request and decodes it as `T`.
    fn request<T: DeserializeOwned>(op: &str, value: Value) -> T {
        let name = spec(op)["request"].as_str().unwrap().to_owned();
        let found = errors(&name, &value);
        assert!(found.is_empty(), "{op} rejected {value}: {found:?}");
        serde_json::from_value(value).unwrap()
    }

    fn reply<T: Serialize>(op: &str, value: &T) {
        let name = spec(op)["response"].as_str().unwrap().to_owned();
        let value = serde_json::to_value(value).unwrap();
        let found = errors(&name, &value);
        assert!(found.is_empty(), "{op} reply {value}: {found:?}");
    }

    fn record() -> LayoutRecord {
        LayoutRecord {
            window_id: "w".into(),
            workspace_id: "ws".into(),
            revision: 3,
            layout: crate::layout::default_layout("p1"),
        }
    }

    fn window() -> Window {
        Window {
            id: "w".into(),
            workspace_id: "ws".into(),
            state: WindowState::Open,
            bounds: None,
            view: WindowView::default(),
        }
    }

    #[test]
    fn operations_declare_their_tiers() {
        for (op, tier) in [
            ("window.list", "query"),
            ("window.create", "idempotent_command"),
            ("window.close", "idempotent_command"),
            ("window.reopen", "idempotent_command"),
            ("window.set_bounds", "idempotent_command"),
            ("window.show_workspace", "idempotent_command"),
            ("window.set_view_state", "idempotent_command"),
            ("layout.get", "query"),
            ("layout.apply", "idempotent_command"),
            ("layout.replace", "idempotent_command"),
        ] {
            assert_eq!(spec(op)["tier"], tier, "{op}");
            assert_eq!(spec(op)["domain"], "layout", "{op}");
        }
    }

    #[test]
    fn requests_and_replies_round_trip() {
        let _: WindowListRequest = request("window.list", json!({"op": "window.list"}));
        let create: WindowCreateRequest = request(
            "window.create",
            json!({"op": "window.create", "window_id": "w", "workspace_id": "ws",
                "bounds": {"x": 0, "y": 0, "width": 1200.5, "height": 800}}),
        );
        assert_eq!(create.bounds.unwrap().width, 1200.5);
        let _: WindowSetViewStateRequest = request(
            "window.set_view_state",
            json!({"op": "window.set_view_state", "window_id": "w", "collapsed_projects": ["p"]}),
        );
        let get: LayoutGetRequest =
            request("layout.get", json!({"op": "layout.get", "window_id": "w"}));
        assert_eq!(get.workspace_id, None);
        let apply: LayoutApplyRequest = request(
            "layout.apply",
            json!({"op": "layout.apply", "window_id": "w", "expected_revision": 3,
                "action": {"type": "open_tab", "tab": {"id": "t", "target": {"kind": "new_conversation"}}}}),
        );
        assert!(matches!(
            apply.action,
            LayoutAction::OpenTab { pane_id: None, .. }
        ));
        let layout = serde_json::to_value(crate::layout::default_layout("p1")).unwrap();
        let replace: LayoutReplaceRequest = request(
            "layout.replace",
            json!({"op": "layout.replace", "window_id": "w", "layout": layout}),
        );
        assert_eq!(replace.layout.maximized, None);
        reply(
            "window.create",
            &WindowAck {
                tag: WindowTag::Tag,
                window: window(),
            },
        );
        reply(
            "window.list",
            &WindowList {
                tag: WindowListTag::Tag,
                windows: vec![window()],
            },
        );
        reply(
            "layout.apply",
            &LayoutApplied {
                tag: LayoutTag::Tag,
                layout: record(),
                changed: true,
            },
        );
        reply(
            "layout.get",
            &LayoutReply {
                tag: LayoutTag::Tag,
                layout: record(),
            },
        );
    }

    #[test]
    fn a_layout_names_its_null_fields_and_unknown_actions_are_refused() {
        let mut layout = serde_json::to_value(crate::layout::default_layout("p1")).unwrap();
        layout.as_object_mut().unwrap().remove("maximized");
        assert!(!errors("Layout", &layout).is_empty());
        let unknown =
            json!({"op": "layout.apply", "window_id": "w", "action": {"type": "explode"}});
        let name = spec("layout.apply")["request"].as_str().unwrap().to_owned();
        assert!(!errors(&name, &unknown).is_empty());
    }

    #[test]
    fn frames_carry_the_record_and_the_feed_position() {
        let kinds: Vec<String> = bundle()["frames"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|frame| frame["domain"] == "layout")
            .map(|frame| frame["type"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            kinds,
            ["window_changed", "layout_changed", "layout_removed"]
        );
        let frame = serde_json::to_value(LayoutChanged {
            tag: LayoutChangedTag::Tag,
            layout: record(),
            boot_id: "b".into(),
            revision: 9,
        })
        .unwrap();
        assert!(errors("LayoutChanged", &frame).is_empty());
    }
}
