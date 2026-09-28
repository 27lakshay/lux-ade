//! The prompt `review.feedback.send` queues. It is the text the desktop built
//! before the daemon owned it: `reviewPromptText` in
//! `apps/desktop/src/main/review.ts` for one line, and `formatReviewFeedback`
//! in `@ade/client` for a batch.
use crate::contract::review::{ReviewAnchor, ReviewFeedback, ReviewFeedbackFormat, ReviewNote};

/// The feedback batch that `anchors` with one `note` stand for: the note
/// under each anchor. It is what the delivered message records.
pub fn feedback(workspace_id: &str, anchors: &[ReviewAnchor], note: &str) -> ReviewFeedback {
    ReviewFeedback {
        format: ReviewFeedbackFormat::V1,
        workspace_id: workspace_id.to_owned(),
        notes: anchors
            .iter()
            .map(|anchor| ReviewNote {
                anchor: anchor.clone(),
                note: note.to_owned(),
            })
            .collect(),
    }
}

/// The prompt for `anchors` with one `note`: one anchor on one line takes
/// the one-line form, anything else the batch form.
pub fn from_anchors(workspace_id: &str, anchors: &[ReviewAnchor], note: &str) -> String {
    match anchors {
        [anchor] if anchor.end_line.is_none() => single(anchor, note.trim()),
        _ => from_feedback(&feedback(workspace_id, anchors, note)),
    }
}

fn side(anchor: &ReviewAnchor) -> &'static str {
    if anchor.staged { "staged" } else { "unstaged" }
}

fn single(anchor: &ReviewAnchor, note: &str) -> String {
    format!(
        "Review feedback for workspace {}\nFile: {}\nSide: {}\nDiff token: {}\nStatus revision: {}\nHunk: {}\nLine: +{}\nSelected text: {}\n\nFeedback:\n{note}",
        anchor.workspace_id,
        anchor.path,
        side(anchor),
        anchor.token,
        anchor.revision,
        anchor.hunk,
        anchor.line,
        anchor.text,
    )
}

/// The batch form, as `formatReviewFeedback` in `@ade/client` writes it.
pub fn from_feedback(feedback: &ReviewFeedback) -> String {
    let notes: Vec<String> = feedback
        .notes
        .iter()
        .enumerate()
        .map(|(index, ReviewNote { anchor, note })| {
            let (label, end) = match anchor.end_line {
                Some(end) => ("Lines", format!(" to +{end}")),
                None => ("Line", String::new()),
            };
            let end_text = anchor
                .end_text
                .as_ref()
                .map(|text| format!("\nEnd text: {text}"))
                .unwrap_or_default();
            format!(
                "{}. File: {}\nSide: {}\nDiff token: {}\nStatus revision: {}\nHunk: {}\n{label}: +{}{end}\nSelected text: {}{end_text}\nFeedback: {}",
                index + 1,
                anchor.path,
                side(anchor),
                anchor.token,
                anchor.revision,
                anchor.hunk,
                anchor.line,
                anchor.text,
                note.trim(),
            )
        })
        .collect();
    format!(
        "Review feedback for workspace {}\n\n{}",
        feedback.workspace_id,
        notes.join("\n\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchor(line: u64) -> ReviewAnchor {
        ReviewAnchor {
            workspace_id: "workspace_1".into(),
            path: "src/app.rs".into(),
            staged: false,
            revision: "0123456789abcdef".into(),
            token: "fedcba9876543210".into(),
            hunk: "@@ -1,2 +1,3 @@".into(),
            line,
            text: "let x = 1;".into(),
            end_line: None,
            end_text: None,
        }
    }

    #[test]
    fn one_line_takes_the_desktop_one_line_form() {
        assert_eq!(
            from_anchors("workspace_1", &[anchor(2)], "  Rename x  \n"),
            "Review feedback for workspace workspace_1\nFile: src/app.rs\nSide: unstaged\nDiff token: fedcba9876543210\nStatus revision: 0123456789abcdef\nHunk: @@ -1,2 +1,3 @@\nLine: +2\nSelected text: let x = 1;\n\nFeedback:\nRename x"
        );
    }

    #[test]
    fn several_anchors_and_ranges_take_the_client_batch_form() {
        let mut range = anchor(3);
        range.staged = true;
        range.end_line = Some(5);
        range.end_text = Some("}".into());
        let expected = "Review feedback for workspace workspace_1\n\n1. File: src/app.rs\nSide: unstaged\nDiff token: fedcba9876543210\nStatus revision: 0123456789abcdef\nHunk: @@ -1,2 +1,3 @@\nLine: +2\nSelected text: let x = 1;\nFeedback: Check\n\n2. File: src/app.rs\nSide: staged\nDiff token: fedcba9876543210\nStatus revision: 0123456789abcdef\nHunk: @@ -1,2 +1,3 @@\nLines: +3 to +5\nSelected text: let x = 1;\nEnd text: }\nFeedback: Check";
        assert_eq!(
            from_anchors("workspace_1", &[anchor(2), range.clone()], "Check"),
            expected
        );
        // A batch with a note per anchor gives the same text for the same notes.
        let batch = ReviewFeedback {
            format: ReviewFeedbackFormat::V1,
            workspace_id: "workspace_1".into(),
            notes: vec![
                ReviewNote {
                    anchor: anchor(2),
                    note: " Check ".into(),
                },
                ReviewNote {
                    anchor: range,
                    note: "Check".into(),
                },
            ],
        };
        assert_eq!(from_feedback(&batch), expected);
    }
}
