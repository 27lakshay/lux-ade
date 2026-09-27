//! Agent browser automation (F095): `browser.click` and `browser.type` as
//! effect commands, and the checks for the `browser.evaluate`, `browser.wait`
//! and `browser.screenshot` queries that `browser_tools` relays.
//!
//! Every operation names one exact owner and tab. Click and type go through
//! the same admission, dispatch and receipt path as `browser.navigate`, so a
//! lost reply leaves the receipt unknown and `browser.operation` reconciles it
//! from the owner's durable receipt. Nothing here re-sends input.
//!
//! The owner repeats every check below; the daemon checks first so a bad
//! request is refused before it is admitted or reaches the page.
use super::*;
use ade_core::contract::browser::{
    BrowserClickRequest, BrowserEvaluateRequest, BrowserScreenshotRequest, BrowserTypeRequest,
    BrowserWaitRequest,
};

const SELECTOR_CHARS: usize = 1024;
const TEXT_CHARS: usize = 4096;
const EXPRESSION_CHARS: usize = 8192;
/// Added to an operation's own page timeout to cover the owner's receipt
/// writes and debugger round trips before the reply counts as lost.
const REPLY_MARGIN: Duration = Duration::from_secs(8);

/// The effect commands this module admits.
pub(super) fn is_automation_effect(op: &str) -> bool {
    matches!(op, "browser.click" | "browser.type")
}

/// The queries `browser_tools` relays with this module's checks.
pub(super) fn is_automation_query(op: &str) -> bool {
    matches!(
        op,
        "browser.evaluate" | "browser.wait" | "browser.screenshot"
    )
}

/// A CSS selector the owner may hand to `querySelector`: 1 to 1024
/// characters, no control characters, not blank, with balanced brackets,
/// parentheses and quotes. The page still rejects other invalid syntax.
pub(super) fn check_selector(selector: &str) -> Result<(), String> {
    let count = selector.chars().count();
    if count == 0 || count > SELECTOR_CHARS {
        return Err(format!("selector must be 1 to {SELECTOR_CHARS} characters"));
    }
    if selector.chars().any(char::is_control) {
        return Err("selector must not contain control characters".into());
    }
    if selector.trim().is_empty() {
        return Err("selector must not be blank".into());
    }
    let mut open: Vec<char> = Vec::new();
    let mut quote: Option<char> = None;
    let mut chars = selector.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            // An escape consumes the next character, whatever it is.
            if chars.next().is_none() {
                return Err("selector ends inside an escape".into());
            }
            continue;
        }
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => quote = Some(c),
            '[' | '(' => open.push(c),
            ']' | ')' => {
                let expected = if c == ']' { '[' } else { '(' };
                if open.pop() != Some(expected) {
                    return Err("selector has unbalanced brackets".into());
                }
            }
            _ => {}
        }
    }
    if quote.is_some() {
        return Err("selector has an unclosed quote".into());
    }
    if !open.is_empty() {
        return Err("selector has unbalanced brackets".into());
    }
    Ok(())
}

/// Typed text: 1 to 4096 characters; tab and line feed are the only control
/// characters allowed.
pub(super) fn check_text(text: &str) -> Result<(), String> {
    let count = text.chars().count();
    if count == 0 || count > TEXT_CHARS {
        return Err(format!("text must be 1 to {TEXT_CHARS} characters"));
    }
    if text
        .chars()
        .any(|c| c.is_control() && c != '\t' && c != '\n')
    {
        return Err("text may contain no control characters but tab and line feed".into());
    }
    Ok(())
}

fn check_expression(expression: &str) -> Result<(), String> {
    let count = expression.chars().count();
    if count == 0 || count > EXPRESSION_CHARS {
        return Err(format!(
            "expression must be 1 to {EXPRESSION_CHARS} characters"
        ));
    }
    if expression.contains('\0') {
        return Err("expression must not contain NUL".into());
    }
    Ok(())
}

/// A timeout within `min..=max`, or `default` when absent.
fn timeout(value: Option<u64>, min: u64, max: u64, default: u64) -> Result<u64, String> {
    match value {
        None => Ok(default),
        Some(ms) if (min..=max).contains(&ms) => Ok(ms),
        Some(_) => Err(format!("timeout_ms must be between {min} and {max}")),
    }
}

/// The fingerprinted payload of a click or type. The owner recomputes
/// `sha256(JSON.stringify([op, profile, owner, tab, null, selector]))`, with
/// `text` and `replace` appended for a type. `timeout_ms` is left out: it
/// bounds the wait, not the effect.
pub(super) fn automation_payload(
    op: &str,
    profile_id: &str,
    owner_id: &str,
    tab_id: &str,
    selector: &str,
    typed: Option<(&str, bool)>,
) -> Value {
    let mut payload = browser_payload(op, profile_id, owner_id, Some(tab_id), None);
    if let Value::Array(items) = &mut payload {
        items.push(json!(selector));
        if let Some((text, replace)) = typed {
            items.push(json!(text));
            items.push(json!(replace));
        }
    }
    payload
}

fn invalid(message: impl std::fmt::Display) -> Value {
    browser_error("invalid_request", &message.to_string())
}

fn only_fields(request: &Value, allowed: &[&str]) -> Result<(), Value> {
    if request
        .as_object()
        .is_none_or(|fields| fields.keys().any(|key| !allowed.contains(&key.as_str())))
    {
        return Err(invalid("Unknown browser automation field"));
    }
    Ok(())
}

/// A checked automation query: its exact tab, the fields to forward and how
/// long the owner may take to answer.
pub(super) struct QueryRelay {
    pub tab_id: String,
    pub forward: Value,
    pub reply_timeout: Duration,
}

/// Checks one automation query and builds the fields `browser_tools` forwards.
pub(super) fn query_relay(op: &str, request: &Value) -> Result<QueryRelay, Value> {
    let tab_id = browser_id(request, "tab_id").map_err(invalid)?;
    let (forward, page_ms) = match op {
        "browser.evaluate" => {
            let evaluate: BrowserEvaluateRequest = browser_decode(request)?;
            check_expression(&evaluate.expression).map_err(invalid)?;
            let ms = timeout(evaluate.timeout_ms, 50, 5_000, 1_000).map_err(invalid)?;
            (serde_json::to_value(&evaluate).map_err(invalid)?, ms)
        }
        "browser.wait" => {
            let wait: BrowserWaitRequest = browser_decode(request)?;
            check_selector(&wait.selector).map_err(invalid)?;
            let ms = timeout(wait.timeout_ms, 0, 10_000, 5_000).map_err(invalid)?;
            (serde_json::to_value(&wait).map_err(invalid)?, ms)
        }
        "browser.screenshot" => {
            let shot: BrowserScreenshotRequest = browser_decode(request)?;
            (serde_json::to_value(&shot).map_err(invalid)?, 3_000)
        }
        _ => return Err(invalid("Unsupported browser operation")),
    };
    let mut forward = forward;
    forward["op"] = json!(op);
    Ok(QueryRelay {
        tab_id,
        forward,
        reply_timeout: Duration::from_millis(page_ms) + REPLY_MARGIN,
    })
}

/// A checked click or type, ready for `Host::browser_effect`.
struct EffectPlan {
    owner_id: String,
    request_id: String,
    tab_id: String,
    payload: Value,
    forward: serde_json::Map<String, Value>,
    reply_timeout: Duration,
}

fn effect_plan(op: &str, profile_id: &str, request: &Value) -> Result<EffectPlan, Value> {
    let owner_id = browser_id(request, "owner_id").map_err(invalid)?;
    let request_id = browser_request_id(request).map_err(invalid)?;
    let tab_id = browser_id(request, "tab_id").map_err(invalid)?;
    let common = [
        "op",
        "profile_id",
        "owner_id",
        "operation_id",
        "request_id",
        "diagnostic_id",
        "tab_id",
        "selector",
        "timeout_ms",
    ];
    let mut forward = serde_json::Map::new();
    let (selector, typed, ms) = if op == "browser.click" {
        only_fields(request, &common)?;
        let click: BrowserClickRequest = browser_decode(request)?;
        (click.selector, None, click.timeout_ms)
    } else {
        let mut allowed = common.to_vec();
        allowed.extend(["text", "replace"]);
        only_fields(request, &allowed)?;
        let typing: BrowserTypeRequest = browser_decode(request)?;
        check_text(&typing.text).map_err(invalid)?;
        let replace = typing.replace.unwrap_or(false);
        forward.insert("text".into(), json!(typing.text));
        forward.insert("replace".into(), json!(replace));
        (
            typing.selector,
            Some((typing.text, replace)),
            typing.timeout_ms,
        )
    };
    check_selector(&selector).map_err(invalid)?;
    let ms = timeout(ms, 100, 10_000, 5_000).map_err(invalid)?;
    let payload = automation_payload(
        op,
        profile_id,
        &owner_id,
        &tab_id,
        &selector,
        typed
            .as_ref()
            .map(|(text, replace)| (text.as_str(), *replace)),
    );
    forward.insert("selector".into(), json!(selector));
    forward.insert("timeout_ms".into(), json!(ms));
    Ok(EffectPlan {
        owner_id,
        request_id,
        tab_id,
        payload,
        forward,
        reply_timeout: Duration::from_millis(ms) + REPLY_MARGIN,
    })
}

impl Host {
    pub(super) fn browser_automation(&self, request: &Value) -> Value {
        let op = request["op"].as_str().unwrap_or("");
        let profile_id = match browser_id(request, "profile_id") {
            Ok(id) => id,
            Err(error) => return invalid(error),
        };
        if profile_id != self.profile_id {
            return browser_error(
                "unavailable",
                "Browser profile is unavailable on this daemon",
            );
        }
        let plan = match effect_plan(op, &profile_id, request) {
            Ok(plan) => plan,
            Err(error) => return error,
        };
        self.browser_effect(BrowserEffect {
            profile_id: &profile_id,
            op,
            owner_id: plan.owner_id,
            request_id: plan.request_id,
            tab_id: Some(plan.tab_id),
            payload: plan.payload,
            forward: plan.forward,
            reply_timeout: plan.reply_timeout,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selectors_are_bounded_and_structurally_balanced() {
        for good in [
            "#go",
            "button[data-x=\"a]b\"]",
            "li:nth-child(2) > a",
            "a[title='it\\'s']",
            "div\\[x",
        ] {
            assert_eq!(check_selector(good), Ok(()), "{good}");
        }
        for bad in ["", "   ", "a\nb", "a[x", "a)", "a[x=\"y]", "a(]", "a\\"] {
            assert!(check_selector(bad).is_err(), "{bad:?}");
        }
        assert!(check_selector(&"a".repeat(1024)).is_ok());
        assert!(check_selector(&"a".repeat(1025)).is_err());
    }

    #[test]
    fn typed_text_allows_only_tab_and_line_feed_controls() {
        assert!(check_text("line one\n\tline two é").is_ok());
        assert!(check_text("").is_err());
        assert!(check_text("a\rb").is_err());
        assert!(check_text("a\u{7f}").is_err());
        assert!(check_text(&"é".repeat(4096)).is_ok());
        assert!(check_text(&"é".repeat(4097)).is_err());
    }

    #[test]
    fn the_fingerprint_matches_the_owner_recomputation() {
        // Pinned vectors: apps/desktop/src/main/browser-automation-core.test.mjs
        // asserts the same digests from the owner's JSON.stringify.
        let click = automation_payload("browser.click", "p", "o", "t", "a[x=\"1\"]", None);
        let typed = automation_payload(
            "browser.type",
            "p",
            "o",
            "t",
            "input",
            Some(("é\n\t\"\\ \u{1}", true)),
        );
        for payload in [&click, &typed] {
            let stringified = format!("{:x}", Sha256::digest(payload.to_string().as_bytes()));
            assert_eq!(receipts::fingerprint(payload), stringified);
        }
        assert_eq!(
            (receipts::fingerprint(&click), receipts::fingerprint(&typed)),
            (
                "5053bda4b4e407f7e0d4778a4eb4e3062b4cb75ee9c9bad176888f6ef612b61a".to_owned(),
                "f14aebf066793a5c0e65f6346941c15167672a180327965776b074aa58d457a3".to_owned()
            )
        );
    }

    #[test]
    fn effects_are_checked_before_admission() {
        let click = json!({"op": "browser.click", "profile_id": "p", "owner_id": "o",
            "operation_id": "op-1", "tab_id": "t", "selector": "#go"});
        let plan = effect_plan("browser.click", "p", &click).unwrap();
        assert_eq!(plan.forward["timeout_ms"], 5000);
        assert_eq!(
            plan.reply_timeout,
            Duration::from_millis(5000) + REPLY_MARGIN
        );
        assert_eq!(plan.payload.as_array().unwrap().len(), 6);
        let mut smuggled = click.clone();
        smuggled["url"] = json!("https://a.test/");
        assert!(effect_plan("browser.click", "p", &smuggled).is_err());
        let mut untargeted = click.clone();
        untargeted.as_object_mut().unwrap().remove("tab_id");
        assert!(effect_plan("browser.click", "p", &untargeted).is_err());
        let mut slow = click;
        slow["timeout_ms"] = json!(60_000);
        assert!(effect_plan("browser.click", "p", &slow).is_err());
        let typing = json!({"op": "browser.type", "profile_id": "p", "owner_id": "o",
            "operation_id": "op-2", "tab_id": "t", "selector": "input", "text": "hi"});
        let plan = effect_plan("browser.type", "p", &typing).unwrap();
        assert_eq!(plan.forward["replace"], false);
        assert_eq!(plan.payload.as_array().unwrap()[7], false);
    }

    #[test]
    fn queries_are_bounded() {
        let evaluate = json!({"op": "browser.evaluate", "profile_id": "p", "owner_id": "o",
            "tab_id": "t", "expression": "document.title", "timeout_ms": 5001});
        assert!(query_relay("browser.evaluate", &evaluate).is_err());
        let wait = json!({"op": "browser.wait", "profile_id": "p", "owner_id": "o",
            "tab_id": "t", "selector": ".x", "timeout_ms": 0, "socket_path": "/tmp/x"});
        let relay = query_relay("browser.wait", &wait).unwrap();
        assert_eq!(relay.tab_id, "t");
        assert!(relay.forward.get("socket_path").is_none());
        assert_eq!(relay.forward["op"], "browser.wait");
        let shot = json!({"op": "browser.screenshot", "profile_id": "p", "owner_id": "o"});
        assert!(query_relay("browser.screenshot", &shot).is_err());
    }
}
