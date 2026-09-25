//! Bounded identifiers and operation families for privacy-safe diagnostics.

pub fn new_id() -> String {
    format!("diag_{}", uuid::Uuid::new_v4())
}

pub fn valid_id(value: &str) -> bool {
    valid_prefixed_id(value, "diag")
}

pub fn valid_run_id(value: &str) -> bool {
    valid_prefixed_id(value, "run")
}

fn valid_prefixed_id(value: &str, prefix: &str) -> bool {
    let Some(uuid) = value
        .strip_prefix(prefix)
        .and_then(|value| value.strip_prefix('_'))
    else {
        return false;
    };
    uuid.len() == 36 && uuid::Uuid::parse_str(uuid).is_ok_and(|parsed| parsed.to_string() == uuid)
}

/// Never write an untrusted operation name to a log. Families are fixed labels.
pub fn operation_family(op: &str) -> &'static str {
    match op.split_once('.').map_or(op, |(family, _)| family) {
        "hello" => "hello",
        "agent" => "agent",
        "attachment" => "attachment",
        "catalog" => "catalog",
        "conversation" => "conversation",
        "draft" => "draft",
        "queue" => "queue",
        "review" => "review",
        "runtime" => "runtime",
        "service" => "service",
        "session" => "session",
        "terminal" => "terminal",
        "window" => "window",
        "workspace" => "workspace",
        "worktree" => "worktree",
        _ => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_ids_are_canonical_and_untrusted_values_are_rejected() {
        let id = new_id();
        assert!(valid_id(&id));
        assert!(valid_run_id(&format!("run_{}", uuid::Uuid::new_v4())));
        for invalid in [
            "diag_../../private",
            "diag_00000000-0000-0000-0000-000000000000\nsecret",
            "diag_00000000-0000-0000-0000-000000000000<script>",
            "request_00000000-0000-0000-0000-000000000000",
        ] {
            assert!(!valid_id(invalid));
        }
    }

    #[test]
    fn operation_family_does_not_echo_untrusted_operation_text() {
        assert_eq!(operation_family("conversation.get"), "conversation");
        assert_eq!(operation_family("secret/path?token=abc"), "other");
        assert_eq!(operation_family("worktree.remove"), "worktree");
    }
}
