use crate::client_state::View;
use gpui_kit::{FollowMode, ListAlignment, ListOffset, ListState, px};
use std::sync::Arc;

pub struct TranscriptList {
    pub state: ListState,
    conversation: Option<String>,
    previous: Option<Arc<View>>,
}
impl TranscriptList {
    pub fn new() -> Self {
        Self {
            state: ListState::new(0, ListAlignment::Top, px(120.)),
            conversation: None,
            previous: None,
        }
    }
    pub fn sync(&mut self, conversation: Option<&str>, view: &Arc<View>) {
        if self.conversation.as_deref() != conversation {
            self.state.reset(view.messages.len());
            self.state.set_follow_mode(FollowMode::Tail);
            self.conversation = conversation.map(str::to_owned);
        } else if let Some(previous) = &self.previous {
            if Arc::ptr_eq(previous, view) {
                return;
            }
            let old = &previous.messages;
            let new = &view.messages;
            let anchor = self.state.logical_scroll_top();
            let anchor_id = old.get(anchor.item_ix).map(|message| message.id.as_str());
            let following = self.state.is_following_tail();
            let prefix = old
                .iter()
                .zip(new)
                .take_while(|(a, b)| a.id == b.id)
                .count();
            let suffix = old[prefix..]
                .iter()
                .rev()
                .zip(new[prefix..].iter().rev())
                .take_while(|(a, b)| a.id == b.id)
                .count();
            if prefix + suffix != old.len() || prefix + suffix != new.len() {
                self.state
                    .splice(prefix..old.len() - suffix, new.len() - prefix - suffix);
                // A capped live tail can evict its first row and append a last row
                // in the same update. Preserve the reader by identity, not index.
                if !following
                    && let Some(ix) =
                        anchor_id.and_then(|id| new.iter().position(|message| message.id == id))
                {
                    self.state.scroll_to(ListOffset {
                        item_ix: ix,
                        offset_in_item: anchor.offset_in_item,
                    });
                }
            }
            for (ix, message) in new.iter().enumerate() {
                let old_ix = if ix < prefix {
                    Some(ix)
                } else if ix >= new.len() - suffix {
                    Some(old.len() - (new.len() - ix))
                } else {
                    None
                };
                if let Some(old_ix) = old_ix
                    && &old[old_ix] != message
                {
                    self.state.remeasure_items(ix..ix + 1);
                }
            }
        } else {
            self.state.reset(view.messages.len());
            self.state.set_follow_mode(FollowMode::Tail);
        }
        self.previous = Some(view.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::ListOffset;
    fn view(ids: &[&str]) -> Arc<View> {
        let messages = ids
            .iter()
            .map(|id| {
                serde_json::from_value(serde_json::json!({
                    "id":id,"conversation_id":"chat","role":"assistant","kind":"text","text":id,
                    "status":"completed","sequence":1
                }))
                .unwrap()
            })
            .collect();
        {
            let mut view = View::default();
            view.messages = messages;
            Arc::new(view)
        }
    }
    #[test]
    fn streaming_remeasure_preserves_position_inside_long_message() {
        let mut list = TranscriptList::new();
        let initial = view(&["a", "b", "c"]);
        list.sync(Some("chat"), &initial);
        list.state.set_follow_mode(FollowMode::Normal);
        list.state.scroll_to(ListOffset {
            item_ix: 1,
            offset_in_item: px(123.),
        });
        let mut updated = (*initial).clone();
        updated.messages[1].text.push_str(" more streamed content");
        list.sync(Some("chat"), &Arc::new(updated));
        let position = list.state.logical_scroll_top();
        assert_eq!(position.item_ix, 1);
        assert_eq!(position.offset_in_item, px(123.));
        assert_eq!(list.state.item_count(), 3);
    }
    #[test]
    fn prepending_history_preserves_message_anchor_and_offset() {
        let mut list = TranscriptList::new();
        list.sync(Some("chat"), &view(&["b", "c"]));
        list.state.set_follow_mode(FollowMode::Normal);
        list.state.scroll_to(ListOffset {
            item_ix: 1,
            offset_in_item: px(42.),
        });
        list.sync(Some("chat"), &view(&["a", "b", "c"]));
        let position = list.state.logical_scroll_top();
        assert_eq!(position.item_ix, 2);
        assert_eq!(position.offset_in_item, px(42.));
        assert_eq!(list.state.item_count(), 3);
    }
    #[test]
    fn conversation_switch_resets_to_new_tail() {
        let mut list = TranscriptList::new();
        list.sync(Some("chat"), &view(&["a", "b"]));
        list.state.set_follow_mode(FollowMode::Normal);
        list.sync(Some("other"), &view(&["x"]));
        assert_eq!(list.state.item_count(), 1);
        assert!(list.state.is_following_tail());
        assert_eq!(list.state.logical_scroll_top().item_ix, 1);
    }
}

#[cfg(test)]
mod rotating_tail_tests {
    use super::*;
    #[test]
    fn capped_tail_keeps_surviving_reader_anchor() {
        let make = |ids: &[&str]| {
            let mut view = View::default();
            view.messages = ids.iter().map(|id| serde_json::from_value(serde_json::json!({"id":id,"conversation_id":"chat","role":"assistant","kind":"text","text":id,"status":"completed","sequence":1})).unwrap()).collect();
            Arc::new(view)
        };
        let mut list = TranscriptList::new();
        list.sync(Some("chat"), &make(&["a", "b", "c"]));
        list.state.set_follow_mode(FollowMode::Normal);
        list.state.scroll_to(ListOffset {
            item_ix: 1,
            offset_in_item: px(77.),
        });
        list.sync(Some("chat"), &make(&["b", "c", "d"]));
        assert_eq!(list.state.logical_scroll_top().item_ix, 0);
        assert_eq!(list.state.logical_scroll_top().offset_in_item, px(77.));
    }
}
