//! The layout core: one pure function per change, `apply(layout, action)`,
//! matching the desktop reducer in
//! `apps/desktop/src/renderer/src/features/workspace/model/layout.logic.ts`.
//! The daemon runs it for every client, so the CLI and any UI rearrange panes
//! and tabs by the same rules. It knows no pixels: minimum pane sizes and room
//! rules stay in the UI.
//!
//! Beyond the desktop reducer it refuses what a remote caller can get wrong
//! (a malformed ID, sizes that do not sum to 100, a tab ID reused for another
//! target) and treats an action whose new pane already exists as its own
//! retry, which changes nothing.
use crate::contract::layout::{
    DropZone, Layout, LayoutAction, LayoutNode, PaneNode, Side, SidebarFlags, SidebarId,
    SidebarWidths, Tab, TabTarget,
};
use crate::error::LayoutError;
use std::collections::{BTreeMap, HashSet};

pub mod tree;

use tree::{
    dock, equalize, find_node, find_pane, find_pane_mut, find_split_mut, insert_beside, node_ids,
    pane_of_tab, panes, remove_node, swap_panes, zone_after, zone_direction,
};

pub const NAVIGATOR_WIDTH: u32 = 260;
pub const INSPECTOR_WIDTH: u32 = 340;
pub const MIN_SIDEBAR_WIDTH: u32 = 200;
pub const MAX_SIDEBAR_WIDTH: u32 = 480;
/// Structural limits; a UI's room rules stop far earlier.
pub const MAX_PANES: usize = 64;
pub const MAX_TABS: usize = 512;
const MAX_ID: usize = 256;
const MAX_PATH: usize = 4096;

/// The layout a window gets the first time it shows a workspace: sidebars
/// open on their default sides, one empty pane.
pub fn default_layout(pane_id: &str) -> Layout {
    Layout {
        sidebars: [SidebarId::Navigator, SidebarId::Inspector],
        collapsed: SidebarFlags {
            navigator: false,
            inspector: false,
        },
        widths: default_widths(),
        tabs: BTreeMap::new(),
        root: LayoutNode::Pane(PaneNode {
            id: pane_id.into(),
            tabs: Vec::new(),
            active: None,
        }),
        focused_pane: pane_id.into(),
        maximized: None,
    }
}

fn default_widths() -> SidebarWidths {
    SidebarWidths {
        navigator: NAVIGATOR_WIDTH,
        inspector: INSPECTOR_WIDTH,
    }
}

fn invalid(message: impl Into<String>) -> LayoutError {
    LayoutError::Invalid(message.into())
}

fn check_id(kind: &str, id: &str) -> Result<(), LayoutError> {
    if id.is_empty() || id.len() > MAX_ID || id.chars().any(char::is_control) {
        return Err(invalid(format!(
            "A {kind} ID must be 1 to {MAX_ID} bytes with no control characters"
        )));
    }
    Ok(())
}

/// Checks a target's own shape. Whether the record it names exists is the
/// daemon's to check.
pub fn check_target(target: &TabTarget) -> Result<(), LayoutError> {
    match target {
        TabTarget::Conversation { id } | TabTarget::Terminal { id } | TabTarget::Browser { id } => {
            check_id("target", id)
        }
        TabTarget::File { path } | TabTarget::Diff { path, .. } => {
            let relative = std::path::Path::new(path);
            if path.is_empty()
                || path.len() > MAX_PATH
                || path.chars().any(char::is_control)
                || relative.is_absolute()
                || relative
                    .components()
                    .any(|part| !matches!(part, std::path::Component::Normal(_)))
            {
                return Err(invalid(
                    "A file or diff path is relative to the workspace, with no . or .. parts",
                ));
            }
            Ok(())
        }
        TabTarget::NewConversation => Ok(()),
    }
}

/// Every ID an action names, for [`check_id`].
fn action_ids(action: &LayoutAction) -> Vec<(&'static str, &str)> {
    use LayoutAction::*;
    match action {
        SwapSidebars | ToggleSide { .. } | SetCollapsed { .. } | SetWidth { .. } | ResetLayout => {
            vec![]
        }
        OpenTab { tab, pane_id } => {
            let mut ids = vec![("tab", tab.id.as_str())];
            ids.extend(pane_id.as_deref().map(|id| ("pane", id)));
            ids
        }
        ActivateTab { tab_id } | CloseTab { tab_id } => vec![("tab", tab_id)],
        MoveTab {
            tab_id, pane_id, ..
        } => vec![("tab", tab_id), ("pane", pane_id)],
        DropTab {
            tab_id,
            pane_id,
            new_pane_id,
            ..
        } => vec![("tab", tab_id), ("pane", pane_id), ("pane", new_pane_id)],
        SplitPane {
            pane_id,
            new_pane_id,
            ..
        } => vec![("pane", pane_id), ("pane", new_pane_id)],
        MovePane {
            pane_id, target_id, ..
        }
        | SwapPanes { pane_id, target_id } => vec![("pane", pane_id), ("pane", target_id)],
        DockTab {
            tab_id,
            new_pane_id,
            ..
        } => vec![("tab", tab_id), ("pane", new_pane_id)],
        DockPane { pane_id, .. }
        | ClosePane { pane_id }
        | FocusPane { pane_id }
        | ToggleMaximize { pane_id } => vec![("pane", pane_id)],
        SetSplitSizes { split_id, .. } => vec![("split", split_id)],
        EqualizeSplits { split_id } => split_id
            .as_deref()
            .map(|id| ("split", id))
            .into_iter()
            .collect(),
    }
}

fn check_sizes(sizes: &[f64]) -> Result<(), LayoutError> {
    let sum: f64 = sizes.iter().sum();
    if sizes.len() > MAX_PANES
        || sizes.iter().any(|size| !size.is_finite() || *size <= 0.0)
        || (sum - 100.0).abs() >= 0.001
    {
        return Err(invalid(
            "Split sizes are positive percentages, one per child, summing to 100",
        ));
    }
    Ok(())
}

/// Actions that rearrange panes: a maximized pane gives way to the new arrangement.
fn rearranges(action: &LayoutAction) -> bool {
    matches!(
        action,
        LayoutAction::DropTab { .. }
            | LayoutAction::SplitPane { .. }
            | LayoutAction::MovePane { .. }
            | LayoutAction::SwapPanes { .. }
            | LayoutAction::DockTab { .. }
            | LayoutAction::DockPane { .. }
            | LayoutAction::ClosePane { .. }
            | LayoutAction::EqualizeSplits { .. }
            | LayoutAction::ResetLayout
    )
}

/// Applies one action. An action naming a pane, split or tab that is not
/// there returns the layout unchanged, as the desktop reducer does.
pub fn apply(layout: &Layout, action: &LayoutAction) -> Result<Layout, LayoutError> {
    for (kind, id) in action_ids(action) {
        check_id(kind, id)?;
    }
    let mut draft = layout.clone();
    if !apply_action(&mut draft, action)? {
        // A retry of an action whose new pane is already there.
        return Ok(layout.clone());
    }
    // The maximized pane is the focused one; rearranging panes or focusing
    // another restores the grid.
    if let Some(maximized) = &draft.maximized
        && (rearranges(action)
            || *maximized != draft.focused_pane
            // Closing or moving a tab can remove the other panes: alone, a pane has nothing to hide.
            || matches!(draft.root, LayoutNode::Pane(_))
            || find_pane(&draft.root, maximized).is_none())
    {
        draft.maximized = None;
    }
    Ok(draft)
}

/// Whether a new pane `id` may be made: false when a pane of that ID is
/// already there (the action is its own retry).
fn new_pane(draft: &Layout, id: &str) -> Result<bool, LayoutError> {
    match find_node(&draft.root, id) {
        Some(LayoutNode::Pane(_)) => Ok(false),
        Some(LayoutNode::Split(_)) => Err(invalid(format!("{id} already names a split"))),
        None if panes(&draft.root).len() >= MAX_PANES => {
            Err(invalid(format!("A layout holds at most {MAX_PANES} panes")))
        }
        None => Ok(true),
    }
}

fn pane_node(id: &str, tab: Option<&str>) -> LayoutNode {
    LayoutNode::Pane(PaneNode {
        id: id.into(),
        tabs: tab.map(|tab| vec![tab.to_owned()]).unwrap_or_default(),
        active: tab.map(str::to_owned),
    })
}

fn refocus(draft: &mut Layout, removed: &str) {
    if draft.focused_pane == removed || find_pane(&draft.root, &draft.focused_pane).is_none() {
        draft.focused_pane = panes(&draft.root)[0].id.clone();
    }
}

/// Takes a tab out of its pane, activating its right neighbour, else its
/// left. Returns the pane's ID.
fn take_tab(draft: &mut Layout, tab_id: &str) -> Option<String> {
    let pane_id = pane_of_tab(&draft.root, tab_id)?;
    let pane = find_pane_mut(&mut draft.root, &pane_id)?;
    let index = pane.tabs.iter().position(|tab| tab == tab_id)?;
    pane.tabs.remove(index);
    if pane.active.as_deref() == Some(tab_id) {
        pane.active = pane
            .tabs
            .get(index)
            .or_else(|| index.checked_sub(1).and_then(|left| pane.tabs.get(left)))
            .cloned();
    }
    Some(pane_id)
}

/// Removes an emptied pane unless it is the last one.
fn drop_if_empty(draft: &mut Layout, pane_id: &str) {
    let empty = find_pane(&draft.root, pane_id).is_some_and(|pane| pane.tabs.is_empty());
    if !empty || panes(&draft.root).len() == 1 {
        return;
    }
    remove_node(&mut draft.root, pane_id);
    refocus(draft, pane_id);
}

fn clamp_width(width: f64) -> u32 {
    width
        .clamp(MIN_SIDEBAR_WIDTH as f64, MAX_SIDEBAR_WIDTH as f64)
        .round() as u32
}

fn sidebar_flag(flags: &mut SidebarFlags, sidebar: SidebarId) -> &mut bool {
    match sidebar {
        SidebarId::Navigator => &mut flags.navigator,
        SidebarId::Inspector => &mut flags.inspector,
    }
}

/// Applies `action` to `draft`. Returns false for a retry that must change nothing.
fn apply_action(draft: &mut Layout, action: &LayoutAction) -> Result<bool, LayoutError> {
    use LayoutAction::*;
    match action {
        SwapSidebars => draft.sidebars.swap(0, 1),
        ToggleSide { side } => {
            let sidebar = draft.sidebars[match side {
                Side::Left => 0,
                Side::Right => 1,
            }];
            let flag = sidebar_flag(&mut draft.collapsed, sidebar);
            *flag = !*flag;
        }
        SetCollapsed { sidebar, collapsed } => {
            *sidebar_flag(&mut draft.collapsed, *sidebar) = *collapsed;
        }
        SetWidth { sidebar, width } => {
            if !width.is_finite() {
                return Err(invalid("A sidebar width must be a finite number"));
            }
            let width = clamp_width(*width);
            match sidebar {
                SidebarId::Navigator => draft.widths.navigator = width,
                SidebarId::Inspector => draft.widths.inspector = width,
            }
        }
        OpenTab { tab, pane_id } => {
            check_target(&tab.target)?;
            if let Some(existing) = draft.tabs.get(&tab.id) {
                if existing.target != tab.target {
                    return Err(invalid(format!(
                        "Tab {} already shows another target",
                        tab.id
                    )));
                }
                // Opening it again brings it forward.
                return apply_action(
                    draft,
                    &ActivateTab {
                        tab_id: tab.id.clone(),
                    },
                );
            }
            if draft.tabs.len() >= MAX_TABS {
                return Err(invalid(format!("A layout holds at most {MAX_TABS} tabs")));
            }
            let wanted = pane_id.as_deref().unwrap_or(&draft.focused_pane);
            let pane_id = find_pane(&draft.root, wanted)
                .unwrap_or_else(|| panes(&draft.root)[0])
                .id
                .clone();
            draft.tabs.insert(tab.id.clone(), tab.clone());
            let pane = find_pane_mut(&mut draft.root, &pane_id).expect("pane found above");
            let at = match &pane.active {
                Some(active) => pane
                    .tabs
                    .iter()
                    .position(|id| id == active)
                    .map_or(pane.tabs.len(), |index| index + 1),
                None => pane.tabs.len(),
            };
            pane.tabs.insert(at, tab.id.clone());
            pane.active = Some(tab.id.clone());
            draft.focused_pane = pane_id;
        }
        ActivateTab { tab_id } => {
            let Some(pane_id) = pane_of_tab(&draft.root, tab_id) else {
                return Ok(true);
            };
            find_pane_mut(&mut draft.root, &pane_id)
                .expect("pane of the tab")
                .active = Some(tab_id.clone());
            draft.focused_pane = pane_id;
        }
        CloseTab { tab_id } => {
            let Some(pane_id) = take_tab(draft, tab_id) else {
                return Ok(true);
            };
            draft.tabs.remove(tab_id);
            drop_if_empty(draft, &pane_id);
        }
        MoveTab {
            tab_id,
            pane_id,
            index,
        } => {
            let Some(source) = pane_of_tab(&draft.root, tab_id) else {
                return Ok(true);
            };
            if find_pane(&draft.root, pane_id).is_none() {
                return Ok(true);
            }
            let from = find_pane(&draft.root, &source)
                .and_then(|pane| pane.tabs.iter().position(|tab| tab == tab_id))
                .expect("tab in its pane") as u64;
            take_tab(draft, tab_id);
            let index = if source == *pane_id && from < *index {
                index - 1
            } else {
                *index
            };
            let target = find_pane_mut(&mut draft.root, pane_id).expect("target pane");
            let at = usize::try_from(index)
                .unwrap_or(usize::MAX)
                .min(target.tabs.len());
            target.tabs.insert(at, tab_id.clone());
            target.active = Some(tab_id.clone());
            draft.focused_pane = pane_id.clone();
            if source != *pane_id {
                drop_if_empty(draft, &source);
            }
        }
        DropTab {
            tab_id,
            pane_id,
            zone,
            new_pane_id,
        } => {
            let Some(source) = pane_of_tab(&draft.root, tab_id) else {
                return Ok(true);
            };
            let Some(target) = find_pane(&draft.root, pane_id) else {
                return Ok(true);
            };
            if *zone == DropZone::Centre {
                if source == *pane_id {
                    return Ok(true);
                }
                take_tab(draft, tab_id);
                let target = find_pane_mut(&mut draft.root, pane_id).expect("target pane");
                target.tabs.push(tab_id.clone());
                target.active = Some(tab_id.clone());
                draft.focused_pane = pane_id.clone();
                drop_if_empty(draft, &source);
                return Ok(true);
            }
            // Splitting a pane off its only tab would leave it empty in its own place.
            if source == *pane_id && target.tabs.len() == 1 {
                return Ok(true);
            }
            if !new_pane(draft, new_pane_id)? {
                return Ok(false);
            }
            take_tab(draft, tab_id);
            insert_beside(
                &mut draft.root,
                pane_id,
                pane_node(new_pane_id, Some(tab_id)),
                zone_direction(*zone),
                zone_after(*zone),
            );
            draft.focused_pane = new_pane_id.clone();
            if source != *pane_id {
                drop_if_empty(draft, &source);
            }
        }
        SplitPane {
            pane_id,
            direction,
            new_pane_id,
        } => {
            if find_pane(&draft.root, pane_id).is_none() {
                return Ok(true);
            }
            if !new_pane(draft, new_pane_id)? {
                return Ok(false);
            }
            insert_beside(
                &mut draft.root,
                pane_id,
                pane_node(new_pane_id, None),
                *direction,
                true,
            );
            draft.focused_pane = new_pane_id.clone();
        }
        MovePane {
            pane_id,
            target_id,
            zone,
        } => {
            let (Some(pane), Some(_)) = (
                find_pane(&draft.root, pane_id),
                find_pane(&draft.root, target_id),
            ) else {
                return Ok(true);
            };
            if pane_id == target_id {
                return Ok(true);
            }
            // A pane dropped on another's centre trades places with it.
            if *zone == DropZone::Centre {
                swap_panes(&mut draft.root, pane_id, target_id);
                draft.focused_pane = pane_id.clone();
                return Ok(true);
            }
            let moving = LayoutNode::Pane(pane.clone());
            remove_node(&mut draft.root, pane_id);
            insert_beside(
                &mut draft.root,
                target_id,
                moving,
                zone_direction(*zone),
                zone_after(*zone),
            );
            draft.focused_pane = pane_id.clone();
        }
        SwapPanes { pane_id, target_id } => {
            if find_pane(&draft.root, pane_id).is_none()
                || find_pane(&draft.root, target_id).is_none()
                || pane_id == target_id
            {
                return Ok(true);
            }
            swap_panes(&mut draft.root, pane_id, target_id);
            draft.focused_pane = pane_id.clone();
        }
        DockTab {
            tab_id,
            edge,
            new_pane_id,
        } => {
            let Some(source) = pane_of_tab(&draft.root, tab_id) else {
                return Ok(true);
            };
            // Docking the only tab of the only pane would leave nothing behind.
            let alone = find_pane(&draft.root, &source).is_some_and(|pane| pane.tabs.len() == 1);
            if alone && panes(&draft.root).len() == 1 {
                return Ok(true);
            }
            if !new_pane(draft, new_pane_id)? {
                return Ok(false);
            }
            take_tab(draft, tab_id);
            drop_if_empty(draft, &source);
            let root = std::mem::replace(&mut draft.root, pane_node("", None));
            draft.root = dock(root, pane_node(new_pane_id, Some(tab_id)), *edge);
            draft.focused_pane = new_pane_id.clone();
        }
        DockPane { pane_id, edge } => {
            let Some(pane) = find_pane(&draft.root, pane_id) else {
                return Ok(true);
            };
            if panes(&draft.root).len() == 1 {
                return Ok(true);
            }
            let moving = LayoutNode::Pane(pane.clone());
            remove_node(&mut draft.root, pane_id);
            let root = std::mem::replace(&mut draft.root, pane_node("", None));
            draft.root = dock(root, moving, *edge);
            draft.focused_pane = pane_id.clone();
        }
        ClosePane { pane_id } => {
            let Some(pane) = find_pane_mut(&mut draft.root, pane_id) else {
                return Ok(true);
            };
            let closed = std::mem::take(&mut pane.tabs);
            pane.active = None;
            for tab in closed {
                draft.tabs.remove(&tab);
            }
            drop_if_empty(draft, pane_id);
        }
        FocusPane { pane_id } => {
            if find_pane(&draft.root, pane_id).is_some() {
                draft.focused_pane = pane_id.clone();
            }
        }
        SetSplitSizes { split_id, sizes } => {
            check_sizes(sizes)?;
            if let Some(split) = find_split_mut(&mut draft.root, split_id)
                && split.children.len() == sizes.len()
            {
                split.sizes = sizes.clone();
            }
        }
        ToggleMaximize { pane_id } => {
            if find_pane(&draft.root, pane_id).is_none() {
                return Ok(true);
            }
            if draft.maximized.as_ref() == Some(pane_id) {
                draft.maximized = None;
                return Ok(true);
            }
            // Only a pane among others can fill the centre.
            if matches!(draft.root, LayoutNode::Pane(_)) {
                return Ok(true);
            }
            draft.maximized = Some(pane_id.clone());
            draft.focused_pane = pane_id.clone();
        }
        EqualizeSplits { split_id } => equalize(&mut draft.root, split_id.as_deref()),
        ResetLayout => {
            draft.sidebars = [SidebarId::Navigator, SidebarId::Inspector];
            draft.collapsed = SidebarFlags {
                navigator: false,
                inspector: false,
            };
            draft.widths = default_widths();
            equalize(&mut draft.root, None);
        }
    }
    Ok(true)
}

/// Checks that a layout is well formed: every pane reachable once, every tab
/// in exactly one pane and every placed tab recorded, split sizes summing to
/// 100, the focused pane present and the maximized pane the focused one.
pub fn check(layout: &Layout) -> Result<(), LayoutError> {
    let all = panes(&layout.root);
    if all.len() > MAX_PANES || layout.tabs.len() > MAX_TABS {
        return Err(invalid(format!(
            "A layout holds at most {MAX_PANES} panes and {MAX_TABS} tabs"
        )));
    }
    let ids = node_ids(&layout.root);
    let unique: HashSet<&str> = ids.iter().copied().collect();
    if unique.len() != ids.len() {
        return Err(invalid("Pane and split IDs must be unique"));
    }
    for id in &ids {
        check_id("pane", id)?;
    }
    let mut placed = HashSet::new();
    for pane in &all {
        for tab in &pane.tabs {
            if !placed.insert(tab.as_str()) {
                return Err(invalid(format!("Tab {tab} is placed twice")));
            }
        }
        match &pane.active {
            Some(active) if !pane.tabs.contains(active) => {
                return Err(invalid(format!(
                    "Pane {} activates a tab it lacks",
                    pane.id
                )));
            }
            None if !pane.tabs.is_empty() => {
                return Err(invalid(format!(
                    "Pane {} has tabs but none active",
                    pane.id
                )));
            }
            _ => {}
        }
    }
    let recorded: HashSet<&str> = layout.tabs.keys().map(String::as_str).collect();
    if placed != recorded {
        return Err(invalid(
            "Every placed tab needs a record, and every record a place",
        ));
    }
    for (id, tab) in &layout.tabs {
        check_id("tab", id)?;
        if tab.id != *id {
            return Err(invalid(format!("Tab {id} is recorded under another ID")));
        }
        check_target(&tab.target)?;
    }
    if !all.iter().any(|pane| pane.id == layout.focused_pane) {
        return Err(invalid("The focused pane must be in the layout"));
    }
    if let Some(maximized) = &layout.maximized
        && (*maximized != layout.focused_pane || all.len() < 2)
    {
        return Err(invalid(
            "Only the focused pane, among others, may be maximized",
        ));
    }
    let widths = [layout.widths.navigator, layout.widths.inspector];
    if widths
        .iter()
        .any(|width| !(MIN_SIDEBAR_WIDTH..=MAX_SIDEBAR_WIDTH).contains(width))
    {
        return Err(invalid(format!(
            "Sidebar widths are {MIN_SIDEBAR_WIDTH} to {MAX_SIDEBAR_WIDTH} pixels"
        )));
    }
    if layout.sidebars[0] == layout.sidebars[1] {
        return Err(invalid("Each sidebar has its own side"));
    }
    check_splits(&layout.root, None)
}

fn check_splits(
    node: &LayoutNode,
    parent: Option<crate::contract::layout::SplitDirection>,
) -> Result<(), LayoutError> {
    let LayoutNode::Split(split) = node else {
        return Ok(());
    };
    if split.children.len() < 2 || split.sizes.len() != split.children.len() {
        return Err(invalid(format!(
            "Split {} needs two or more children and one size each",
            split.id
        )));
    }
    check_sizes(&split.sizes)?;
    if parent == Some(split.direction) {
        return Err(invalid(format!(
            "Split {} sits in a split of its own direction",
            split.id
        )));
    }
    for child in &split.children {
        check_splits(child, Some(split.direction))?;
    }
    Ok(())
}

/// Closes every tab showing `target`, as `close_tab` would one by one.
/// Returns None when no tab shows it.
pub fn close_target(layout: &Layout, target: &TabTarget) -> Option<Layout> {
    let showing: Vec<String> = layout
        .tabs
        .values()
        .filter(|tab| tab.target == *target)
        .map(|tab| tab.id.clone())
        .collect();
    if showing.is_empty() {
        return None;
    }
    let mut next = layout.clone();
    for tab_id in showing {
        next = apply(&next, &LayoutAction::CloseTab { tab_id }).ok()?;
    }
    Some(next)
}

/// Every distinct target the layout's tabs show.
pub fn targets(layout: &Layout) -> Vec<&TabTarget> {
    let mut found: Vec<&TabTarget> = Vec::new();
    for Tab { target, .. } in layout.tabs.values() {
        if !found.contains(&target) {
            found.push(target);
        }
    }
    found
}

#[cfg(test)]
mod tests;
