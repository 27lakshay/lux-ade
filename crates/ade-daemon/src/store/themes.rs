//! Accepted definitions are profile data. A batch validates before one transaction commits it.
use super::*;
use ade_core::{
    appearance::{
        builtin_catalog, builtin_palette,
        definition::{ThemeOrigin, ThemeProvenance, validate},
    },
    contract::themes::*,
    error::{ThemeConflict, ThemeNotFound, ThemeProtected},
};
use std::collections::BTreeSet;

const PAGE_SIZE: usize = 16;
const BATCH_SIZE: usize = 16;
const BATCH_SOURCE_BYTES: usize = 512 * 1024;
mod ghostty;
mod removal;

fn builtin_provenance() -> ThemeProvenance {
    ThemeProvenance {
        kind: ThemeOrigin::Bundled,
        source: Some("ADE Pen palette handoff".into()),
        source_version: Some("2026-09-29".into()),
        source_digest: None,
        author: None,
        license: None,
    }
}

fn bundled_record(id: &str) -> Result<Option<ThemeRecord>> {
    let Some(palette) = builtin_palette(id) else {
        return Ok(None);
    };
    let source = serde_json::to_string_pretty(&json!({ "format":"ade-theme", "version":1,
        "id":palette.id, "name":palette.name, "mode":palette.mode, "provenance":builtin_provenance(),
        "app":{"defaults":id,"tokens":{}}, "terminal":{"defaults":id,"tokens":{}}, "syntax":{"defaults":id,"tokens":{}} }))?;
    let validation = validate(&source);
    Ok(Some(ThemeRecord {
        revision: 0,
        definition: validation
            .definition
            .context("Bundled definition is invalid")?,
        source,
        diagnostics: validation.diagnostics,
    }))
}

fn record(db: &Connection, id: &str) -> Result<Option<ThemeRecord>> {
    db.query_row(
        "SELECT data FROM theme_definitions WHERE id=?1",
        [id],
        |row| row.get::<_, String>(0),
    )
    .optional()?
    .map(decode)
    .transpose()
}

fn revision(db: &Connection) -> Result<u64> {
    let value: i64 = db.query_row(
        "SELECT revision FROM theme_library_state WHERE id=1",
        [],
        |row| row.get(0),
    )?;
    value.try_into().context("Invalid theme library revision")
}

fn writable(id: &str, kind: &ThemeOrigin) -> Result<()> {
    let namespace = id.split_once(':').map_or("", |(namespace, _)| namespace);
    if namespace == "ade"
        || namespace == "plugin"
        || namespace.starts_with("plugin.")
        || matches!(kind, ThemeOrigin::Bundled | ThemeOrigin::Plugin)
    {
        return Err(ThemeProtected(id.into()).into());
    }
    Ok(())
}

impl Store {
    /// Replaces only activation-owned plugin themes; unresolved selections stay persisted for diagnostics.
    pub fn sync_plugin_themes(
        &self,
        plugins: &[(
            String,
            String,
            String,
            Vec<ade_core::appearance::definition::ThemeDefinition>,
        )],
    ) -> Result<(u64, Vec<String>, bool)> {
        let mut desired = std::collections::BTreeMap::new();
        for (plugin_id, version, digest, themes) in plugins {
            for theme in themes {
                let mut definition = theme.clone();
                definition.provenance.source = Some(plugin_id.clone());
                definition.provenance.source_version = Some(version.clone());
                definition.provenance.source_digest = Some(digest.clone());
                let source = serde_json::to_string(&definition)?;
                let validation = validate(&source);
                ensure!(
                    validation.valid,
                    "Plugin {plugin_id} theme {} failed validation",
                    theme.id
                );
                let definition = validation
                    .definition
                    .context("Validated plugin theme is missing")?;
                ensure!(
                    definition.id.starts_with(&format!("plugin.{plugin_id}:")),
                    "Plugin {plugin_id} theme ID is outside its namespace"
                );
                ensure!(
                    matches!(definition.provenance.kind, ThemeOrigin::Plugin),
                    "Plugin {plugin_id} theme provenance is not plugin-owned"
                );
                ensure!(
                    desired
                        .insert(definition.id.clone(), (source, definition))
                        .is_none(),
                    "Plugin theme ID collision"
                );
            }
        }
        let tx = self.transaction()?;
        // The additive ledger keeps revisions across deleted plugin rows. Seed it from
        // live definitions so databases predating the ledger retain their high-water marks.
        tx.execute_batch("CREATE TABLE IF NOT EXISTS plugin_theme_revision_history (id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0))")?;
        let mut changed_ids = Vec::new();
        let mut existing = tx
            .prepare("SELECT id FROM theme_definitions WHERE id LIKE 'plugin.%:%' ORDER BY id")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in existing.drain(..) {
            let stored =
                record(&tx, &id)?.context("Plugin theme disappeared during synchronization")?;
            if !matches!(stored.definition.provenance.kind, ThemeOrigin::Plugin) {
                continue;
            }
            tx.execute("INSERT INTO plugin_theme_revision_history(id,revision) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET revision=MAX(revision,excluded.revision)", params![id, i64::try_from(stored.revision)?])?;
            if !desired.contains_key(&id) {
                tx.execute("DELETE FROM theme_definitions WHERE id=?1", [&id])?;
                changed_ids.push(id);
            }
        }
        for (id, (source, definition)) in desired {
            let current = record(&tx, &id)?;
            if current
                .as_ref()
                .is_some_and(|current| current.source == source)
            {
                continue;
            }
            ensure!(
                current.as_ref().is_none_or(|current| matches!(
                    current.definition.provenance.kind,
                    ThemeOrigin::Plugin
                )),
                "Theme ID {id} is owned by another source"
            );
            changed_ids.push(id.clone());
            let current_revision = current.as_ref().map_or(0, |theme| theme.revision);
            let stored_revision: i64 = tx
                .query_row(
                    "SELECT revision FROM plugin_theme_revision_history WHERE id=?1",
                    [&id],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or(0);
            let next_revision = u64::try_from(stored_revision)?
                .max(current_revision)
                .checked_add(1)
                .context("Plugin theme revision exhausted")?;
            let record = ThemeRecord {
                revision: next_revision,
                definition,
                source,
                diagnostics: vec![],
            };
            let summary = record.summary();
            tx.execute(
                "INSERT INTO plugin_theme_revision_history(id,revision) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",
                params![id, i64::try_from(record.revision)?],
            )?;
            tx.execute("INSERT INTO theme_definitions(id,revision,data,summary) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,summary=excluded.summary",
                params![id, i64::try_from(record.revision)?, encode(&record)?, encode(&summary)?])?;
        }
        if changed_ids.is_empty() {
            let library_revision = revision(&tx)?;
            tx.commit()?;
            return Ok((library_revision, changed_ids, false));
        }
        let library_revision = revision(&tx)?
            .checked_add(1)
            .context("Theme library revision exhausted")?;
        tx.execute(
            "UPDATE theme_library_state SET revision=?1 WHERE id=1",
            [i64::try_from(library_revision)?],
        )?;
        let selected = self.selected_theme_ids()?;
        let appearance_changed = changed_ids.iter().any(|id| selected.contains(id));
        if appearance_changed {
            let settings = self.settings()?;
            let next = settings
                .appearance_revision
                .checked_add(1)
                .context("Appearance revision exhausted")?;
            tx.execute("INSERT INTO profile_settings(key,value,updated_at) VALUES('appearance_revision',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                params![serde_json::to_string(&next)?, now_ms()])?;
        }
        tx.commit()?;
        Ok((library_revision, changed_ids, appearance_changed))
    }
    pub fn export_theme_pack(&self, request: &ThemePackExportRequest) -> Result<ThemePackExport> {
        use ade_core::appearance::pack::{
            MAX_PACK_BYTES, MAX_PACK_MEMBERS, ThemePack, ThemePackIdentity,
        };
        let identity = ThemePackIdentity {
            id: request.id.clone(),
            name: request.name.clone(),
        };
        ensure!(identity.valid(), "Invalid pack identity");
        ensure!(
            !request.items.is_empty() && request.items.len() <= MAX_PACK_MEMBERS,
            "Choose between 1 and 16 pack members"
        );
        let mut seen = BTreeSet::new();
        let mut definitions = Vec::new();
        let mut themes = Vec::new();
        for item in &request.items {
            ensure!(seen.insert(&item.id), "Pack repeats a theme ID");
            let exported = self.export_theme(&ThemeExportRequest {
                id: item.id.clone(),
                expected_revision: Some(item.expected_revision),
            })?;
            let mut definition = validate(&exported.source)
                .definition
                .context("Pack member is invalid")?;
            definition.pack = Some(identity.clone());
            for section in [
                &mut definition.app,
                &mut definition.terminal,
                &mut definition.syntax,
            ]
            .into_iter()
            .flatten()
            {
                // Validation has materialized every role from declared defaults.
                section.defaults = None;
            }
            ensure!(
                validate(&serde_json::to_string(&definition)?).valid,
                "Resolved pack member is invalid or exceeds the definition limit"
            );
            themes.push(exported.theme);
            definitions.push(definition);
        }
        let source = serde_json::to_string(&ThemePack {
            format: "ade-theme-pack".into(),
            version: 1,
            id: identity.id.clone(),
            name: identity.name.clone(),
            themes: definitions,
        })?;
        ensure!(
            source.len() <= MAX_PACK_BYTES,
            "Resolved pack exceeds 512 KiB"
        );
        Ok(ThemePackExport {
            tag: Default::default(),
            pack: identity,
            themes,
            source,
        })
    }
    pub fn preview_themes(&self, request: &ThemePreviewRequest) -> Result<ThemePreview> {
        use ade_core::appearance::{
            PaletteMode, TerminalAppearance, ThemeBinding, ThemeSectionKind,
        };
        let settings = self.settings()?;
        let mut revisions = std::collections::BTreeMap::new();
        let mut samples = Vec::new();
        for (mode, id) in [
            (PaletteMode::Light, &request.app_light_theme),
            (PaletteMode::Dark, &request.app_dark_theme),
        ] {
            let (app, app_diagnostic) =
                self.resolve_selection(id, ThemeSectionKind::App, Some(mode), mode)?;
            ensure!(
                app_diagnostic.is_none(),
                "App theme {id} is unavailable for this mode"
            );
            revisions.insert(id.clone(), self.theme(id)?.revision);
            let mut diagnostics = Vec::new();
            let mut resolve = |binding: &ThemeBinding,
                               section: ThemeSectionKind|
             -> Result<ade_core::appearance::BuiltinPalette> {
                self.validate_theme_binding(binding, section)?;
                let (id, required) = match binding {
                    ThemeBinding::FollowApp => (id, Some(mode)),
                    ThemeBinding::Fixed { theme_id } => (theme_id, None),
                    ThemeBinding::Paired { light, dark } => (
                        if mode == PaletteMode::Light {
                            light
                        } else {
                            dark
                        },
                        Some(mode),
                    ),
                };
                revisions.insert(id.clone(), self.theme(id)?.revision);
                let (palette, diagnostic) = self.resolve_selection(id, section, required, mode)?;
                diagnostics.extend(diagnostic);
                Ok(palette)
            };
            let syntax = resolve(&request.syntax_binding, ThemeSectionKind::Syntax)?;
            let terminal_palette = resolve(&request.terminal_binding, ThemeSectionKind::Terminal)?;
            let mut terminal = TerminalAppearance::for_palette(&terminal_palette);
            settings.terminal_color_overrides.apply(&mut terminal);
            terminal.minimum_contrast = settings.terminal_minimum_contrast;
            terminal.bold_color = settings.terminal_bold_color.clone();
            terminal.revision = settings.appearance_revision;
            samples.push(ThemePreviewSample {
                app,
                syntax,
                terminal,
                terminal_name: terminal_palette.name,
                diagnostics,
            });
        }
        Ok(ThemePreview {
            tag: Default::default(),
            appearance_revision: settings.appearance_revision,
            expected_theme_revisions: revisions,
            samples,
        })
    }
    pub fn preview_theme_draft(
        &self,
        request: &ThemeDraftPreviewRequest,
    ) -> Result<ThemeDraftPreview> {
        use ade_core::appearance::{PaletteMode, TerminalAppearance, ThemeSectionKind};
        let validation = validate(&request.source);
        let valid = validation.valid;
        let diagnostics = validation.diagnostics;
        let report = diagnostics
            .iter()
            .map(|diagnostic| format!("{}: {}", diagnostic.code, diagnostic.message))
            .collect::<Vec<_>>()
            .join("; ");
        let definition = validation
            .definition
            .or_else(|| serde_json::from_str(&request.source).ok())
            .context(format!("Theme draft validation failed: {report}"))?;
        let app = valid
            .then(|| definition.palette(ThemeSectionKind::App))
            .flatten();
        let terminal = valid
            .then(|| definition.palette(ThemeSectionKind::Terminal))
            .flatten()
            .as_ref()
            .map(TerminalAppearance::for_palette);
        let syntax = valid
            .then(|| definition.palette(ThemeSectionKind::Syntax))
            .flatten();
        let project = |mode| {
            let fallback = builtin_palette(if mode == PaletteMode::Light {
                "ade:chalk"
            } else {
                "ade:graphite"
            })
            .expect("core mode palette exists")
            .clone();
            let resolve = |section| {
                if valid && definition.mode == mode {
                    definition
                        .palette(section)
                        .unwrap_or_else(|| fallback.clone())
                } else {
                    fallback.clone()
                }
            };
            let app_palette = resolve(ThemeSectionKind::App);
            let syntax_palette = resolve(ThemeSectionKind::Syntax);
            let terminal_palette = resolve(ThemeSectionKind::Terminal);
            let terminal_name = terminal_palette.name.clone();
            ThemePreviewSample {
                app: app_palette,
                syntax: syntax_palette,
                terminal: TerminalAppearance::for_palette(&terminal_palette),
                terminal_name,
                diagnostics: Vec::new(),
            }
        };
        let light = project(PaletteMode::Light);
        let dark = project(PaletteMode::Dark);
        Ok(ThemeDraftPreview {
            tag: Default::default(),
            definition,
            app,
            terminal,
            syntax,
            light,
            dark,
            valid,
            diagnostics,
        })
    }
    pub fn theme_library(&self, request: &ThemeListRequest) -> Result<ThemeLibrary> {
        let after = request.after_id.as_deref().unwrap_or("");
        check_id(if after.is_empty() { "start" } else { after })?;
        let mut themes: Vec<ThemeSummary> = self
            .connection
            .prepare("SELECT summary FROM theme_definitions WHERE id>?1 ORDER BY id LIMIT ?2")?
            .query_map(params![after, (PAGE_SIZE + 1) as i64], |row| {
                row.get::<_, String>(0)
            })?
            .map(|row| decode(row?))
            .collect::<Result<_>>()?;
        themes.extend(
            builtin_catalog()
                .iter()
                .filter(|palette| palette.id.as_str() > after)
                .map(|palette| ThemeSummary {
                    id: palette.id.clone(),
                    name: palette.name.clone(),
                    mode: palette.mode,
                    revision: 0,
                    bundled: true,
                    sections: ThemeSections {
                        app: true,
                        terminal: true,
                        syntax: true,
                    },
                    provenance: builtin_provenance(),
                }),
        );
        themes.sort_by(|a, b| a.id.cmp(&b.id));
        let has_more = themes.len() > PAGE_SIZE;
        themes.truncate(PAGE_SIZE);
        let next_id =
            has_more.then(|| themes.last().expect("A full page has a last ID").id.clone());
        Ok(ThemeLibrary {
            tag: Default::default(),
            revision: revision(&self.connection)?,
            themes,
            next_id,
        })
    }

    pub fn theme(&self, id: &str) -> Result<ThemeRecord> {
        check_id(id)?;
        self.theme_optional(id)?
            .ok_or_else(|| ThemeNotFound(id.into()).into())
    }

    pub fn theme_optional(&self, id: &str) -> Result<Option<ThemeRecord>> {
        check_id(id)?;
        if let Some(bundled) = bundled_record(id)? {
            return Ok(Some(bundled));
        }
        record(&self.connection, id)
    }

    pub fn install_themes(&self, request: &ThemeInstallRequest) -> Result<ThemeInstallation> {
        ensure!(
            !request.items.is_empty() && request.items.len() <= BATCH_SIZE,
            "Accept between 1 and 16 definitions per batch"
        );
        ensure!(
            request
                .items
                .iter()
                .map(|item| item.source.len())
                .sum::<usize>()
                <= BATCH_SOURCE_BYTES,
            "Accepted theme sources exceed 512 KiB"
        );
        let validations: Vec<_> = request
            .items
            .iter()
            .map(|item| validate(&item.source))
            .collect();
        let mut items: Vec<_> = validations
            .iter()
            .enumerate()
            .map(|(index, validation)| ThemeInstallReport {
                index,
                valid: validation.valid,
                diagnostics: validation.diagnostics.clone(),
                theme: None,
            })
            .collect();
        if validations.iter().any(|validation| !validation.valid) {
            return Ok(ThemeInstallation {
                tag: Default::default(),
                committed: false,
                changed: false,
                revision: revision(&self.connection)?,
                items,
            });
        }
        let mut ids = BTreeSet::new();
        for validation in &validations {
            let definition = validation
                .definition
                .as_ref()
                .expect("Validated definitions are present");
            ensure!(
                ids.insert(&definition.id),
                "An accepted batch repeats theme ID {}",
                definition.id
            );
            writable(&definition.id, &definition.provenance.kind)?;
        }
        let tx = self.transaction()?;
        let settings = self.settings()?;
        let selected_ids = self.selected_theme_ids()?;
        let before = revision(&tx)?;
        let next = before
            .checked_add(1)
            .context("Theme library revision exhausted")?;
        let next_db = i64::try_from(next).context("Theme library revision exhausted")?;
        let mut changed = false;
        let mut appearance_changed = false;
        for (index, (input, validation)) in request.items.iter().zip(validations).enumerate() {
            let definition = validation
                .definition
                .expect("Validated definitions are present");
            let current = record(&tx, &definition.id)?;
            if let Some(current) = &current
                && serde_json::to_value(&current.definition)? == serde_json::to_value(&definition)?
            {
                items[index].theme = Some(current.summary());
                continue;
            }
            let current_revision = current.as_ref().map_or(0, |current| current.revision);
            if input.expected_revision != current_revision {
                return Err(ThemeConflict {
                    id: definition.id,
                    expected: input.expected_revision,
                    current: current_revision,
                }
                .into());
            }
            let theme = ThemeRecord {
                revision: next,
                definition,
                source: input.source.clone(),
                diagnostics: validation.diagnostics,
            };
            let summary = theme.summary();
            tx.execute("INSERT INTO theme_definitions(id,revision,data,summary) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,summary=excluded.summary",
                params![summary.id, next_db, encode(&theme)?, encode(&summary)?])?;
            items[index].theme = Some(summary);
            changed = true;
            appearance_changed |= selected_ids.contains(&theme.definition.id);
        }
        if appearance_changed {
            let appearance_revision = settings
                .appearance_revision
                .checked_add(1)
                .context("Appearance revision exhausted")?;
            tx.execute("INSERT INTO profile_settings(key,value,updated_at) VALUES('appearance_revision',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                params![serde_json::to_string(&appearance_revision)?, now_ms()])?;
        }
        if changed {
            tx.execute(
                "UPDATE theme_library_state SET revision=?1 WHERE id=1",
                [next_db],
            )?;
        }
        tx.commit()?;
        Ok(ThemeInstallation {
            tag: Default::default(),
            committed: true,
            changed,
            revision: if changed { next } else { before },
            items,
        })
    }

    pub fn rename_theme(&self, request: &ThemeRenameRequest) -> Result<ThemeInstallation> {
        let mut current = self.theme(&request.id)?;
        writable(&current.definition.id, &current.definition.provenance.kind)?;
        current.definition.name = request.name.clone();
        self.install_themes(&ThemeInstallRequest {
            items: vec![ThemeInstallItem {
                source: serde_json::to_string(&current.definition)?,
                expected_revision: request.expected_revision,
            }],
        })
    }

    pub fn export_theme(&self, request: &ThemeExportRequest) -> Result<ThemeExport> {
        let theme = self.theme(&request.id)?;
        if let Some(expected) = request.expected_revision
            && expected != theme.revision
        {
            return Err(ThemeConflict {
                id: request.id.clone(),
                expected,
                current: theme.revision,
            }
            .into());
        }
        Ok(ThemeExport {
            tag: Default::default(),
            theme: theme.summary(),
            source: serde_json::to_string(&theme.definition)?,
        })
    }
}
