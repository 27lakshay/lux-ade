//! Pure decisions for the history search projection: query sanitizing, cursors,
//! excerpts and catch-up planning. Nothing here touches SQLite.
use serde_json::Value;

/// Bump when the indexed columns or tokenizer change; the next step rebuilds.
pub const INDEX_VERSION: i64 = 1;
const MAX_QUERY_BYTES: usize = 256;
const MAX_TERMS: usize = 16;

/// The durable progress of the projection, one row in `history_index_state`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexState {
    pub version: i64,
    pub epoch: i64,
    /// The last journal sequence the index has applied.
    pub applied: i64,
    pub rebuilding: bool,
    /// The last message ID a rebuild has indexed; none before the first batch.
    pub backfill_after: Option<String>,
}

/// The next unit of index work.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// Discard the index, start a new epoch and rebuild from durable history.
    Reset,
    /// Index the next batch of messages after this ID.
    Backfill {
        after: Option<String>,
    },
    /// Apply journal entries after this sequence.
    Apply {
        after: i64,
    },
    Idle,
}

/// Decides the next step from the saved state and the journal's highest
/// assigned sequence. A journal that is behind the saved state means the two
/// disagree (for example after a partial restore), so the index rebuilds
/// rather than trusting either.
pub fn plan(state: &IndexState, head: i64) -> Step {
    if state.version != INDEX_VERSION || head < state.applied || state.epoch < 1 {
        Step::Reset
    } else if state.rebuilding {
        Step::Backfill {
            after: state.backfill_after.clone(),
        }
    } else if head > state.applied {
        Step::Apply {
            after: state.applied,
        }
    } else {
        Step::Idle
    }
}

/// Changes the index has not applied. A pending reset counts as not caught up.
pub fn lag(state: &IndexState, head: i64) -> (u64, bool) {
    let pending = u64::try_from(head.saturating_sub(state.applied)).unwrap_or(0);
    let caught_up = plan(state, head) == Step::Idle;
    (pending, caught_up)
}

/// One journal entry: sequence, message ID and change time in milliseconds.
pub type JournalEntry = (i64, String, i64);

/// Collapses a batch of journal entries into one reindex per message, since
/// the indexer reads each message's current state rather than replaying
/// changes. Returns each message with its earliest change time in the batch,
/// in first-change order, plus the highest sequence the batch covers.
pub fn collapse(entries: &[JournalEntry]) -> (Vec<(String, i64)>, Option<i64>) {
    let mut messages: Vec<(String, i64)> = Vec::new();
    for (_, id, changed_at) in entries {
        match messages.iter_mut().find(|(seen, _)| seen == id) {
            Some((_, first)) => *first = (*first).min(*changed_at),
            None => messages.push((id.clone(), *changed_at)),
        }
    }
    (messages, entries.iter().map(|(seq, _, _)| *seq).max())
}

/// Why a search query was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum QueryError {
    Empty,
    TooLong,
    TooManyTerms,
}

impl std::fmt::Display for QueryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Empty => "History search query has no terms",
            Self::TooLong => "History search query must be 1 to 256 bytes",
            Self::TooManyTerms => "History search query has more than 16 terms",
        })
    }
}

impl std::error::Error for QueryError {}

/// One user term: its text and whether it matches as a prefix.
#[derive(Debug, PartialEq, Eq)]
pub struct Term {
    pub text: String,
    pub prefix: bool,
}

/// Splits user input into literal terms. FTS5 syntax (quotes, operators,
/// column filters, parentheses) carries no meaning; only a trailing `*`
/// marks a prefix.
pub fn terms(input: &str) -> Result<Vec<Term>, QueryError> {
    if input.len() > MAX_QUERY_BYTES {
        return Err(QueryError::TooLong);
    }
    let terms: Vec<Term> = input
        .split_whitespace()
        .filter_map(|word| {
            let prefix = word.ends_with('*');
            let text: String = word
                .trim_end_matches('*')
                .chars()
                .filter(|c| !c.is_control())
                .collect();
            // A term with no letters or digits indexes nothing and would make
            // FTS5 reject the whole query.
            text.chars()
                .any(char::is_alphanumeric)
                .then_some(Term { text, prefix })
        })
        .collect();
    if terms.is_empty() {
        return Err(QueryError::Empty);
    }
    if terms.len() > MAX_TERMS {
        return Err(QueryError::TooManyTerms);
    }
    Ok(terms)
}

/// Renders terms as an FTS5 query in which every term is a quoted string, so
/// user input can never be read as an operator. Terms are implicitly ANDed.
pub fn fts_query(terms: &[Term]) -> String {
    terms
        .iter()
        .map(|term| {
            let quoted = format!("\"{}\"", term.text.replace('"', "\"\""));
            if term.prefix { quoted + "*" } else { quoted }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// A search cursor: the index epoch and the last document on the page.
pub fn search_cursor(epoch: i64, doc: i64) -> String {
    format!("{epoch}.{doc}")
}

/// Why a cursor was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum CursorError {
    Invalid,
    /// The index was rebuilt since this cursor was issued.
    Expired,
}

impl std::fmt::Display for CursorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Invalid => "Invalid history cursor",
            Self::Expired => "History cursor expired because the index was rebuilt; search again",
        })
    }
}

impl std::error::Error for CursorError {}

/// Reads a search cursor issued for `epoch`; returns the document to page before.
pub fn parse_search_cursor(cursor: &str, epoch: i64) -> Result<i64, CursorError> {
    let (issued, doc) = cursor.split_once('.').ok_or(CursorError::Invalid)?;
    let issued: i64 = issued.parse().map_err(|_| CursorError::Invalid)?;
    let doc: i64 = doc.parse().map_err(|_| CursorError::Invalid)?;
    if issued < 1 || doc < 1 {
        return Err(CursorError::Invalid);
    }
    if issued != epoch {
        return Err(CursorError::Expired);
    }
    Ok(doc)
}

/// A listing cursor: the last conversation's update time and ID.
pub fn list_cursor(updated_at: i64, id: &str) -> String {
    format!("{updated_at}.{id}")
}

pub fn parse_list_cursor(cursor: &str) -> Result<(i64, String), CursorError> {
    let (updated_at, id) = cursor.split_once('.').ok_or(CursorError::Invalid)?;
    let updated_at: i64 = updated_at.parse().map_err(|_| CursorError::Invalid)?;
    if id.is_empty() || id.len() > 512 {
        return Err(CursorError::Invalid);
    }
    Ok((updated_at, id.to_owned()))
}

/// The searchable text of a message's review feedback: each note and its path.
pub fn feedback_text(feedback: Option<&Value>) -> String {
    let Some(notes) = feedback.and_then(|value| value["notes"].as_array()) else {
        return String::new();
    };
    notes
        .iter()
        .flat_map(|note| [note["anchor"]["path"].as_str(), note["note"].as_str()])
        .flatten()
        .collect::<Vec<_>>()
        .join("\n")
}

/// Characters of context on each side of the first matching term.
const CONTEXT: usize = 60;

/// A short excerpt of `text` around the first term it contains, ignoring case.
/// None when no term occurs.
pub fn excerpt(text: &str, terms: &[Term]) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let lower: Vec<char> = chars.iter().flat_map(|c| c.to_lowercase()).collect();
    // Lowercasing can change a character count; fall back to the start then.
    let aligned = lower.len() == chars.len();
    let position = terms
        .iter()
        .filter_map(|term| {
            let needle: Vec<char> = term.text.to_lowercase().chars().collect();
            lower
                .windows(needle.len().max(1))
                .position(|window| window == needle.as_slice())
        })
        .min()?;
    let position = if aligned { position } else { 0 };
    let start = position.saturating_sub(CONTEXT);
    let end = (position + CONTEXT * 2).min(chars.len());
    let body: String = chars[start..end]
        .iter()
        .map(|c| if c.is_whitespace() { ' ' } else { *c })
        .collect();
    Some(format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        body.trim(),
        if end < chars.len() { "…" } else { "" }
    ))
}

/// The opening of `text`, for a match whose terms are not literally present
/// (for example, one matched through diacritic folding).
pub fn opening(text: &str) -> String {
    let body: String = text
        .chars()
        .take(CONTEXT * 2 + 1)
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .collect();
    let more = text.chars().nth(CONTEXT * 2 + 1).is_some();
    format!("{}{}", body.trim(), if more { "…" } else { "" })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state(version: i64, applied: i64, rebuilding: bool) -> IndexState {
        IndexState {
            version,
            epoch: 1,
            applied,
            rebuilding,
            backfill_after: None,
        }
    }

    #[test]
    fn plan_resets_an_index_it_cannot_trust() {
        assert_eq!(plan(&state(0, 0, true), 0), Step::Reset);
        assert_eq!(plan(&state(INDEX_VERSION + 1, 0, false), 4), Step::Reset);
        // The journal is behind the recorded progress: never trust either.
        assert_eq!(plan(&state(INDEX_VERSION, 9, false), 3), Step::Reset);
        let mut unborn = state(INDEX_VERSION, 0, false);
        unborn.epoch = 0;
        assert_eq!(plan(&unborn, 0), Step::Reset);
    }

    #[test]
    fn plan_finishes_a_rebuild_before_applying_the_journal() {
        let mut rebuilding = state(INDEX_VERSION, 5, true);
        rebuilding.backfill_after = Some("m-9".into());
        assert_eq!(
            plan(&rebuilding, 12),
            Step::Backfill {
                after: Some("m-9".into())
            }
        );
        assert_eq!(
            plan(&state(INDEX_VERSION, 5, false), 12),
            Step::Apply { after: 5 }
        );
        assert_eq!(plan(&state(INDEX_VERSION, 12, false), 12), Step::Idle);
    }

    #[test]
    fn lag_reports_pending_changes_and_never_claims_a_rebuild_is_current() {
        assert_eq!(lag(&state(INDEX_VERSION, 5, false), 12), (7, false));
        assert_eq!(lag(&state(INDEX_VERSION, 12, false), 12), (0, true));
        assert_eq!(lag(&state(INDEX_VERSION, 12, true), 12), (0, false));
        assert_eq!(lag(&state(0, 0, false), 0), (0, false));
        assert_eq!(lag(&state(INDEX_VERSION, 9, false), 3), (0, false));
    }

    #[test]
    fn collapse_reindexes_each_message_once_from_its_first_change() {
        let entries = vec![
            (4, "a".to_owned(), 40),
            (5, "b".to_owned(), 50),
            (7, "a".to_owned(), 70),
            (6, "a".to_owned(), 30),
        ];
        assert_eq!(
            collapse(&entries),
            (vec![("a".into(), 30), ("b".into(), 50)], Some(7))
        );
        assert_eq!(collapse(&[]), (vec![], None));
    }

    #[test]
    fn user_syntax_is_quoted_and_cannot_become_an_operator() {
        let parsed = terms(r#"flaky OR "test" NOT body:x (a* ) - build*"#).unwrap();
        assert_eq!(
            fts_query(&parsed),
            r#""flaky" "OR" """test""" "NOT" "body:x" "(a"* "build"*"#
        );
        assert_eq!(terms("  * - ( ) \"\" "), Err(QueryError::Empty));
        assert_eq!(terms(""), Err(QueryError::Empty));
        assert_eq!(terms(&"a".repeat(257)), Err(QueryError::TooLong));
        assert_eq!(
            terms(&"a ".repeat(17)).unwrap_err(),
            QueryError::TooManyTerms
        );
        assert_eq!(fts_query(&terms("naïve\u{7}x").unwrap()), "\"naïvex\"");
    }

    #[test]
    fn search_cursors_expire_with_their_epoch() {
        let cursor = search_cursor(3, 41);
        assert_eq!(parse_search_cursor(&cursor, 3), Ok(41));
        assert_eq!(parse_search_cursor(&cursor, 4), Err(CursorError::Expired));
        for bad in ["", "3", "3.", ".4", "x.4", "3.-1", "0.4", "3.0", "3.4.5"] {
            assert_eq!(
                parse_search_cursor(bad, 3),
                Err(CursorError::Invalid),
                "{bad}"
            );
        }
    }

    #[test]
    fn list_cursors_keep_identifiers_that_contain_dots() {
        let cursor = list_cursor(1_700, "conv.1");
        assert_eq!(parse_list_cursor(&cursor), Ok((1_700, "conv.1".into())));
        assert_eq!(parse_list_cursor("12."), Err(CursorError::Invalid));
        assert_eq!(parse_list_cursor("x.c"), Err(CursorError::Invalid));
    }

    #[test]
    fn feedback_text_carries_notes_and_their_paths() {
        let feedback = json!({"notes": [
            {"anchor": {"path": "src/main.rs"}, "note": "Handle the error"},
            {"anchor": {}, "note": "Rename"},
        ]});
        assert_eq!(
            feedback_text(Some(&feedback)),
            "src/main.rs\nHandle the error\nRename"
        );
        assert_eq!(feedback_text(None), "");
        assert_eq!(feedback_text(Some(&json!({"notes": "x"}))), "");
    }

    #[test]
    fn excerpt_centres_on_the_first_term_and_marks_elisions() {
        let text = format!("{}needle in\nthe {}", "a".repeat(100), "b".repeat(200));
        let found = excerpt(&text, &terms("NEEDLE").unwrap()).unwrap();
        assert!(found.starts_with('…') && found.ends_with('…'));
        assert!(found.contains("needle in the"));
        assert_eq!(
            excerpt("short text", &terms("text").unwrap()).as_deref(),
            Some("short text")
        );
        assert_eq!(excerpt("short text", &terms("absent").unwrap()), None);
        assert_eq!(opening("héllo world"), "héllo world");
        assert_eq!(opening(""), "");
    }
}
