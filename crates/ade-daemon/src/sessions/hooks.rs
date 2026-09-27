//! Lifecycle hook wiring (F058): the subscription mirror, the dispatcher
//! thread and the `hook.*` operations. The outbox itself is `crate::hooks`.
use super::*;

impl Sessions {
    pub(super) fn hook_command(&self, request: &Value) -> Result<Value> {
        let host = self.hooks.host.status();
        let d = self.data.lock().unwrap();
        crate::hooks::command(&d.store.connection, host, request, now_ms())
    }

    /// Mirrors subscriptions now. A failure is logged and the dispatcher
    /// retries on its next pass; the plugin operation already committed.
    pub(super) fn refresh_hook_subscriptions(&self) {
        if let Err(error) = self.sync_hook_subscriptions() {
            self.hooks.mark_stale();
            eprintln!("Hook subscriptions: {error:#}");
        }
    }

    /// Mirrors the live activations' subscriptions into every database that
    /// commits hookable events. While the plugin registry is unavailable the
    /// last mirror stays: dropping it would lose events for plugins that may
    /// still be enabled.
    fn sync_hook_subscriptions(&self) -> Result<()> {
        let Ok(plugins) = &self.plugins else {
            return Ok(());
        };
        let subscriptions = plugins.hook_subscriptions()?;
        crate::hooks::replace_subscriptions(
            &self.data.lock().unwrap().store.connection,
            &subscriptions,
        )?;
        self.worktrees.sync_hook_subscriptions(&subscriptions)
    }

    /// Delivers hooks on a thread of its own, so a slow plugin host never
    /// delays the daemon's other monitors.
    pub(super) fn start_hook_dispatcher(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(250));
                let Some(hub) = weak.upgrade() else {
                    break;
                };
                if let Err(error) = hub.dispatch_hooks() {
                    eprintln!("Hook dispatcher: {error:#}");
                }
            }
        });
    }

    fn dispatch_hooks(&self) -> Result<()> {
        if self.hooks.take_stale() {
            self.refresh_hook_subscriptions();
        }
        let staged = self.worktrees.staged_hook_deliveries()?;
        if !staged.is_empty() {
            let relayed =
                crate::hooks::relay(&self.data.lock().unwrap().store.connection, &staged)?;
            self.worktrees.forget_hook_deliveries(&relayed)?;
        }
        let now = now_ms();
        if self.hooks.prune_due(now) {
            crate::hooks::prune(&self.data.lock().unwrap().store.connection, now)?;
        }
        let host = self.hooks.host.status();
        crate::hooks::follow_host(&self.data.lock().unwrap().store.connection, &host, now)?;
        if !host.available {
            return Ok(());
        }
        for _ in 0..crate::hooks::PASS_LIMIT {
            let claimed =
                crate::hooks::claim(&self.data.lock().unwrap().store.connection, now_ms())?;
            let Some(dispatch) = claimed else {
                break;
            };
            // The claim is durable before the send. If recording the verdict
            // fails, the delivery stays `dispatching` and becomes unknown.
            let verdict = self.hooks.host.deliver(&dispatch);
            crate::hooks::settle(
                &self.data.lock().unwrap().store.connection,
                &dispatch.effect_id,
                &verdict,
                now_ms(),
            )?;
        }
        Ok(())
    }
}
