//! Invariants under random action sequences (the desktop's
//! `layout.property.test.ts`, ported), and the rules the daemon adds for
//! remote callers. The TS example tests run as the shared vectors in
//! `tests/layout_vectors.rs`.
use super::*;
use crate::contract::layout::{DropZone, Edge, SplitDirection};
use proptest::prelude::*;

fn tab(id: &str) -> Tab {
    Tab {
        id: id.into(),
        target: TabTarget::Terminal {
            id: format!("t-{id}"),
        },
    }
}

fn open(id: &str) -> LayoutAction {
    LayoutAction::OpenTab {
        tab: tab(id),
        pane_id: None,
    }
}

fn run(layout: Layout, actions: &[LayoutAction]) -> Layout {
    actions
        .iter()
        .fold(layout, |layout, action| apply(&layout, action).unwrap())
}

/// A step refers to existing panes and tabs by position, so most steps do something.
#[derive(Clone, Debug)]
enum Step {
    Maximize(usize),
    Equalize,
    Reset,
    Open(usize, bool),
    Close(usize),
    Move(usize, usize, u64),
    Drop(usize, usize, DropZone),
    Split(usize, bool),
    MovePane(usize, usize, DropZone),
    Swap(usize, usize),
    DockTab(usize, Edge),
    DockPane(usize, Edge),
    ClosePane(usize),
    Focus(usize),
    SwapSidebars,
    Sizes(usize, Vec<u8>),
}

fn zone() -> impl Strategy<Value = DropZone> {
    prop_oneof![
        Just(DropZone::Left),
        Just(DropZone::Right),
        Just(DropZone::Top),
        Just(DropZone::Bottom),
        Just(DropZone::Centre),
    ]
}

fn edge() -> impl Strategy<Value = Edge> {
    prop_oneof![
        Just(Edge::Left),
        Just(Edge::Right),
        Just(Edge::Top),
        Just(Edge::Bottom),
    ]
}

fn step() -> impl Strategy<Value = Step> {
    let n = || 0usize..64;
    prop_oneof![
        n().prop_map(Step::Maximize),
        Just(Step::Equalize),
        Just(Step::Reset),
        (n(), any::<bool>()).prop_map(|(p, named)| Step::Open(p, named)),
        n().prop_map(Step::Close),
        (n(), n(), 0u64..6).prop_map(|(t, p, i)| Step::Move(t, p, i)),
        (n(), n(), zone()).prop_map(|(t, p, z)| Step::Drop(t, p, z)),
        (n(), any::<bool>()).prop_map(|(p, row)| Step::Split(p, row)),
        (n(), n(), zone()).prop_map(|(a, b, z)| Step::MovePane(a, b, z)),
        (n(), n()).prop_map(|(a, b)| Step::Swap(a, b)),
        (n(), edge()).prop_map(|(t, e)| Step::DockTab(t, e)),
        (n(), edge()).prop_map(|(p, e)| Step::DockPane(p, e)),
        n().prop_map(Step::ClosePane),
        n().prop_map(Step::Focus),
        Just(Step::SwapSidebars),
        (n(), prop::collection::vec(1u8..100, 2..5)).prop_map(|(s, w)| Step::Sizes(s, w)),
    ]
}

fn splits(node: &LayoutNode) -> Vec<(String, usize)> {
    match node {
        LayoutNode::Pane(_) => Vec::new(),
        LayoutNode::Split(split) => {
            let mut found = vec![(split.id.clone(), split.children.len())];
            for child in &split.children {
                found.extend(splits(child));
            }
            found
        }
    }
}

/// Turns a step into an action on `layout`, or None when it names nothing.
fn action(
    layout: &Layout,
    step: &Step,
    fresh: &mut impl FnMut() -> String,
) -> Option<LayoutAction> {
    let all = panes(&layout.root);
    let pane = |i: &usize| (!all.is_empty()).then(|| all[i % all.len()].id.clone());
    let tabs: Vec<&String> = layout.tabs.keys().collect();
    let tab_at = |i: &usize| (!tabs.is_empty()).then(|| tabs[i % tabs.len()].clone());
    Some(match step {
        Step::Maximize(p) => LayoutAction::ToggleMaximize { pane_id: pane(p)? },
        Step::Equalize => LayoutAction::EqualizeSplits { split_id: None },
        Step::Reset => LayoutAction::ResetLayout,
        Step::Open(p, named) => LayoutAction::OpenTab {
            tab: tab(&fresh()),
            pane_id: if *named { pane(p) } else { None },
        },
        Step::Close(t) => LayoutAction::CloseTab { tab_id: tab_at(t)? },
        Step::Move(t, p, i) => LayoutAction::MoveTab {
            tab_id: tab_at(t)?,
            pane_id: pane(p)?,
            index: *i,
        },
        Step::Drop(t, p, z) => LayoutAction::DropTab {
            tab_id: tab_at(t)?,
            pane_id: pane(p)?,
            zone: *z,
            new_pane_id: fresh(),
        },
        Step::Split(p, row) => LayoutAction::SplitPane {
            pane_id: pane(p)?,
            direction: if *row {
                SplitDirection::Row
            } else {
                SplitDirection::Column
            },
            new_pane_id: fresh(),
        },
        Step::MovePane(a, b, z) => LayoutAction::MovePane {
            pane_id: pane(a)?,
            target_id: pane(b)?,
            zone: *z,
        },
        Step::Swap(a, b) => LayoutAction::SwapPanes {
            pane_id: pane(a)?,
            target_id: pane(b)?,
        },
        Step::DockTab(t, e) => LayoutAction::DockTab {
            tab_id: tab_at(t)?,
            edge: *e,
            new_pane_id: fresh(),
        },
        Step::DockPane(p, e) => LayoutAction::DockPane {
            pane_id: pane(p)?,
            edge: *e,
        },
        Step::ClosePane(p) => LayoutAction::ClosePane { pane_id: pane(p)? },
        Step::Focus(p) => LayoutAction::FocusPane { pane_id: pane(p)? },
        Step::SwapSidebars => LayoutAction::SwapSidebars,
        Step::Sizes(s, weights) => {
            let all = splits(&layout.root);
            let (id, count) = (!all.is_empty()).then(|| all[s % all.len()].clone())?;
            let weights: Vec<f64> = (0..count)
                .map(|i| f64::from(weights[i % weights.len()]))
                .collect();
            let total: f64 = weights.iter().sum();
            let mut sizes: Vec<f64> = weights.iter().map(|w| w * 100.0 / total).collect();
            // Put the rounding on the last child so the sum is 100.
            let rest: f64 = sizes[..count - 1].iter().sum();
            sizes[count - 1] = 100.0 - rest;
            LayoutAction::SetSplitSizes {
                split_id: id,
                sizes,
            }
        }
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    /// Every pane reachable once, every tab in exactly one pane, split sizes
    /// summing to 100, the focused pane present, maximized focused or null.
    #[test]
    fn any_sequence_of_actions_keeps_the_layout_well_formed(steps in prop::collection::vec(step(), 1..60)) {
        let mut counter = 0;
        let mut fresh = || {
            counter += 1;
            format!("n{counter}")
        };
        let mut layout = default_layout("p0");
        for step in &steps {
            let Some(action) = action(&layout, step, &mut fresh) else { continue };
            layout = apply(&layout, &action).unwrap();
            prop_assert!(check(&layout).is_ok(), "{:?} after {:?}", check(&layout), action);
        }
    }

    /// An action that makes a pane is its own retry: applied again it changes nothing.
    #[test]
    fn an_action_that_makes_a_pane_is_idempotent(steps in prop::collection::vec(step(), 1..40)) {
        let mut counter = 0;
        let mut fresh = || {
            counter += 1;
            format!("n{counter}")
        };
        let mut layout = default_layout("p0");
        for step in &steps {
            let Some(action) = action(&layout, step, &mut fresh) else { continue };
            let once = apply(&layout, &action).unwrap();
            if matches!(action, LayoutAction::SplitPane { .. } | LayoutAction::DropTab { .. }
                | LayoutAction::DockTab { .. } | LayoutAction::OpenTab { .. }
                | LayoutAction::CloseTab { .. } | LayoutAction::ClosePane { .. })
            {
                prop_assert_eq!(apply(&once, &action).unwrap(), once.clone(), "{:?}", action);
            }
            layout = once;
        }
    }
}

#[test]
fn opening_a_tab_again_activates_it_and_another_target_is_refused() {
    let layout = run(default_layout("p1"), &[open("a"), open("b")]);
    let again = apply(&layout, &open("a")).unwrap();
    assert_eq!(again.tabs.len(), 2);
    assert_eq!(panes(&again.root)[0].active.as_deref(), Some("a"));
    let other = LayoutAction::OpenTab {
        tab: Tab {
            id: "a".into(),
            target: TabTarget::NewConversation,
        },
        pane_id: None,
    };
    assert_eq!(apply(&layout, &other).unwrap_err().code(), "invalid_layout");
}

#[test]
fn a_new_pane_id_that_names_a_split_is_refused() {
    let layout = run(
        default_layout("p1"),
        &[LayoutAction::SplitPane {
            pane_id: "p1".into(),
            direction: SplitDirection::Row,
            new_pane_id: "p2".into(),
        }],
    );
    let split = layout.root.id().to_owned();
    let collide = LayoutAction::SplitPane {
        pane_id: "p1".into(),
        direction: SplitDirection::Column,
        new_pane_id: split,
    };
    assert_eq!(
        apply(&layout, &collide).unwrap_err().code(),
        "invalid_layout"
    );
}

#[test]
fn malformed_input_is_refused() {
    let layout = default_layout("p1");
    for action in [
        LayoutAction::FocusPane {
            pane_id: String::new(),
        },
        LayoutAction::FocusPane {
            pane_id: "x".repeat(257),
        },
        LayoutAction::SetWidth {
            sidebar: SidebarId::Navigator,
            width: f64::NAN,
        },
        LayoutAction::SetSplitSizes {
            split_id: "s".into(),
            sizes: vec![30.0, 60.0],
        },
        LayoutAction::SetSplitSizes {
            split_id: "s".into(),
            sizes: vec![110.0, -10.0],
        },
        LayoutAction::OpenTab {
            tab: Tab {
                id: "f".into(),
                target: TabTarget::File {
                    path: "../outside".into(),
                },
            },
            pane_id: None,
        },
        LayoutAction::OpenTab {
            tab: Tab {
                id: "f".into(),
                target: TabTarget::Diff {
                    path: "/etc/hosts".into(),
                    staged: false,
                },
            },
            pane_id: None,
        },
    ] {
        assert!(apply(&layout, &action).is_err(), "{action:?}");
    }
}

#[test]
fn check_refuses_a_malformed_layout() {
    let good = run(default_layout("p1"), &[open("a")]);
    check(&good).unwrap();
    let mut unplaced = good.clone();
    unplaced.tabs.insert("b".into(), tab("b"));
    assert!(check(&unplaced).is_err());
    let mut unfocused = good.clone();
    unfocused.focused_pane = "gone".into();
    assert!(check(&unfocused).is_err());
    let mut lone_maximized = good.clone();
    lone_maximized.maximized = Some("p1".into());
    assert!(check(&lone_maximized).is_err());
    let mut narrow = good;
    narrow.widths.navigator = 10;
    assert!(check(&narrow).is_err());
}

#[test]
fn closing_a_target_closes_every_tab_showing_it() {
    let layout = run(
        default_layout("p1"),
        &[
            open("a"),
            LayoutAction::SplitPane {
                pane_id: "p1".into(),
                direction: SplitDirection::Row,
                new_pane_id: "p2".into(),
            },
            LayoutAction::OpenTab {
                tab: Tab {
                    id: "b".into(),
                    target: tab("a").target,
                },
                pane_id: Some("p2".into()),
            },
            open("c"),
        ],
    );
    let closed = close_target(&layout, &tab("a").target).unwrap();
    assert_eq!(closed.tabs.keys().collect::<Vec<_>>(), ["c"]);
    check(&closed).unwrap();
    assert!(close_target(&closed, &tab("a").target).is_none());
}
