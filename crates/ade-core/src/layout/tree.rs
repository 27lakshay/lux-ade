//! The pane tree: queries and pure edits, as in the desktop's `layout-tree.ts`.
//! Each edit keeps the tree flat: a split has at least two children and never
//! holds a split of its own direction.
use crate::contract::layout::{DropZone, Edge, LayoutNode, PaneNode, SplitDirection, SplitNode};
use std::collections::HashSet;

/// Every pane, in reading order.
pub fn panes(node: &LayoutNode) -> Vec<&PaneNode> {
    let mut found = Vec::new();
    collect_panes(node, &mut found);
    found
}

fn collect_panes<'a>(node: &'a LayoutNode, found: &mut Vec<&'a PaneNode>) {
    match node {
        LayoutNode::Pane(pane) => found.push(pane),
        LayoutNode::Split(split) => {
            for child in &split.children {
                collect_panes(child, found);
            }
        }
    }
}

pub fn find_pane<'a>(root: &'a LayoutNode, id: &str) -> Option<&'a PaneNode> {
    panes(root).into_iter().find(|pane| pane.id == id)
}

pub fn find_pane_mut<'a>(root: &'a mut LayoutNode, id: &str) -> Option<&'a mut PaneNode> {
    match root {
        LayoutNode::Pane(pane) => (pane.id == id).then_some(pane),
        LayoutNode::Split(split) => split
            .children
            .iter_mut()
            .find_map(|child| find_pane_mut(child, id)),
    }
}

/// The ID of the pane holding `tab_id`.
pub fn pane_of_tab(root: &LayoutNode, tab_id: &str) -> Option<String> {
    panes(root)
        .into_iter()
        .find(|pane| pane.tabs.iter().any(|tab| tab == tab_id))
        .map(|pane| pane.id.clone())
}

pub fn find_node<'a>(node: &'a LayoutNode, id: &str) -> Option<&'a LayoutNode> {
    if node.id() == id {
        return Some(node);
    }
    match node {
        LayoutNode::Pane(_) => None,
        LayoutNode::Split(split) => split.children.iter().find_map(|child| find_node(child, id)),
    }
}

pub fn find_split_mut<'a>(node: &'a mut LayoutNode, id: &str) -> Option<&'a mut SplitNode> {
    let LayoutNode::Split(split) = node else {
        return None;
    };
    if split.id == id {
        return Some(split);
    }
    split
        .children
        .iter_mut()
        .find_map(|child| find_split_mut(child, id))
}

/// Every node ID in the tree, splits included.
pub fn node_ids(node: &LayoutNode) -> Vec<&str> {
    let mut ids = vec![node.id()];
    if let LayoutNode::Split(split) = node {
        for child in &split.children {
            ids.extend(node_ids(child));
        }
    }
    ids
}

/// The child indices from the root down to the node `id`.
fn path_of(node: &LayoutNode, id: &str) -> Option<Vec<usize>> {
    if node.id() == id {
        return Some(Vec::new());
    }
    let LayoutNode::Split(split) = node else {
        return None;
    };
    split
        .children
        .iter()
        .enumerate()
        .find_map(|(index, child)| {
            path_of(child, id).map(|mut path| {
                path.insert(0, index);
                path
            })
        })
}

fn node_at_mut<'a>(node: &'a mut LayoutNode, path: &[usize]) -> &'a mut LayoutNode {
    match path.split_first() {
        None => node,
        Some((index, rest)) => match node {
            LayoutNode::Split(split) => node_at_mut(&mut split.children[*index], rest),
            LayoutNode::Pane(_) => unreachable!("a path never passes through a pane"),
        },
    }
}

fn split_at_mut<'a>(node: &'a mut LayoutNode, path: &[usize]) -> &'a mut SplitNode {
    match node_at_mut(node, path) {
        LayoutNode::Split(split) => split,
        LayoutNode::Pane(_) => unreachable!("a parent path names a split"),
    }
}

/// A split ID not yet in the tree, derived from the node that caused the split.
fn split_id(root: &LayoutNode, from: &str) -> String {
    let taken: HashSet<&str> = node_ids(root).into_iter().collect();
    let mut id = format!("split-{from}");
    let mut n = 2;
    while taken.contains(id.as_str()) {
        id = format!("split-{from}-{n}");
        n += 1;
    }
    id
}

pub fn zone_direction(zone: DropZone) -> SplitDirection {
    match zone {
        DropZone::Left | DropZone::Right | DropZone::Centre => SplitDirection::Row,
        DropZone::Top | DropZone::Bottom => SplitDirection::Column,
    }
}

pub fn zone_after(zone: DropZone) -> bool {
    matches!(zone, DropZone::Right | DropZone::Bottom)
}

pub fn edge_zone(edge: Edge) -> DropZone {
    match edge {
        Edge::Left => DropZone::Left,
        Edge::Right => DropZone::Right,
        Edge::Top => DropZone::Top,
        Edge::Bottom => DropZone::Bottom,
    }
}

/// Puts `node` beside `target_id`, splitting the target in two, or sharing
/// its space when its parent already splits that way.
pub fn insert_beside(
    root: &mut LayoutNode,
    target_id: &str,
    node: LayoutNode,
    direction: SplitDirection,
    after: bool,
) {
    let Some(path) = path_of(root, target_id) else {
        return;
    };
    if let Some((index, parent_path)) = path.split_last() {
        let parent = split_at_mut(root, parent_path);
        if parent.direction == direction {
            let half = parent.sizes[*index] / 2.0;
            parent.sizes[*index] = half;
            let at = if after { index + 1 } else { *index };
            parent.children.insert(at, node);
            parent.sizes.insert(at, half);
            return;
        }
    }
    let id = split_id(root, node.id());
    let slot = node_at_mut(root, &path);
    let target = std::mem::replace(slot, placeholder());
    *slot = LayoutNode::Split(SplitNode {
        tag: Default::default(),
        id,
        direction,
        children: if after {
            vec![target, node]
        } else {
            vec![node, target]
        },
        sizes: vec![50.0, 50.0],
    });
}

fn placeholder() -> LayoutNode {
    LayoutNode::Pane(PaneNode {
        tag: Default::default(),
        id: String::new(),
        tabs: Vec::new(),
        active: None,
    })
}

/// Takes a node out of the tree, giving its space to a neighbour and
/// collapsing a split left with one child. The root stays.
pub fn remove_node(root: &mut LayoutNode, id: &str) {
    let Some(path) = path_of(root, id) else {
        return;
    };
    let Some((index, parent_path)) = path.split_last() else {
        return;
    };
    let parent = split_at_mut(root, parent_path);
    let freed = parent.sizes.remove(*index);
    parent.children.remove(*index);
    let neighbour = index.saturating_sub(1);
    if let Some(size) = parent.sizes.get_mut(neighbour) {
        *size += freed;
    }
    if parent.children.len() > 1 {
        return;
    }
    let only = parent.children.pop().expect("a split keeps one child");
    replace_node(root, parent_path, only);
}

/// Replaces the node at `path`, flattening a split into a parent split of
/// the same direction.
fn replace_node(root: &mut LayoutNode, path: &[usize], replacement: LayoutNode) {
    let Some((index, parent_path)) = path.split_last() else {
        *root = replacement;
        return;
    };
    let parent = split_at_mut(root, parent_path);
    match replacement {
        LayoutNode::Split(inner) if inner.direction == parent.direction => {
            let share = parent.sizes[*index];
            let sizes: Vec<f64> = inner
                .sizes
                .iter()
                .map(|size| size * share / 100.0)
                .collect();
            parent.children.splice(*index..*index + 1, inner.children);
            parent.sizes.splice(*index..*index + 1, sizes);
        }
        other => parent.children[*index] = other,
    }
}

/// Exchanges two panes' places in the tree; each place keeps its size.
pub fn swap_panes(root: &mut LayoutNode, a: &str, b: &str) {
    let (Some(path_a), Some(path_b)) = (path_of(root, a), path_of(root, b)) else {
        return;
    };
    if path_a.is_empty() || path_b.is_empty() {
        return;
    }
    let node_a = node_at_mut(root, &path_a).clone();
    let node_b = std::mem::replace(node_at_mut(root, &path_b), node_a);
    *node_at_mut(root, &path_a) = node_b;
}

/// Puts `node` along an outer edge of the whole centre: a full-height column
/// or a full-width row.
pub fn dock(root: LayoutNode, node: LayoutNode, edge: Edge) -> LayoutNode {
    let zone = edge_zone(edge);
    let direction = zone_direction(zone);
    let after = zone_after(zone);
    match root {
        LayoutNode::Split(mut split) if split.direction == direction => {
            let share = 100.0 / (split.children.len() + 1) as f64;
            for size in &mut split.sizes {
                *size = *size * (100.0 - share) / 100.0;
            }
            if after {
                split.children.push(node);
                split.sizes.push(share);
            } else {
                split.children.insert(0, node);
                split.sizes.insert(0, share);
            }
            LayoutNode::Split(split)
        }
        root => LayoutNode::Split(SplitNode {
            tag: Default::default(),
            id: split_id(&root, node.id()),
            direction,
            children: if after {
                vec![root, node]
            } else {
                vec![node, root]
            },
            sizes: vec![50.0, 50.0],
        }),
    }
}

/// Evens the sizes of one split, or of every split when `split_id` is None.
pub fn equalize(node: &mut LayoutNode, split_id: Option<&str>) {
    let LayoutNode::Split(split) = node else {
        return;
    };
    if split_id.is_none_or(|id| id == split.id) {
        let count = split.children.len();
        split.sizes = vec![100.0 / count as f64; count];
    }
    for child in &mut split.children {
        equalize(child, split_id);
    }
}
