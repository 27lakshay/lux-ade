//! Settles a browser mutation the daemon holds as unknown from the owner's
//! durable receipt. After an owner or daemon crash, the owner reconciles its
//! pending receipt against its actual tabs; this decides whether that answer
//! is proof enough to settle the daemon's receipt. It never re-runs an effect.

use serde_json::Value;

/// The receipt the daemon holds, as the owner must echo it.
pub(crate) struct HeldReceipt<'a> {
    pub profile_id: &'a str,
    /// The owner that received the dispatch; it may since have been replaced.
    pub owner_id: &'a str,
    pub request_id: &'a str,
    pub fingerprint: &'a str,
}

/// Returns the result to settle the held receipt with, or `None` to keep it
/// unknown. `current_owner` is the owner the lookup went to.
///
/// Only a completed answer that names this exact receipt settles it. The
/// result is either the mutation the owner proved from its tabs, or a
/// `not_applied` error the owner proved from them. Anything else leaves the
/// outcome unknown, so the caller must inspect before acting again.
pub(crate) fn owner_settlement<'a>(
    held: &HeldReceipt<'_>,
    current_owner: &str,
    owner_reply: &'a Value,
) -> Option<&'a Value> {
    let result = &owner_reply["result"];
    let envelope = owner_reply["type"] == "browser_operation"
        && owner_reply["state"] == "completed"
        && owner_reply["profile_id"] == held.profile_id
        && owner_reply["owner_id"] == current_owner
        && owner_reply["request_id"] == held.request_id
        && owner_reply["payload_fingerprint"] == held.fingerprint;
    let names_receipt = result.is_object()
        && result["profile_id"] == held.profile_id
        && result["owner_id"] == held.owner_id
        && result["request_id"] == held.request_id
        && result["payload_fingerprint"] == held.fingerprint;
    let proven = match result["type"].as_str() {
        Some("browser_mutation") => result["tab_id"].as_str().is_some_and(valid_tab_id),
        Some("error") => result["code"] == "not_applied",
        _ => false,
    };
    (envelope && names_receipt && proven).then_some(result)
}

fn valid_tab_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const HELD: HeldReceipt<'static> = HeldReceipt {
        profile_id: "profile",
        owner_id: "owner-a",
        request_id: "req-1",
        fingerprint: "fp",
    };

    fn identity() -> Value {
        json!({"profile_id":"profile","owner_id":"owner-a","request_id":"req-1","payload_fingerprint":"fp"})
    }

    fn reply(current_owner: &str, state: &str, mut result: Value) -> Value {
        if let (Some(result), Value::Object(identity)) = (result.as_object_mut(), identity()) {
            for (key, value) in identity {
                result.entry(key).or_insert(value);
            }
        }
        json!({"type":"browser_operation","profile_id":"profile","owner_id":current_owner,
            "request_id":"req-1","payload_fingerprint":"fp","state":state,"result":result})
    }

    #[test]
    fn a_proven_mutation_settles_even_from_a_replacement_owner() {
        let answer = reply(
            "owner-b",
            "completed",
            json!({"type":"browser_mutation","op":"browser.open","tab_id":"tab-1"}),
        );
        assert_eq!(
            owner_settlement(&HELD, "owner-b", &answer),
            Some(&answer["result"])
        );
    }

    #[test]
    fn a_proven_not_applied_outcome_settles() {
        let answer = reply(
            "owner-b",
            "completed",
            json!({"type":"error","code":"not_applied","message":"tab absent"}),
        );
        assert_eq!(
            owner_settlement(&HELD, "owner-b", &answer),
            Some(&answer["result"])
        );
    }

    #[test]
    fn an_unknown_or_unproven_answer_keeps_the_receipt_unknown() {
        let mutation = json!({"type":"browser_mutation","op":"browser.open","tab_id":"tab-1"});
        assert_eq!(
            owner_settlement(&HELD, "owner-b", &reply("owner-b", "unknown", mutation)),
            None
        );
        for result in [
            json!({"type":"error","code":"unavailable","message":"gone"}),
            json!({"type":"browser_mutation","op":"browser.open"}),
            json!({"type":"browser_mutation","op":"browser.open","tab_id":"../x"}),
            json!({"type":"other","tab_id":"tab-1"}),
        ] {
            assert_eq!(
                owner_settlement(&HELD, "owner-b", &reply("owner-b", "completed", result)),
                None
            );
        }
        let mut missing = reply("owner-b", "completed", json!(null));
        missing["result"] = Value::Null;
        assert_eq!(owner_settlement(&HELD, "owner-b", &missing), None);
    }

    #[test]
    fn an_answer_about_another_receipt_or_from_another_owner_is_rejected() {
        let mutation = json!({"type":"browser_mutation","op":"browser.open","tab_id":"tab-1"});
        let answer = reply("owner-b", "completed", mutation.clone());
        // The answer came from an owner other than the one asked.
        assert_eq!(owner_settlement(&HELD, "owner-c", &answer), None);
        for (field, value) in [
            ("profile_id", "profile-2"),
            ("owner_id", "owner-z"),
            ("request_id", "req-2"),
            ("payload_fingerprint", "fp-2"),
        ] {
            let mut result = mutation.clone();
            result[field] = json!(value);
            let answer = reply("owner-b", "completed", result);
            assert_eq!(owner_settlement(&HELD, "owner-b", &answer), None, "{field}");
            let mut envelope = reply("owner-b", "completed", mutation.clone());
            if field != "owner_id" {
                envelope[field] = json!(value);
                assert_eq!(
                    owner_settlement(&HELD, "owner-b", &envelope),
                    None,
                    "{field}"
                );
            }
        }
        let mut wrong_type = reply("owner-b", "completed", mutation);
        wrong_type["type"] = json!("error");
        assert_eq!(owner_settlement(&HELD, "owner-b", &wrong_type), None);
    }
}
