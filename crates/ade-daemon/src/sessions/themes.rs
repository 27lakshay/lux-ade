use super::*;
use ade_core::contract::themes::*;
mod ghostty;
mod warp;

impl Sessions {
    /// Mirrors only themes from live plugin activations into the profile library.
    pub(super) fn sync_plugin_themes(&self) -> Result<()> {
        let themes = match &self.plugins {
            Ok(plugins) => plugins.themes()?,
            Err(_) => Vec::new(),
        };
        let mut data = self.data.lock().unwrap();
        let (library_revision, changed_ids, appearance_changed) =
            data.store.sync_plugin_themes(&themes)?;
        if changed_ids.is_empty() && !data.appearance_pending {
            return Ok(());
        }
        if !changed_ids.is_empty() {
            self.publish(
                &mut data,
                serde_json::to_value(ThemeLibraryChanged {
                    tag: Default::default(),
                    revision: 0,
                    boot_id: self.boot_id.clone(),
                    library_revision,
                    changed_ids,
                })?,
            );
        }
        if appearance_changed {
            let settings = data.store.settings()?;
            self.publish(
                &mut data,
                json!({"type":"settings_changed", "settings": settings}),
            );
        }
        if appearance_changed || data.appearance_pending {
            let projection = data.store.terminal_appearance_projection()?;
            let command = ade_core::contract::terminals::runtime::Command::Appearance {
                appearance: projection,
            };
            match self.runtime.command(command) {
                Ok(_) => data.appearance_pending = false,
                Err(error) => {
                    data.appearance_pending = true;
                    return Err(error).context(
                        "Plugin theme lifecycle changed, but the terminal update could not be confirmed",
                    );
                }
            }
        }
        Ok(())
    }

    pub(super) fn themes_command(&self, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "themes.ghostty.export" => reply(
                &self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .export_ghostty_theme(&decode(request)?)?,
            ),
            "themes.ghostty.validate" => {
                let mut result = ghostty::validate(&decode(request)?);
                result.validation.target = result
                    .validation
                    .validation
                    .definition
                    .as_ref()
                    .map(|definition| {
                        self.data
                            .lock()
                            .unwrap()
                            .store
                            .theme_optional(&definition.id)
                    })
                    .transpose()?
                    .flatten()
                    .map(|theme| theme.summary());
                reply(&result)
            }
            "themes.warp.validate" => {
                let mut result = warp::validate(&decode(request)?);
                result.validation.target = result
                    .validation
                    .validation
                    .definition
                    .as_ref()
                    .map(|definition| {
                        self.data
                            .lock()
                            .unwrap()
                            .store
                            .theme_optional(&definition.id)
                    })
                    .transpose()?
                    .flatten()
                    .map(|theme| theme.summary());
                reply(&result)
            }
            "themes.file.validate" => {
                let ThemeFileValidateRequest { source } = decode(request)?;
                let validation = ade_core::appearance::definition::validate_source(&source);
                let data = self.data.lock().unwrap();
                let candidates = validation
                    .candidates
                    .into_iter()
                    .map(|candidate| {
                        let target = candidate
                            .validation
                            .definition
                            .as_ref()
                            .map(|definition| data.store.theme_optional(&definition.id))
                            .transpose()?
                            .flatten()
                            .map(|theme| theme.summary());
                        Ok(ThemeFileCandidate {
                            source: candidate.source,
                            validation: ThemeValidationResponse {
                                tag: Default::default(),
                                validation: candidate.validation,
                                target,
                            },
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                reply(&ThemeFileValidation {
                    tag: Default::default(),
                    pack: validation.pack,
                    container_valid: validation.container_valid,
                    diagnostics: validation.diagnostics,
                    candidates,
                })
            }
            "themes.pack.export" => reply(
                &self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .export_theme_pack(&decode(request)?)?,
            ),
            "themes.removal" => reply(
                &self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .theme_removal_plan(&decode(request)?)?,
            ),
            "themes.remove" => {
                let mut data = self.data.lock().unwrap();
                let before = data.store.settings()?.appearance_revision;
                let removed = data.store.remove_theme(&decode(request)?)?;
                let result = removed.removal;
                if result.changed {
                    self.publish(
                        &mut data,
                        serde_json::to_value(ThemeLibraryChanged {
                            tag: Default::default(),
                            revision: 0,
                            boot_id: self.boot_id.clone(),
                            library_revision: result.revision,
                            changed_ids: vec![result.id.clone()],
                        })?,
                    );
                }
                if removed.terminal_bindings_changed {
                    self.catalog_changed(&mut data)?;
                }
                if result.appearance_revision != before {
                    let settings = data.store.settings()?;
                    self.publish(
                        &mut data,
                        json!({"type":"settings_changed", "settings": settings}),
                    );
                    self.runtime
                        .command(
                            ade_core::contract::terminals::runtime::Command::Appearance {
                                appearance: data.store.terminal_appearance_projection()?,
                            },
                        )
                        .context("Theme removed, but the terminal update could not be confirmed")?;
                }
                reply(&result)
            }
            "themes.preview" => reply(
                &self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .preview_themes(&decode(request)?)?,
            ),
            "themes.draft.preview" => reply(
                &self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .preview_theme_draft(&decode(request)?)?,
            ),
            "themes.validate" => {
                let ThemeValidateRequest { source } = decode(request)?;
                let validation = ade_core::appearance::definition::validate(&source);
                let target = validation
                    .definition
                    .as_ref()
                    .map(|definition| {
                        self.data
                            .lock()
                            .unwrap()
                            .store
                            .theme_optional(&definition.id)
                    })
                    .transpose()?
                    .flatten()
                    .map(|theme| theme.summary());
                reply(&ThemeValidationResponse {
                    tag: Default::default(),
                    validation,
                    target,
                })
            }
            "themes.list" => reply(
                &self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .theme_library(&decode(request)?)?,
            ),
            "themes.inspect" => {
                let ThemeInspectRequest { id } = decode(request)?;
                reply(&ThemeInspectResponse {
                    tag: Default::default(),
                    theme: self.data.lock().unwrap().store.theme(&id)?,
                })
            }
            "themes.export" => reply(
                &self
                    .data
                    .lock()
                    .unwrap()
                    .store
                    .export_theme(&decode(request)?)?,
            ),
            "themes.install" | "themes.rename" => {
                let mut data = self.data.lock().unwrap();
                let before = data.store.settings()?.appearance_revision;
                let result = if request["op"] == "themes.rename" {
                    data.store.rename_theme(&decode(request)?)?
                } else {
                    data.store.install_themes(&decode(request)?)?
                };
                if result.changed {
                    let frame = ThemeLibraryChanged {
                        tag: Default::default(),
                        revision: 0,
                        boot_id: self.boot_id.clone(),
                        library_revision: result.revision,
                        changed_ids: result
                            .items
                            .iter()
                            .filter_map(|item| item.theme.as_ref())
                            .filter(|theme| theme.revision == result.revision)
                            .map(|theme| theme.id.clone())
                            .collect(),
                    };
                    self.publish(&mut data, serde_json::to_value(frame)?);
                }
                let settings = data.store.settings()?;
                if settings.appearance_revision != before {
                    self.publish(
                        &mut data,
                        json!({ "type": "settings_changed", "settings": settings }),
                    );
                    self.runtime
                        .command(
                            ade_core::contract::terminals::runtime::Command::Appearance {
                                appearance: data.store.terminal_appearance_projection()?,
                            },
                        )
                        .context("Theme saved, but the terminal update could not be confirmed")?;
                }
                reply(&result)
            }
            _ => bail!("Unknown theme operation"),
        }
    }
}
