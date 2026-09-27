//! Redaction rules for diagnostics bundles. Every function here is pure.
//!
//! Portions adapted from Orca `src/main/observability/redactor.ts` (MIT):
//! the key-family blocklist, the labeled key-value rule, the provider-key
//! fingerprints with tagged replacements, and URL userinfo stripping. This is
//! a Rust re-expression without regular expressions; ADE adds transcript-key
//! removal, home-path folding and size bounds.
//!
//! The string rules are idempotent: redacting an already redacted value
//! changes nothing, so a value may pass through them more than once.

use ade_core::contract::daemon::DiagnosticRedaction;
use serde_json::{Map, Value};

/// The rule set's version, reported in every bundle.
pub const POLICY: &str = "ade-redaction-v1";
/// Longest string kept, in bytes; longer strings are cut at a character boundary.
pub const MAX_STRING_BYTES: usize = 1024;
/// Most array items or object entries kept per container.
pub const MAX_ITEMS: usize = 500;
/// Deepest nesting kept; deeper containers become `null`.
pub const MAX_DEPTH: usize = 16;

const TRUNCATED: &str = "…[truncated]";

/// What a key says about its value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyClass {
    /// The value may be a credential; drop it.
    Credential,
    /// The value may be transcript, prompt, terminal or process output; drop it.
    Transcript,
    Keep,
}

/// Key families whose values are credentials, matched against the key with
/// case and punctuation removed, so `ANTHROPIC_API_KEY` and `x-api-key` match.
const CREDENTIAL_FAMILIES: &[&str] = &[
    "apikey",
    "token",
    "secret",
    "password",
    "passwd",
    "passphrase",
    "authorization",
    "bearer",
    "cookie",
    "credential",
    "privatekey",
    "accesskey",
    "sessionkey",
    "clientsecret",
];

/// Keys whose whole value is a credential store, matched exactly.
const CREDENTIAL_KEYS: &[&str] = &["env", "environment", "env_vars", "headers", "auth"];

/// Keys whose values carry conversation or process content, matched exactly.
const TRANSCRIPT_KEYS: &[&str] = &[
    "text",
    "prompt",
    "prompts",
    "content",
    "contents",
    "message_text",
    "messages",
    "transcript",
    "output",
    "stdout",
    "stderr",
    "body",
    "draft",
    "draft_text",
    "snapshot",
    "scrollback",
    "diff",
    "patch",
    "input",
    "args",
    "argv",
    "arguments",
    "command_line",
    "commands",
    "payload",
    "result",
];

pub fn classify_key(key: &str) -> KeyClass {
    let lower = key.to_ascii_lowercase();
    let normalized: String = lower
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    if CREDENTIAL_KEYS.contains(&lower.as_str())
        || CREDENTIAL_FAMILIES
            .iter()
            .any(|family| normalized.contains(family))
    {
        KeyClass::Credential
    } else if TRANSCRIPT_KEYS.contains(&lower.as_str()) {
        KeyClass::Transcript
    } else {
        KeyClass::Keep
    }
}

/// Applies the rules to a value and counts what it removed.
pub struct Redactor {
    home: Option<String>,
    summary: DiagnosticRedaction,
}

impl Redactor {
    /// `home` is the directory folded to `~`; `None`, empty or `/` disables it.
    pub fn new(home: Option<&str>) -> Self {
        let home = home
            .map(|home| home.trim_end_matches('/'))
            .filter(|home| home.len() > 1)
            .map(str::to_owned);
        Self {
            home,
            summary: DiagnosticRedaction {
                policy: POLICY.into(),
                ..DiagnosticRedaction::default()
            },
        }
    }

    pub fn summary(&self) -> DiagnosticRedaction {
        self.summary.clone()
    }

    pub fn value(&mut self, value: Value) -> Value {
        self.walk(value, 0)
    }

    fn walk(&mut self, value: Value, depth: usize) -> Value {
        match value {
            Value::String(text) => Value::String(self.string(&text)),
            Value::Array(_) | Value::Object(_) if depth >= MAX_DEPTH => {
                self.summary.truncations += 1;
                Value::Null
            }
            Value::Array(items) => {
                if items.len() > MAX_ITEMS {
                    self.summary.truncations += 1;
                }
                Value::Array(
                    items
                        .into_iter()
                        .take(MAX_ITEMS)
                        .map(|item| self.walk(item, depth + 1))
                        .collect(),
                )
            }
            Value::Object(entries) => {
                if entries.len() > MAX_ITEMS {
                    self.summary.truncations += 1;
                }
                let mut kept = Map::new();
                for (key, item) in entries.into_iter().take(MAX_ITEMS) {
                    let key = self.string(&key);
                    let item = match (classify_key(&key), &item) {
                        (_, Value::Null) => Value::Null,
                        (KeyClass::Credential, _) => {
                            self.summary.credential_fields += 1;
                            Value::String("[redacted:credential]".into())
                        }
                        (KeyClass::Transcript, _) => {
                            self.summary.transcript_fields += 1;
                            Value::String("[redacted:transcript]".into())
                        }
                        (KeyClass::Keep, _) => self.walk(item, depth + 1),
                    };
                    kept.insert(key, item);
                }
                Value::Object(kept)
            }
            scalar => scalar,
        }
    }

    /// Applies the string rules in order: PEM blocks, labeled key-values,
    /// provider-key fingerprints, URL userinfo, home paths, then the length bound.
    pub fn string(&mut self, input: &str) -> String {
        let mut out = pem_blocks(input, &mut self.summary.secret_patterns);
        out = labeled_values(&out, &mut self.summary.secret_patterns);
        out = provider_keys(&out, &mut self.summary.secret_patterns);
        out = url_userinfo(&out, &mut self.summary.secret_patterns);
        if let Some(home) = &self.home {
            out = fold_home(&out, home, &mut self.summary.home_paths);
        }
        if out.len() > MAX_STRING_BYTES {
            self.summary.truncations += 1;
            let mut end = MAX_STRING_BYTES;
            while !out.is_char_boundary(end) {
                end -= 1;
            }
            out.truncate(end);
            out.push_str(TRUNCATED);
        }
        out
    }
}

fn pem_blocks(input: &str, count: &mut u64) -> String {
    const BEGIN: &str = "-----BEGIN ";
    const END: &str = "-----END ";
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find(BEGIN) {
        out.push_str(&rest[..start]);
        *count += 1;
        out.push_str("[redacted:pem]");
        let after = &rest[start + BEGIN.len()..];
        // Without a complete END line, everything after BEGIN is key material.
        rest = match after.find(END) {
            Some(end) => {
                let tail = &after[end + END.len()..];
                match tail.find("-----") {
                    Some(close) => &tail[close + 5..],
                    None => "",
                }
            }
            None => "",
        };
    }
    out.push_str(rest);
    out
}

/// Labels whose following `:` or `=` value is a credential. Longer labels
/// come first so `access_token` is not matched as `token`.
const LABELS: &[&str] = &[
    "authorization",
    "access_token",
    "refresh_token",
    "api_key",
    "api-key",
    "apikey",
    "password",
    "passwd",
    "secret",
    "bearer",
    "token",
];

fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn value_end(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len()
        && !bytes[index].is_ascii_whitespace()
        && !matches!(
            bytes[index],
            b'"' | b'\'' | b',' | b';' | b'&' | b')' | b'}' | b']'
        )
    {
        index += 1;
    }
    index
}

fn skip_spaces(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && matches!(bytes[index], b' ' | b'\t') {
        index += 1;
    }
    index
}

/// `token=abc`, `Authorization: Bearer abc` and `Bearer abc` lose their value.
fn labeled_values(input: &str, count: &mut u64) -> String {
    let lower = input.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut copied = 0;
    let mut index = 0;
    while index < bytes.len() {
        if index > 0 && is_word(bytes[index - 1]) {
            index += 1;
            continue;
        }
        let Some(label) = LABELS
            .iter()
            .find(|label| bytes[index..].starts_with(label.as_bytes()))
        else {
            index += 1;
            continue;
        };
        let after_label = index + label.len();
        if after_label < bytes.len() && is_word(bytes[after_label]) {
            index += 1;
            continue;
        }
        let mut cursor = skip_spaces(bytes, after_label);
        let separated = cursor < bytes.len() && matches!(bytes[cursor], b':' | b'=');
        if separated {
            cursor = skip_spaces(bytes, cursor + 1);
            // A scheme word such as `Bearer` or `Basic` belongs to the value.
            for scheme in ["bearer ", "basic ", "token "] {
                if bytes[cursor..].starts_with(scheme.as_bytes()) {
                    cursor = skip_spaces(bytes, cursor + scheme.len());
                    break;
                }
            }
        } else if *label != "bearer" || cursor == after_label {
            // Only `Bearer <value>` is a credential without a separator.
            index += 1;
            continue;
        }
        let end = value_end(bytes, cursor);
        if end == cursor || bytes[cursor..end].starts_with(b"[redacted") {
            index = after_label;
            continue;
        }
        out.push_str(&input[copied..index]);
        out.push_str("[redacted:labeled]");
        *count += 1;
        copied = end;
        index = end;
    }
    out.push_str(&input[copied..]);
    out
}

fn is_key_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

fn run_len(bytes: &[u8], start: usize, accept: impl Fn(u8) -> bool) -> usize {
    bytes[start..]
        .iter()
        .take_while(|byte| accept(**byte))
        .count()
}

/// The length and tag of a provider credential starting at `index`, if any.
fn provider_key_at(bytes: &[u8], index: usize) -> Option<(usize, &'static str)> {
    let rest = &bytes[index..];
    let prefixed = |prefix: &[u8], min: usize, tag: &'static str| {
        rest.starts_with(prefix)
            .then(|| run_len(bytes, index + prefix.len(), is_key_char))
            .filter(|len| *len >= min)
            .map(|len| (prefix.len() + len, tag))
    };
    if let Some(found) = prefixed(b"sk-ant-", 20, "anthropic-key")
        .or_else(|| prefixed(b"sk-", 20, "openai-key"))
        .or_else(|| prefixed(b"github_pat_", 20, "github-token"))
        .or_else(|| prefixed(b"glpat-", 20, "gitlab-token"))
    {
        return Some(found);
    }
    if rest.len() >= 4
        && rest.starts_with(b"gh")
        && matches!(rest[2], b'p' | b'o' | b'u' | b's' | b'r')
        && rest[3] == b'_'
    {
        let len = run_len(bytes, index + 4, |b| b.is_ascii_alphanumeric());
        if len >= 30 {
            return Some((4 + len, "github-token"));
        }
    }
    if rest.len() >= 5
        && rest.starts_with(b"xox")
        && matches!(rest[3], b'b' | b'a' | b'p' | b'r' | b's' | b'o' | b'e')
        && rest[4] == b'-'
    {
        let len = run_len(bytes, index + 5, is_key_char);
        if len >= 10 {
            return Some((5 + len, "slack-token"));
        }
    }
    if rest.starts_with(b"AKIA")
        && run_len(bytes, index + 4, |b| {
            b.is_ascii_uppercase() || b.is_ascii_digit()
        }) >= 16
    {
        return Some((20, "aws-access-key-id"));
    }
    if rest.starts_with(b"eyJ") {
        // Three base64url segments separated by dots.
        let mut cursor = index;
        for segment in 0..3 {
            let len = run_len(bytes, cursor, is_key_char);
            if len < 10 {
                return None;
            }
            cursor += len;
            if segment < 2 {
                if bytes.get(cursor) != Some(&b'.') {
                    return None;
                }
                cursor += 1;
            }
        }
        return Some((cursor - index, "jwt"));
    }
    None
}

fn provider_keys(input: &str, count: &mut u64) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut copied = 0;
    let mut index = 0;
    while index < bytes.len() {
        if index > 0 && is_key_char(bytes[index - 1]) {
            index += 1;
            continue;
        }
        match provider_key_at(bytes, index) {
            Some((len, tag)) => {
                out.push_str(&input[copied..index]);
                out.push_str("[redacted:");
                out.push_str(tag);
                out.push(']');
                *count += 1;
                index += len;
                copied = index;
            }
            None => index += 1,
        }
    }
    out.push_str(&input[copied..]);
    out
}

/// `https://user:pass@host/` keeps its host and path and loses its userinfo.
fn url_userinfo(input: &str, count: &mut u64) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(scheme) = rest.find("://") {
        let authority_start = scheme + 3;
        out.push_str(&rest[..authority_start]);
        let authority = &rest[authority_start..];
        let authority_end = authority
            .find(|c: char| c == '/' || c == '?' || c == '#' || c.is_whitespace())
            .unwrap_or(authority.len());
        match authority[..authority_end].rfind('@') {
            Some(at) if &authority[..at] != "[redacted]" => {
                out.push_str("[redacted]");
                *count += 1;
                rest = &authority[at..];
            }
            _ => rest = authority,
        }
    }
    out.push_str(rest);
    out
}

/// Replaces the home directory with `~` where it starts a path component.
fn fold_home(input: &str, home: &str, count: &mut u64) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find(home) {
        let end = start + home.len();
        let bounded_before = start == 0
            || !rest.as_bytes()[start - 1].is_ascii_alphanumeric()
                && rest.as_bytes()[start - 1] != b'/';
        let bounded_after = rest[end..]
            .chars()
            .next()
            .is_none_or(|next| next == '/' || !(next.is_alphanumeric() || next == '_'));
        out.push_str(&rest[..start]);
        if bounded_before && bounded_after {
            out.push('~');
            *count += 1;
        } else {
            out.push_str(home);
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

/// Keeps the newest events that fit `max_bytes` beside `fixed_bytes` of other
/// bundle content. Events are oldest first; the oldest are dropped first.
/// Returns the kept events and whether any were dropped, or `None` when the
/// fixed content alone exceeds the bound.
pub fn fit_events(
    events: Vec<Value>,
    fixed_bytes: usize,
    max_bytes: usize,
) -> Option<(Vec<Value>, bool)> {
    let mut remaining = max_bytes.checked_sub(fixed_bytes)?;
    let mut kept = Vec::new();
    let total = events.len();
    for event in events.into_iter().rev() {
        // One separator byte per event, beside its serialized size.
        let size = event.to_string().len() + 1;
        if size > remaining {
            break;
        }
        remaining -= size;
        kept.push(event);
    }
    kept.reverse();
    let dropped = kept.len() < total;
    Some((kept, dropped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn redact(input: &str) -> String {
        Redactor::new(Some("/Users/person")).string(input)
    }

    #[test]
    fn credential_and_transcript_keys_lose_their_values() {
        for key in [
            "token",
            "ANTHROPIC_API_KEY",
            "x-api-key",
            "refresh_token",
            "Authorization",
            "client_secret",
            "env",
            "cookie",
            "private_key",
        ] {
            assert_eq!(classify_key(key), KeyClass::Credential, "{key}");
        }
        for key in ["prompt", "text", "stdout", "messages", "snapshot", "Output"] {
            assert_eq!(classify_key(key), KeyClass::Transcript, "{key}");
        }
        for key in [
            "host_key",
            "scrollback_bytes",
            "reply_dropped_bytes",
            "run_id",
            "reason",
            "account_pinned",
            "session_worktree_leases",
        ] {
            assert_eq!(classify_key(key), KeyClass::Keep, "{key}");
        }
        let mut redactor = Redactor::new(None);
        let value = redactor.value(json!({
            "account": {"token": "abc", "name": "work"},
            "prompt": "fix the bug",
            "api_key": null,
            "items": [{"stdout": ["line"]}],
        }));
        assert_eq!(
            value,
            json!({
                "account": {"token": "[redacted:credential]", "name": "work"},
                "prompt": "[redacted:transcript]",
                "api_key": null,
                "items": [{"stdout": "[redacted:transcript]"}],
            })
        );
        let summary = redactor.summary();
        assert_eq!(summary.policy, POLICY);
        assert_eq!(summary.credential_fields, 1);
        assert_eq!(summary.transcript_fields, 2);
    }

    #[test]
    fn labeled_values_are_redacted_with_their_scheme() {
        assert_eq!(redact("token=abc123 next"), "[redacted:labeled] next");
        assert_eq!(
            redact("Authorization: Bearer abc.def-ghi"),
            "[redacted:labeled]"
        );
        assert_eq!(
            redact("curl -H 'x: y' \"Bearer abcdefgh\""),
            "curl -H 'x: y' \"[redacted:labeled]\""
        );
        assert_eq!(
            redact("url?access_token=zzz&page=2"),
            "url?[redacted:labeled]&page=2"
        );
        assert_eq!(redact("PASSWORD = hunter2"), "[redacted:labeled]");
        // Words that only contain a label, or a label without a value, stay.
        assert_eq!(redact("tokens: 12"), "tokens: 12");
        assert_eq!(redact("mytoken=1"), "mytoken=1");
        assert_eq!(redact("the token expired"), "the token expired");
        assert_eq!(redact("secret:"), "secret:");
        // Multibyte text around and inside values keeps its boundaries.
        assert_eq!(redact("é token=é密 ü"), "é [redacted:labeled] ü");
        assert_eq!(redact("ééé sk-ü"), "ééé sk-ü");
    }

    #[test]
    fn provider_keys_are_replaced_with_tags() {
        let anthropic = format!("key sk-ant-{} end", "a".repeat(40));
        assert_eq!(redact(&anthropic), "key [redacted:anthropic-key] end");
        let openai = format!("sk-proj-{}", "B".repeat(32));
        assert_eq!(redact(&openai), "[redacted:openai-key]");
        let github = format!("(ghp_{})", "c".repeat(36));
        assert_eq!(redact(&github), "([redacted:github-token])");
        assert_eq!(
            redact("id AKIAABCDEFGHIJKLMNOP."),
            "id [redacted:aws-access-key-id]."
        );
        assert_eq!(redact("xoxb-1234567890-abc"), "[redacted:slack-token]");
        let jwt = "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4";
        assert_eq!(redact(jwt), "[redacted:jwt]");
        // Short or embedded look-alikes stay.
        assert_eq!(redact("task-sk-1"), "task-sk-1");
        assert_eq!(redact("sk-short"), "sk-short");
    }

    #[test]
    fn pem_blocks_and_url_userinfo_are_removed() {
        let pem = "a -----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY----- b";
        assert_eq!(redact(pem), "a [redacted:pem] b");
        assert_eq!(
            redact("-----BEGIN RSA PRIVATE KEY-----\nMIIE"),
            "[redacted:pem]"
        );
        assert_eq!(
            redact("clone https://user:pw@github.com/o/r.git failed"),
            "clone https://[redacted]@github.com/o/r.git failed"
        );
        assert_eq!(
            redact("see https://example.com/a@b"),
            "see https://example.com/a@b"
        );
    }

    #[test]
    fn home_paths_fold_to_a_tilde_only_at_component_boundaries() {
        assert_eq!(redact("/Users/person/work/ade"), "~/work/ade");
        assert_eq!(redact("at /Users/person"), "at ~");
        assert_eq!(redact("/Users/personal/x"), "/Users/personal/x");
        assert_eq!(redact("/tmp/Users/person/x"), "/tmp/Users/person/x");
        assert_eq!(
            Redactor::new(Some("/")).string("/Users/person"),
            "/Users/person"
        );
    }

    #[test]
    fn string_rules_are_idempotent() {
        let samples = [
            "token=abc Authorization: Bearer xyz".to_owned(),
            format!("sk-ant-{} https://u:p@h/x", "q".repeat(40)),
            "-----BEGIN KEY-----\nabc\n-----END KEY-----".to_owned(),
            "/Users/person/a and eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4".to_owned(),
        ];
        for sample in samples {
            let once = redact(&sample);
            assert_eq!(redact(&once), once, "{sample}");
        }
    }

    #[test]
    fn values_are_bounded_in_length_breadth_and_depth() {
        let mut redactor = Redactor::new(None);
        let long = "é".repeat(MAX_STRING_BYTES);
        let cut = redactor.string(&long);
        assert!(cut.len() <= MAX_STRING_BYTES + TRUNCATED.len());
        assert!(cut.ends_with(TRUNCATED));
        let wide = redactor.value(json!(vec![1; MAX_ITEMS + 5]));
        assert_eq!(wide.as_array().unwrap().len(), MAX_ITEMS);
        let mut deep = json!("leaf");
        for _ in 0..(MAX_DEPTH + 3) {
            deep = json!([deep]);
        }
        let mut cursor = &redactor.value(deep);
        let mut depth = 0;
        while let Some(items) = cursor.as_array() {
            cursor = &items[0];
            depth += 1;
        }
        assert_eq!(depth, MAX_DEPTH);
        assert!(cursor.is_null());
        assert_eq!(redactor.summary().truncations, 3);
    }

    #[test]
    fn a_clean_status_passes_unchanged() {
        let status = json!({"type": "diagnostics_status", "identity": {"host_key": "0123456789abcdef",
            "profile_id": "fixed-1", "runtime_instance": "instance_1"},
            "counters": [{"name": "feed.subscribers_evicted", "kind": "dropped", "value": 0}],
            "live": {"terminals": [{"scrollback_bytes": 10, "reply_dropped_bytes": 0,
                "transfer_id": "transfer_1"}]},
            "claims": {"unresolved": [{"reason": "the runtime could not verify its exit",
                "holds_worktree": true}]}});
        let mut redactor = Redactor::new(Some("/Users/person"));
        assert_eq!(redactor.value(status.clone()), status);
        let summary = redactor.summary();
        assert_eq!(
            summary,
            DiagnosticRedaction {
                policy: POLICY.into(),
                ..DiagnosticRedaction::default()
            }
        );
    }

    #[test]
    fn events_fit_the_bound_by_dropping_the_oldest() {
        let events: Vec<Value> = (0..10).map(|n| json!({"n": n})).collect();
        let each = json!({"n": 0}).to_string().len() + 1;
        let (kept, dropped) = fit_events(events.clone(), 100, 100 + each * 3).unwrap();
        assert_eq!(
            kept,
            vec![json!({"n": 7}), json!({"n": 8}), json!({"n": 9})]
        );
        assert!(dropped);
        let (kept, dropped) = fit_events(events.clone(), 0, 10_000).unwrap();
        assert_eq!(kept.len(), 10);
        assert!(!dropped);
        assert!(fit_events(events, 101, 100).is_none());
    }
}
