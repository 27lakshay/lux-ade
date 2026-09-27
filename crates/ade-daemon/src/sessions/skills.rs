//! `skill.*` operations. Filesystem reads run without the session lock; each
//! database step takes it briefly on the profile database.
use super::*;
use crate::skills::{self, placement};
use ade_core::contract::skills::{
    SkillAdoptRequest, SkillDiscoverRequest, SkillInspectRequest, SkillInstallRequest,
    SkillListRequest, SkillPlaceRequest, SkillRemoveRequest, SkillScope,
};
use std::path::PathBuf;

fn home() -> Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|home| home.is_absolute())
        .context("HOME is not an absolute path; provider skill roots are unknown")?;
    Ok(home)
}

fn absolute(field: &str, value: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    ensure!(
        path.is_absolute()
            && !path
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir)),
        "{field} must be an absolute path without .."
    );
    Ok(path)
}

impl Sessions {
    fn skill_roots(&self, workspace_id: Option<&str>) -> Result<Vec<placement::Root>> {
        let workspace = workspace_id
            .map(|id| {
                non_empty("workspace_id", id)?;
                self.ensure_workspace_bound(id)?;
                Ok::<_, anyhow::Error>(PathBuf::from(self.workspace(id)?.root))
            })
            .transpose()?;
        Ok(placement::provider_roots(&home()?, workspace.as_deref()))
    }

    /// Runs `step` on the profile database with the catalog tables present.
    fn skill_db<T>(
        &self,
        effect: bool,
        step: impl FnOnce(&rusqlite::Connection) -> Result<T>,
    ) -> Result<T> {
        let d = self.data.lock().unwrap();
        ensure!(!(effect && d.draining), "Application daemon is restarting");
        skills::ensure_tables(&d.store.connection)?;
        step(&d.store.connection)
    }

    pub(super) fn skill_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let now = now_ms();
        match request["op"].as_str().unwrap_or("") {
            "skill.install" => {
                let install: SkillInstallRequest = decode(request)?;
                let source = absolute("source_path", &install.source_path)?;
                let entry = source
                    .file_name()
                    .and_then(|name| name.to_str())
                    .context("source_path has no directory name")?
                    .to_owned();
                let read =
                    skills::read_bundle(&source, &entry).map_err(|error| anyhow!("{error}"))?;
                self.skill_db(true, |db| {
                    skills::install(
                        db,
                        request,
                        &install.source_path,
                        &read,
                        install.expected_content_hash.as_deref(),
                        install.replace_content_hash.as_deref(),
                        now,
                    )
                })
            }
            "skill.adopt" => {
                let adopt: SkillAdoptRequest = decode(request)?;
                non_empty("expected_content_hash", &adopt.expected_content_hash)?;
                let path = absolute("path", &adopt.path)?;
                let roots = self.skill_roots(adopt.workspace_id.as_deref())?;
                let entry = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .context("path has no directory name")?
                    .to_owned();
                let (seen, read) = skills::observe_read(&path, &entry);
                self.skill_db(true, |db| {
                    skills::adopt(
                        db,
                        request,
                        &roots,
                        &path,
                        &seen,
                        read.as_ref(),
                        &adopt.expected_content_hash,
                        now,
                    )
                })
            }
            "skill.remove" => {
                let remove: SkillRemoveRequest = decode(request)?;
                non_empty("name", &remove.name)?;
                non_empty("expected_content_hash", &remove.expected_content_hash)?;
                self.skill_db(true, |db| {
                    skills::remove(
                        db,
                        request,
                        &remove.name,
                        &remove.expected_content_hash,
                        now,
                    )
                })
            }
            "skill.place" => {
                let place: SkillPlaceRequest = decode(request)?;
                non_empty("name", &place.name)?;
                non_empty("expected_content_hash", &place.expected_content_hash)?;
                non_empty("provider", &place.provider)?;
                let workspace_id = match place.scope {
                    SkillScope::Workspace => Some(
                        place
                            .workspace_id
                            .as_deref()
                            .context("A workspace placement needs workspace_id")?,
                    ),
                    SkillScope::Global => {
                        ensure!(
                            place.workspace_id.is_none(),
                            "A global placement takes no workspace_id"
                        );
                        None
                    }
                };
                let roots = self.skill_roots(workspace_id)?;
                let root = skills::place_root(&roots, &place.provider, place.scope)
                    .with_context(|| {
                        format!(
                            "{} has no {} skill root ADE knows",
                            place.provider,
                            match place.scope {
                                SkillScope::Global => "global",
                                SkillScope::Workspace => "workspace",
                            }
                        )
                    })?
                    .clone();
                let target = root.path.join(&place.name);
                let seen = skills::observe(&target, &place.name);
                let admitted = self.skill_db(true, |db| {
                    skills::begin_place(db, request, &place, workspace_id, &target, &seen, now)
                })?;
                let (files, plan, reply) = match admitted {
                    skills::PlaceAdmission::Done(value) => return Ok(value),
                    skills::PlaceAdmission::Write { files, plan, reply } => (files, plan, reply),
                };
                match skills::write_placement(
                    &root.path,
                    &target,
                    &place.operation_id,
                    &files,
                    plan,
                ) {
                    Ok(()) => self.skill_db(false, |db| {
                        skills::finish_place(db, &reply, &place.operation_id, now_ms())
                    }),
                    Err(skills::WriteFailure::Untouched(error)) => {
                        self.skill_db(false, |db| skills::abandon_place(db, &place.operation_id))?;
                        Err(error.context(format!(
                            "Skill {} was not placed; {} is unchanged",
                            place.name,
                            target.display()
                        )))
                    }
                    Err(skills::WriteFailure::Uncertain(error)) => {
                        self.skill_db(false, |db| {
                            skills::unknown_place(db, &place.operation_id, now_ms())
                        })?;
                        Err(ade_core::error::OperationOutcomeUnknown(format!(
                            "Placing skill {} failed part-way ({error:#}); inspect {} before placing again",
                            place.name,
                            target.display()
                        ))
                        .into())
                    }
                }
            }
            "skill.list" => {
                let _: SkillListRequest = decode(request)?;
                self.skill_db(false, skills::list)
            }
            "skill.inspect" => {
                let inspect: SkillInspectRequest = decode(request)?;
                non_empty("name", &inspect.name)?;
                let roots = self.skill_roots(inspect.workspace_id.as_deref())?;
                let inspected = self.skill_db(false, |db| skills::load(db, &inspect.name))?;
                skills::inspection(inspected, &roots)
            }
            "skill.discover" => {
                let discover: SkillDiscoverRequest = decode(request)?;
                let roots = self.skill_roots(discover.workspace_id.as_deref())?;
                let (scanned, references) =
                    skills::scan(&roots, discover.workspace_id.as_deref(), now);
                self.skill_db(false, |db| {
                    skills::record_discovery(
                        db,
                        discover.workspace_id.as_deref(),
                        scanned,
                        references,
                    )
                })
            }
            _ => bail!("Unknown skill operation"),
        }
    }
}
