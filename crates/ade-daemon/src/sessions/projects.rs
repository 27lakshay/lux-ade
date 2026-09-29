//! One project identity for the catalog and the worktree lifecycle, and the
//! facts the daemon keeps current about each workspace's folder: its kind,
//! the branch its `HEAD` names, and whether ADE owns the tree.
use super::*;
use crate::store::WorkspaceFacts;
use ade_core::model::WorkspaceKind;

/// How often the daemon looks at every workspace's `HEAD` again, so a
/// `git switch` made outside ADE reaches the catalog.
pub(super) const FACTS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);

impl Sessions {
    /// Gives the lifecycle the catalog's project IDs, so a repository it
    /// registers takes its project's ID.
    pub(super) fn share_project_ids(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        self.worktrees.set_project_ids(Arc::new(move |common| {
            let hub = weak.upgrade().context("The profile daemon is stopping")?;
            let d = hub.data.lock().unwrap();
            d.store.project_for_common(common)
        }));
    }

    /// Records the daemon's own workspace, which replies mark `default`.
    pub fn set_default_workspace(&self, id: &str) {
        self.data.lock().unwrap().store.set_default_workspace(id);
    }

    /// Looks at each workspace's folder again, or only `only`'s: its kind,
    /// its branch and whether ADE owns the tree. Stores what changed and
    /// publishes one catalog frame when anything did.
    pub fn refresh_workspace_facts(&self, only: Option<&str>) -> Result<()> {
        let targets = self.data.lock().unwrap().store.fact_targets(only)?;
        if targets.is_empty() {
            return Ok(());
        }
        let owned = self.worktrees.owned_paths()?;
        let observed: Vec<(String, WorkspaceFacts)> = targets
            .into_iter()
            .filter_map(|target| {
                let (kind, branch) = crate::projects::inspect(&target.root, target.repository);
                let facts = WorkspaceFacts {
                    kind,
                    branch,
                    ade_owned: kind == WorkspaceKind::LinkedWorktree
                        && owned.contains(&target.root),
                };
                (facts != target.facts).then_some((target.id, facts))
            })
            .collect();
        if observed.is_empty() {
            return Ok(());
        }
        let mut d = self.data.lock().unwrap();
        let mut changed = false;
        for (id, facts) in observed {
            changed |= d.store.set_workspace_facts(&id, &facts)?;
        }
        if changed {
            self.catalog_changed(&mut d)?;
        }
        Ok(())
    }

    /// A workspace as a reply carries it: current facts and presentation.
    pub(super) fn presented_workspace(&self, id: &str) -> Result<WorkspaceRecord> {
        self.refresh_workspace_facts(Some(id))?;
        let d = self.data.lock().unwrap();
        let mut workspace = d.store.workspace(id)?;
        d.store.present_workspace(&mut workspace);
        Ok(workspace)
    }

    /// A project by its ID.
    pub fn project(&self, id: &str) -> Result<crate::store::Project> {
        self.data.lock().unwrap().store.project(id)
    }

    /// The roots of a repository project's workspaces, those in the catalog first.
    pub fn project_roots(&self, id: &str) -> Result<Vec<String>> {
        self.data.lock().unwrap().store.project_roots(id)
    }

    /// What the profile database knows blocks removing a workspace.
    pub fn workspace_remove_blockers(
        &self,
        id: &str,
    ) -> Result<Vec<ade_core::workspaces::RemoveBlocker>> {
        self.data
            .lock()
            .unwrap()
            .store
            .workspace_remove_blockers(id)
    }

    pub fn probe_worktree_operation(
        &self,
        id: &str,
        op: &str,
        payload: &Value,
    ) -> Result<crate::store::WorktreeAdmission> {
        self.data
            .lock()
            .unwrap()
            .store
            .probe_worktree_operation(id, op, payload)
    }

    /// Admits a workspace worktree operation; a new one is on the feed at once.
    pub fn admit_worktree_operation(
        &self,
        op: &str,
        payload: &Value,
        record: &crate::store::WorktreeOperationRecord,
    ) -> Result<crate::store::WorktreeAdmission> {
        let mut d = self.data.lock().unwrap();
        let admission = d.store.admit_worktree_operation(op, payload, record)?;
        if matches!(admission, crate::store::WorktreeAdmission::New) {
            self.worktree_operation_changed(&mut d, record);
        }
        Ok(admission)
    }

    pub fn worktree_operation(
        &self,
        id: &str,
    ) -> Result<Option<crate::store::WorktreeOperationRecord>> {
        self.data.lock().unwrap().store.worktree_operation(id)
    }

    pub fn running_worktree_operations(
        &self,
    ) -> Result<Vec<crate::store::WorktreeOperationRecord>> {
        self.data
            .lock()
            .unwrap()
            .store
            .running_worktree_operations()
    }

    /// Stores the operation's next state and puts it on the feed.
    pub fn save_worktree_operation(
        &self,
        record: &mut crate::store::WorktreeOperationRecord,
    ) -> Result<()> {
        let mut d = self.data.lock().unwrap();
        d.store.save_worktree_operation(record)?;
        self.worktree_operation_changed(&mut d, record);
        Ok(())
    }

    fn worktree_operation_changed(
        &self,
        d: &mut Data,
        record: &crate::store::WorktreeOperationRecord,
    ) {
        self.publish(
            d,
            json!({"type": "workspace_worktree_operation_changed", "operation": record.reply()}),
        );
    }

    /// A Conversation as a reply or feed frame carries it.
    pub(super) fn presented(d: &Data, conversation: &Conversation) -> Result<Conversation> {
        let mut conversation = conversation.clone();
        d.store.present_conversation(&mut conversation)?;
        Ok(conversation)
    }
}
