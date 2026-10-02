//! Provider-neutral schemas and fences for native request answers.
use anyhow::{Result, bail, ensure};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequestScope {
    Once,
    Turn,
    Session,
    Persistent,
}

/// A native choice. `value` is the provider's ID or decision, not an ADE ID.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RequestChoice {
    pub value: Value,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<RequestScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<String>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct QuestionOption {
    pub value: Value,
    pub label: String,
    pub description: String,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RequestQuestion {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    pub prompt: String,
    pub secret: bool,
    pub allow_other: bool,
    pub multiple: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<QuestionOption>>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RequestSchema {
    Choices {
        choices: Vec<RequestChoice>,
    },
    Questions {
        questions: Vec<RequestQuestion>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decline: Option<RequestChoice>,
    },
    Permissions {
        requested: Value,
        scopes: Vec<RequestScope>,
        supports_strict_auto_review: bool,
    },
    Unsupported {
        reason: String,
    },
}

/// Immutable, versioned display schema supplied by the provider adapter.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RequestMetadata {
    pub schema_version: u32,
    pub summary: String,
    pub schema: RequestSchema,
    /// Preserve absence when the provider does not state whether this blocks.
    pub blocking: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_revision: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_turn_id: Option<String>,
    pub native_request_id: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_callback_id: Option<Value>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RequestAnswer {
    Choice {
        value: Value,
    },
    Questions {
        answers: BTreeMap<String, Vec<Value>>,
    },
    Permissions {
        permissions: Value,
        scope: RequestScope,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        strict_auto_review: Option<bool>,
    },
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResponseDelivery {
    #[default]
    NotSent,
    Admitted,
    Dispatched,
    Acknowledged,
    Unknown,
    Rejected,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequestResolution {
    #[default]
    Outstanding,
    Resolved,
    Withdrawn,
    Expired,
    Unsupported,
    Invalidated,
}

/// Client-facing state; raw provider params and answers remain private.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PendingRequest {
    pub id: String,
    pub conversation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_attempt_id: Option<String>,
    /// ADE-owned revision, separate from source-attempt and native revisions.
    pub revision: u64,
    pub metadata: RequestMetadata,
    pub resolution: RequestResolution,
    pub response_delivery: ResponseDelivery,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_operation_id: Option<String>,
}

/// An answer is fenced by the caller's durable operation and exact request revision.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct AgentAnswerRequest {
    pub operation_id: String,
    pub conversation_id: String,
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_attempt_id: Option<String>,
    pub request_revision: u64,
    pub answer: RequestAnswer,
}

impl PendingRequest {
    /// Validate every fence and the full provider-declared answer schema before admission.
    pub fn validate_answer(&self, request: &AgentAnswerRequest) -> Result<()> {
        ensure!(
            !request.operation_id.is_empty() && request.operation_id.len() <= 256,
            "Invalid operation ID"
        );
        ensure!(
            request.conversation_id == self.conversation_id,
            "Answer targets a different conversation"
        );
        ensure!(
            request.request_id == self.id,
            "Answer targets a different request"
        );
        ensure!(
            request.source_attempt_id == self.source_attempt_id,
            "Request belongs to a different source attempt"
        );
        ensure!(
            request.request_revision == self.revision,
            "Request changed; refresh before answering"
        );
        ensure!(
            self.resolution == RequestResolution::Outstanding,
            "Request is no longer outstanding"
        );
        ensure!(
            self.response_delivery == ResponseDelivery::NotSent,
            "Request answer is already being delivered or has an uncertain outcome"
        );
        self.metadata.validate_answer(&request.answer)
    }
}

impl RequestMetadata {
    /// Refuse a provider-declared native request deadline that has elapsed.
    pub fn validate_not_expired(&self) -> Result<()> {
        if let Some(expires_at_ms) = self.expires_at_ms {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis() as i128;
            ensure!(now_ms < expires_at_ms as i128, "Native request has expired");
        }
        Ok(())
    }

    pub fn validate_answer(&self, answer: &RequestAnswer) -> Result<()> {
        self.validate_not_expired()?;
        ensure!(
            self.schema_version == 1,
            "Unsupported request schema version"
        );
        ensure!(!self.summary.trim().is_empty(), "Request summary is empty");
        match (&self.schema, answer) {
            (RequestSchema::Choices { choices }, RequestAnswer::Choice { value }) => {
                ensure!(!choices.is_empty(), "Request declares no native choices");
                ensure!(
                    choices.iter().any(|choice| choice.value == *value),
                    "Choice is not offered by this request"
                );
            }
            (RequestSchema::Questions { decline, .. }, RequestAnswer::Choice { value }) => {
                ensure!(
                    decline
                        .as_ref()
                        .is_some_and(|choice| choice.value == *value),
                    "This request does not offer a decline choice"
                );
            }
            (RequestSchema::Questions { questions, .. }, RequestAnswer::Questions { answers }) => {
                ensure!(
                    !questions.is_empty(),
                    "This request declares no answerable questions"
                );
                ensure!(
                    answers.len() == questions.len(),
                    "Answer every declared question, without extra fields"
                );
                let mut total_bytes = 0usize;
                for (index, question) in questions.iter().enumerate() {
                    ensure!(
                        !question.id.is_empty()
                            && !questions[..index]
                                .iter()
                                .any(|prior| prior.id == question.id),
                        "Request schema has duplicate or empty question IDs"
                    );
                    let values = answers
                        .get(&question.id)
                        .ok_or_else(|| anyhow::anyhow!("Answer required for {}", question.id))?;
                    ensure!(
                        !values.is_empty() && (question.multiple || values.len() == 1),
                        "Invalid answer count for {}",
                        question.id
                    );
                    ensure!(values.len() <= 32, "Too many answers for {}", question.id);
                    for (value_index, value) in values.iter().enumerate() {
                        let offered = question.options.as_ref().is_some_and(|options| {
                            options.iter().any(|option| option.value == *value)
                        });
                        let text = value.as_str();
                        ensure!(
                            offered
                                || (text.is_some_and(|text| !text.trim().is_empty())
                                    && (question.options.is_none() || question.allow_other)),
                            "Answer is not offered for {}",
                            question.id
                        );
                        total_bytes = total_bytes
                            .saturating_add(text.map_or_else(|| value.to_string().len(), str::len));
                        ensure!(
                            total_bytes <= 16 * 1024,
                            "Answers exceed the request size limit"
                        );
                        ensure!(
                            !values[..value_index].contains(value),
                            "Repeated answer for {}",
                            question.id
                        );
                    }
                }
            }
            (
                RequestSchema::Permissions {
                    requested,
                    scopes,
                    supports_strict_auto_review,
                },
                RequestAnswer::Permissions {
                    permissions,
                    scope,
                    strict_auto_review: answer_review,
                },
            ) => {
                ensure!(scopes.contains(scope), "Permission scope is not offered");
                ensure!(
                    is_permission_subset(permissions, requested),
                    "Granted permissions exceed the requested profile"
                );
                ensure!(
                    *supports_strict_auto_review || answer_review.is_none(),
                    "strictAutoReview is not supported by this native request"
                );
            }
            (RequestSchema::Unsupported { reason }, _) => {
                bail!("Unsupported native request: {reason}")
            }
            _ => bail!("Answer does not match the declared request schema"),
        }
        Ok(())
    }
}

fn is_permission_subset(granted: &Value, requested: &Value) -> bool {
    if granted == requested {
        return true;
    }
    match (granted, requested) {
        (Value::Object(granted), Value::Object(requested)) => granted.iter().all(|(key, value)| {
            requested
                .get(key)
                .is_some_and(|requested| is_permission_subset(value, requested))
        }),
        (Value::Array(granted), Value::Array(requested)) => {
            granted.iter().all(|value| requested.contains(value))
        }
        (Value::Bool(false), Value::Bool(true)) => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn metadata(schema: RequestSchema) -> RequestMetadata {
        RequestMetadata {
            schema_version: 1,
            summary: "Native request".into(),
            schema,
            blocking: None,
            created_at_ms: None,
            expires_at_ms: None,
            native_revision: None,
            native_session_id: None,
            native_turn_id: None,
            native_request_id: json!(9),
            native_item_id: None,
            native_callback_id: None,
        }
    }

    #[test]
    fn choice_values_keep_session_and_persistent_grants_distinct() {
        let request = metadata(RequestSchema::Choices {
            choices: vec![
                RequestChoice {
                    value: json!("accept"),
                    label: "Allow once".into(),
                    scope: Some(RequestScope::Once),
                    duration: None,
                },
                RequestChoice {
                    value: json!("acceptForSession"),
                    label: "Allow for session".into(),
                    scope: Some(RequestScope::Session),
                    duration: None,
                },
                RequestChoice {
                    value: json!({"acceptWithExecpolicyAmendment":{"rules":[]}}),
                    label: "Allow persistently".into(),
                    scope: Some(RequestScope::Persistent),
                    duration: Some("provider-defined".into()),
                },
            ],
        });
        request
            .validate_answer(&RequestAnswer::Choice {
                value: json!("acceptForSession"),
            })
            .unwrap();
        assert!(
            request
                .validate_answer(&RequestAnswer::Choice {
                    value: json!("accept")
                })
                .is_ok()
        );
        assert!(
            request
                .validate_answer(&RequestAnswer::Choice {
                    value: json!("acceptForSessionButDifferent")
                })
                .is_err()
        );
    }

    #[test]
    fn question_answers_use_native_option_ids_and_declared_cardinality() {
        let request = metadata(RequestSchema::Questions {
            questions: vec![RequestQuestion {
                id: "mode".into(),
                header: Some("Mode".into()),
                prompt: "Choose".into(),
                secret: true,
                allow_other: false,
                multiple: false,
                options: Some(vec![QuestionOption {
                    value: json!("safe-id"),
                    label: "Safe".into(),
                    description: "No writes".into(),
                }]),
            }],
            decline: None,
        });
        request
            .validate_answer(&RequestAnswer::Questions {
                answers: BTreeMap::from([("mode".into(), vec![json!("safe-id")])]),
            })
            .unwrap();
        assert!(
            request
                .validate_answer(&RequestAnswer::Questions {
                    answers: BTreeMap::from([("mode".into(), vec![json!("Safe")])])
                })
                .is_err()
        );
        assert!(
            request
                .validate_answer(&RequestAnswer::Questions {
                    answers: BTreeMap::from([(
                        "mode".into(),
                        vec![json!("safe-id"), json!("safe-id")]
                    )])
                })
                .is_err()
        );
    }

    #[test]
    fn answer_admission_requires_exact_attempt_revision_and_outstanding_delivery() {
        let pending = PendingRequest {
            id: "request_1".into(),
            conversation_id: "conversation_1".into(),
            source_attempt_id: Some("attempt_1".into()),
            revision: 7,
            metadata: metadata(RequestSchema::Choices {
                choices: vec![RequestChoice {
                    value: json!("allow"),
                    label: "Allow once".into(),
                    scope: Some(RequestScope::Once),
                    duration: None,
                }],
            }),
            resolution: RequestResolution::Outstanding,
            response_delivery: ResponseDelivery::NotSent,
            response_operation_id: None,
        };
        let request = AgentAnswerRequest {
            operation_id: "answer_1".into(),
            conversation_id: "conversation_1".into(),
            request_id: "request_1".into(),
            source_attempt_id: Some("attempt_1".into()),
            request_revision: 7,
            answer: RequestAnswer::Choice {
                value: json!("allow"),
            },
        };
        pending.validate_answer(&request).unwrap();
        let mut stale = request.clone();
        stale.source_attempt_id = Some("attempt_2".into());
        assert!(pending.validate_answer(&stale).is_err());
        let mut stale_revision = request.clone();
        stale_revision.request_revision += 1;
        assert!(pending.validate_answer(&stale_revision).is_err());
        let mut delivered = pending.clone();
        delivered.response_delivery = ResponseDelivery::Unknown;
        assert!(delivered.validate_answer(&request).is_err());
        let mut resolved = pending;
        resolved.resolution = RequestResolution::Withdrawn;
        assert!(resolved.validate_answer(&request).is_err());
    }

    #[test]
    fn permission_answers_preserve_subset_scope_and_strict_review_semantics() {
        let requested = json!({"network":{"allow":["a.test","b.test"]},"filesystem":{"read":true}});
        let schema = metadata(RequestSchema::Permissions {
            requested: requested.clone(),
            scopes: vec![RequestScope::Turn, RequestScope::Session],
            supports_strict_auto_review: true,
        });
        schema
            .validate_answer(&RequestAnswer::Permissions {
                permissions: json!({"network":{"allow":["a.test"]},"filesystem":{"read":false}}),
                scope: RequestScope::Session,
                strict_auto_review: Some(true),
            })
            .unwrap();
        schema
            .validate_answer(&RequestAnswer::Permissions {
                permissions: json!({}),
                scope: RequestScope::Turn,
                strict_auto_review: None,
            })
            .unwrap();
        assert!(
            schema
                .validate_answer(&RequestAnswer::Permissions {
                    permissions: json!({"network":{"allow":["outside.test"]}}),
                    scope: RequestScope::Turn,
                    strict_auto_review: Some(false)
                })
                .is_err()
        );
        assert!(
            schema
                .validate_answer(&RequestAnswer::Permissions {
                    permissions: requested,
                    scope: RequestScope::Persistent,
                    strict_auto_review: None
                })
                .is_err()
        );
        let unsupported = metadata(RequestSchema::Permissions {
            requested: json!({}),
            scopes: vec![RequestScope::Turn],
            supports_strict_auto_review: false,
        });
        assert!(
            unsupported
                .validate_answer(&RequestAnswer::Permissions {
                    permissions: json!({}),
                    scope: RequestScope::Turn,
                    strict_auto_review: Some(true)
                })
                .is_err()
        );
    }
    #[test]
    fn an_expired_native_deadline_refuses_answer_admission() {
        let mut metadata = metadata(RequestSchema::Choices {
            choices: vec![RequestChoice {
                value: json!("allow"),
                label: "Allow once".into(),
                scope: Some(RequestScope::Once),
                duration: None,
            }],
        });
        metadata.expires_at_ms = Some(1);
        let pending = PendingRequest {
            id: "request_1".into(),
            conversation_id: "conversation_1".into(),
            source_attempt_id: Some("attempt_1".into()),
            revision: 7,
            metadata,
            resolution: RequestResolution::Outstanding,
            response_delivery: ResponseDelivery::NotSent,
            response_operation_id: None,
        };
        let answer = AgentAnswerRequest {
            operation_id: "answer_1".into(),
            conversation_id: "conversation_1".into(),
            request_id: "request_1".into(),
            source_attempt_id: Some("attempt_1".into()),
            request_revision: 7,
            answer: RequestAnswer::Choice {
                value: json!("allow"),
            },
        };
        assert!(pending.validate_answer(&answer).is_err());
    }
}
