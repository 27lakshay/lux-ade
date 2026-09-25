//! Provider approvals and question forms. Input entities and subscriptions remain
//! owned by Workspace and are released when their request disappears.
use crate::*;

impl Workspace {
    pub(super) fn render_requests(
        &mut self,
        requests: &[model::PendingRequest],
        connected: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut approval = v_flex().flex_shrink_0().id("approvals").gap_2();
        let active_keys: Vec<_> = requests
            .iter()
            .flat_map(|r| {
                r.params["questions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|q| q["id"].as_str())
                    .map(move |id| format!("{}:{id}", r.id))
                    .collect::<Vec<_>>()
            })
            .collect();
        self.answers.retain(|key, _| active_keys.contains(key));
        self.answer_choices
            .retain(|key, _| active_keys.contains(key));
        self.answer_changes
            .retain(|key, _| active_keys.contains(key));
        for r in requests {
            let id = r.id.clone();
            let conversation_id = r.conversation_id.clone();
            let mut card = v_flex()
                .flex_shrink_0()
                .p_3()
                .bg(rgb(ui::SURFACE))
                .gap_2()
                .border_1()
                .border_color(rgb(ui::BORDER))
                .rounded_md()
                .child(match r.method.as_str() {
                    "item/commandExecution/requestApproval" => "Allow this command?",
                    "item/fileChange/requestApproval" => "Allow these file changes?",
                    "item/permissions/requestApproval" => "Grant these permissions for this turn?",
                    "claude/toolApproval" => "Allow this tool?",
                    "opencode/toolApproval" | "omp/toolApproval" => "Allow this tool?",
                    "omp/recover" => "Review interrupted Oh My Pi work",
                    "opencode/recover" => "Resume pending OpenCode work?",
                    method if ui::is_question_method(method) => "The Agent has a question",
                    _ => "Unsupported Agent request",
                });
            let question_method = ui::is_question_method(&r.method);
            let supported = if question_method {
                r.params["questions"].as_array().is_some_and(|questions| {
                    !questions.is_empty() && questions.iter().all(|q| q["id"].is_string())
                })
            } else {
                ui::approval_decisions(&r.method).is_some()
            };
            if !supported {
                card = card.child(div().text_color(rgb(ui::DANGER)).child("lux-ade cannot answer this request safely. Cancel the turn or update the provider integration."))
                    .child(div().id(SharedString::from(format!("unsupported-{id}"))).max_h(px(90.)).overflow_y_scroll()
                        .text_size(px(ui::tokens::LABEL_PX)).child(format!("{}\n{}", r.method, serde_json::to_string_pretty(&r.params).unwrap_or_default())));
                approval = approval.child(card);
                continue;
            }
            if question_method {
                let count = r.params["questions"].as_array().map_or(0, Vec::len);
                if count > 1 {
                    card = card.child(
                        div()
                            .text_size(px(ui::tokens::CAPTION_PX))
                            .text_color(rgb(ui::MUTED))
                            .child(format!("Answer all {count} questions.")),
                    );
                }
                let mut fields = v_flex()
                    .id(SharedString::from(format!("questions-{id}")))
                    .flex_shrink_0()
                    .gap_1();
                if let Some(questions) = r.params["questions"].as_array() {
                    for q in questions {
                        let Some(qid) = q["id"].as_str() else {
                            continue;
                        };
                        let key = format!("{id}:{qid}");
                        let input = self
                            .answers
                            .entry(key.clone())
                            .or_insert_with(|| {
                                cx.new(|cx| {
                                    InputState::new(window, cx)
                                        .placeholder(
                                            q["question"].as_str().unwrap_or(qid).to_owned(),
                                        )
                                        .masked(q["isSecret"].as_bool().unwrap_or(false))
                                })
                            })
                            .clone();
                        fields = fields.child(q["question"].as_str().unwrap_or(qid).to_owned());
                        if !self.answer_changes.contains_key(&key) {
                            let subscription =
                                cx.subscribe(&input, |_, _, event: &InputEvent, cx| {
                                    if matches!(event, InputEvent::Change) {
                                        cx.notify();
                                    }
                                });
                            self.answer_changes.insert(key.clone(), subscription);
                        }
                        let multiple = q["multiSelect"].as_bool().unwrap_or(false);
                        if multiple {
                            fields = fields.child(
                                div()
                                    .text_size(px(ui::tokens::CAPTION_PX))
                                    .text_color(rgb(ui::MUTED))
                                    .child("Choose one or more, or enter your own answer."),
                            );
                        }
                        if let Some(options) = q["options"].as_array() {
                            for (index, option) in options.iter().enumerate() {
                                let Some(label) = option["label"].as_str() else {
                                    continue;
                                };
                                let label = label.to_owned();
                                let input_target = input.clone();
                                let choice_key = key.clone();
                                let current = input.read(cx).value().to_string();
                                let selected = if multiple {
                                    self.answer_choices.get(&key).is_some_and(|choices| {
                                        choices.join(", ") == current && choices.contains(&label)
                                    })
                                } else {
                                    current == label
                                };
                                let mut choice = v_flex().gap_1().child(
                                    ui::button(SharedString::from(format!("option-{key}-{index}")))
                                        .outline()
                                        .w_full()
                                        .justify_start()
                                        .toggled(selected)
                                        .icon(if selected {
                                            Glyph::Check
                                        } else {
                                            Glyph::Circle
                                        })
                                        .label(label.clone())
                                        .child(div().flex_1())
                                        .disabled(
                                            self.pending || !connected || r.status != "pending",
                                        )
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            let current = input_target.read(cx).value().to_string();
                                            let value = ui::select_answer(
                                                this.answer_choices
                                                    .entry(choice_key.clone())
                                                    .or_default(),
                                                &current,
                                                &label,
                                                multiple,
                                            );
                                            input_target.update(cx, |input, cx| {
                                                input.set_value(value, window, cx)
                                            });
                                            cx.notify();
                                        })),
                                );
                                if let Some(description) = option["description"]
                                    .as_str()
                                    .filter(|text| !text.is_empty())
                                {
                                    choice = choice.child(
                                        div()
                                            .text_size(px(ui::tokens::CAPTION_PX))
                                            .text_color(rgb(ui::MUTED))
                                            .child(description.to_owned()),
                                    );
                                }
                                fields = fields.child(choice);
                            }
                        }
                        fields = fields.child(
                            Input::new(&input)
                                .disabled(self.pending || r.status != "pending")
                                .aria_label(q["question"].as_str().unwrap_or(qid).to_owned()),
                        );
                    }
                }
                card = card.child(fields);
                let questions = r.params["questions"].clone();
                let all_answered = questions.as_array().is_some_and(|qs| {
                    qs.iter().all(|q| {
                        q["id"].as_str().is_some_and(|qid| {
                            self.answers
                                .get(&format!("{id}:{qid}"))
                                .is_some_and(|input| !input.read(cx).value().trim().is_empty())
                        })
                    })
                });
                let rid = id.clone();
                let list_answers = r.method == "item/tool/requestUserInput";
                card = card.child(
                    ui::button(SharedString::from(format!("answer-{id}")))
                        .label("Submit answers")
                        .disabled(
                            self.pending || !connected || !all_answered || r.status != "pending",
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let mut answers = serde_json::Map::new();
                            if let Some(questions) = questions.as_array() {
                                for question in questions {
                                    if let Some(qid) = question["id"].as_str() {
                                        let key = format!("{rid}:{qid}");
                                        if let Some(input) = this.answers.get(&key) {
                                            answers.insert(
                                                qid.into(),
                                                answer_value(
                                                    list_answers
                                                        && question["multiSelect"]
                                                            .as_bool()
                                                            .unwrap_or(false),
                                                    input.read(cx).value().to_string(),
                                                    this.answer_choices.get(&key),
                                                ),
                                            );
                                        }
                                    }
                                }
                            }
                            this.request(
                                json!({"op":"agent.answer", "conversation_id":conversation_id,
                            "request_id":rid, "decision":"answer", "answers":answers}),
                                false,
                                false,
                                cx,
                            );
                        })),
                );
            } else {
                // Full command/diff/permission details remain inspectable before a decision.
                let details = if r.method == "item/permissions/requestApproval" {
                    format!(
                        "Permissions for this turn:\n{}",
                        serde_json::to_string_pretty(&r.params["permissions"]).unwrap_or_default()
                    )
                } else if r.method == "claude/toolApproval" {
                    format!(
                        "{}\n{}",
                        r.params["tool"].as_str().unwrap_or("Tool"),
                        serde_json::to_string_pretty(&r.params["input"]).unwrap_or_default()
                    )
                } else if matches!(
                    r.method.as_str(),
                    "opencode/toolApproval" | "omp/toolApproval"
                ) {
                    format!(
                        "{}\n{}\n{}",
                        r.params["tool"].as_str().unwrap_or("Tool"),
                        r.params["reason"].as_str().unwrap_or_default(),
                        serde_json::to_string_pretty(&r.params["resources"]).unwrap_or_default()
                    )
                } else if matches!(r.method.as_str(), "opencode/recover" | "omp/recover") {
                    format!(
                        "{}\n{}",
                        r.params["reason"].as_str().unwrap_or_default(),
                        r.params["prompt"].as_str().unwrap_or_default()
                    )
                } else {
                    [
                        r.params["reason"].as_str(),
                        r.params["cwd"].as_str(),
                        r.params["command"].as_str(),
                        r.params["grantRoot"].as_str(),
                    ]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join("\n")
                };
                card = card.child(ui::text_details(
                    format!("details-{id}"),
                    details,
                    "Copy request details",
                ));
                let mut buttons = h_flex().gap_2();
                let decisions = ui::approval_decisions(&r.method).unwrap_or_default();
                for &(decision, label) in decisions {
                    let rid = id.clone();
                    let cid = conversation_id.clone();
                    buttons=buttons.child(ui::button(SharedString::from(format!("{decision}-{id}"))).label(label).disabled(self.pending||!connected||r.status!="pending"||r.params["availableDecisions"].as_array().is_some_and(|a|!a.iter().any(|d|d.as_str()==Some(decision)))).on_click(cx.listener(move|this,_,_,cx|this.request(json!({"op":"agent.answer","conversation_id":cid,"request_id":rid,"decision":decision}),false,false,cx))));
                }
                card = card.child(buttons);
            }
            approval = approval.child(card);
        }
        approval.into_any_element()
    }
}

// Preserve selected labels as values for providers whose wire contract supports
// arrays. Manual edits remain one free-text answer; commas never imply splitting.
fn answer_value(list_answers: bool, text: String, choices: Option<&Vec<String>>) -> Value {
    if list_answers
        && let Some(choices) = choices
        && !choices.is_empty()
        && choices.join(", ") == text
    {
        return json!(choices);
    }
    json!(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::prelude::v1::test;
    #[test]
    fn selected_labels_and_free_text_have_distinct_wire_values() {
        let choices = vec!["Read, write".into(), "Review".into()];
        assert_eq!(
            answer_value(true, "Read, write, Review".into(), Some(&choices)),
            json!(choices)
        );
        assert_eq!(
            answer_value(true, "My own, answer".into(), Some(&choices)),
            json!("My own, answer")
        );
        assert_eq!(
            answer_value(false, "Read, write, Review".into(), Some(&choices)),
            json!("Read, write, Review")
        );
    }
}
