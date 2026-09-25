//! One catalogue for menus, palette, buttons and user keybindings.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
// A single admitted settings write spans disk persistence and native menu
// application, preventing different windows from applying results out of order.
static SAVING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub struct SavePermit;
impl SavePermit {
    pub fn acquire() -> Option<Self> {
        SAVING
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .ok()
            .map(|_| Self)
    }
}
impl Drop for SavePermit {
    fn drop(&mut self) {
        SAVING.store(false, std::sync::atomic::Ordering::Release);
    }
}
/// Menu application runs on the UI thread. Successful user saves supersede
/// background startup reads; an admitted but failed write does not.
#[derive(Default)]
pub struct BindingApplyOrder(std::sync::atomic::AtomicU64);
impl BindingApplyOrder {
    pub fn ticket(&self) -> u64 {
        self.0.load(std::sync::atomic::Ordering::Acquire)
    }
    pub fn apply_startup(&self, ticket: u64, apply: impl FnOnce()) -> bool {
        if self.ticket() != ticket {
            return false;
        }
        apply();
        true
    }
    pub fn apply_saved(&self, apply: impl FnOnce()) {
        apply();
        self.0.fetch_add(1, std::sync::atomic::Ordering::Release);
    }
}
pub static BINDING_APPLY_ORDER: BindingApplyOrder =
    BindingApplyOrder(std::sync::atomic::AtomicU64::new(0));
#[derive(Clone, Copy)]
pub struct Command {
    pub id: &'static str,
    pub title: &'static str,
    pub group: &'static str,
    pub shortcut: &'static str,
}
macro_rules! commands { ($(($id:literal,$title:literal,$group:literal,$key:literal)),* $(,)?) => {pub const COMMANDS:&[Command]=&[$(Command{id:$id,title:$title,group:$group,shortcut:$key}),*];}; }
commands![
    ("palette", "Search commands", "Workspace", "cmd+shift+p"),
    ("shortcuts", "Keyboard shortcuts", "Workspace", "cmd+,"),
    (
        "workspace.open",
        "Open workspace folder",
        "Workspace",
        "cmd+shift+o"
    ),
    ("conversation.new", "New Conversation", "Workspace", "cmd+n"),
    ("window.new", "New window", "Workspace", "cmd+shift+n"),
    ("changes", "Open Changes", "Workspace", "cmd+shift+d"),
    ("worktrees", "Open Worktrees", "Workspace", "cmd+shift+g"),
    ("services", "Open Services", "Workspace", ""),
    ("runtime", "Open Runtime", "Workspace", ""),
    ("sidebar.toggle", "Toggle sidebar", "View", "cmd+shift+1"),
    ("terminal.toggle", "Toggle terminal", "View", "cmd+shift+3"),
    ("browser.toggle", "Toggle browser", "View", "cmd+shift+4"),
    ("focus.sidebar", "Focus sidebar", "View", "cmd+1"),
    ("focus.conversation", "Focus Conversation", "View", "cmd+2"),
    ("focus.composer", "Focus composer", "View", "cmd+5"),
    ("focus.terminal", "Focus terminal", "View", "cmd+3"),
    ("focus.browser", "Focus browser", "View", "cmd+4"),
    ("focus.next", "Focus next pane", "View", "cmd+alt+]"),
    ("focus.previous", "Focus previous pane", "View", "cmd+alt+["),
    ("sidebar.grow", "Widen sidebar", "View", ""),
    ("sidebar.shrink", "Narrow sidebar", "View", ""),
    ("browser.grow", "Widen browser", "View", ""),
    ("browser.shrink", "Narrow browser", "View", ""),
    ("terminal.grow", "Increase terminal height", "View", ""),
    ("terminal.shrink", "Decrease terminal height", "View", ""),
    ("layout.reset", "Reset pane layout", "View", ""),
    ("terminal.new", "New terminal tab", "Tabs", "cmd+alt+t"),
    ("browser.new", "New browser tab", "Tabs", "cmd+alt+b"),
    (
        "terminal.close",
        "Close terminal view (keep shell)",
        "Tabs",
        ""
    ),
    ("browser.close", "Close browser tab", "Tabs", ""),
    ("terminal.reopen", "Reopen closed terminal view", "Tabs", ""),
    ("browser.reopen", "Reopen closed browser tab", "Tabs", ""),
    ("terminal.restart", "Restart exited terminal", "Tabs", ""),
    ("terminal.stop", "Stop active shell", "Tabs", ""),
    ("terminal.retire", "Retire exited terminal", "Tabs", ""),
    ("tab.pin", "Pin or unpin tab", "Tabs", ""),
    ("tab.rename", "Rename tab", "Tabs", ""),
    ("tab.close-others", "Close other tabs", "Tabs", ""),
    ("tab.close-left", "Close tabs to the left", "Tabs", ""),
    ("tab.close-right", "Close tabs to the right", "Tabs", ""),
    ("pane.split-left", "Split pane left", "Panes", ""),
    ("pane.split-up", "Split pane above", "Panes", ""),
    ("pane.move-left", "Move tab to left split", "Panes", ""),
    ("pane.move-right", "Move tab to right split", "Panes", ""),
    ("pane.move-up", "Move tab to upper split", "Panes", ""),
    ("pane.move-down", "Move tab to lower split", "Panes", ""),
    ("tab.new", "New empty tab", "Tabs", "cmd+t"),
    ("pane.split-right", "Split pane right", "Panes", "cmd+alt+r"),
    ("pane.split-down", "Split pane below", "Panes", "cmd+alt+d"),
    ("pane.zoom", "Zoom active pane", "Panes", "cmd+alt+z"),
    ("tab.close", "Close active tab", "Tabs", "cmd+shift+w"),
    ("tab.reopen", "Reopen closed tab", "Tabs", "cmd+shift+t"),
    ("tab.next", "Next tab", "Tabs", "cmd+shift+]"),
    ("tab.previous", "Previous tab", "Tabs", "cmd+shift+["),
    ("tab.left", "Move tab left", "Tabs", "cmd+ctrl+["),
    ("tab.right", "Move tab right", "Tabs", "cmd+ctrl+]"),
];
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Bindings(pub BTreeMap<String, String>);
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Shortcut {
    pub key: String,
    pub mask: u64,
}
pub fn parse(value: &str) -> Result<Option<Shortcut>, String> {
    if value.trim().is_empty() {
        return Ok(None);
    }
    let parts: Vec<_> = value
        .trim()
        .split('+')
        .map(|s| s.trim().to_lowercase())
        .collect();
    let key = parts.last().unwrap().clone();
    if key.chars().count() != 1 || !key.is_ascii() || key.chars().any(char::is_whitespace) {
        return Err("Use modifiers plus one character, for example cmd+shift+p".into());
    }
    let mut mask = 0;
    let mut modifiers = HashSet::new();
    for part in &parts[..parts.len() - 1] {
        if !modifiers.insert(part) {
            return Err("Repeated modifier".into());
        }
        mask |= match part.as_str() {
            "cmd" => 1 << 20,
            "shift" => 1 << 17,
            "ctrl" => 1 << 18,
            "alt" => 1 << 19,
            _ => return Err(format!("Unknown modifier: {part}")),
        };
    }
    if mask & (1 << 20) == 0 {
        return Err(
            "lux-ade shortcuts require cmd so shell and text editing keys remain available".into(),
        );
    }
    if mask == 1 << 20 && "acvxzyqw".contains(&key) {
        return Err("Reserved native editing/window shortcut".into());
    }
    Ok(Some(Shortcut { key, mask }))
}
impl Bindings {
    pub fn effective(&self, c: &Command) -> String {
        self.0
            .get(c.id)
            .cloned()
            .unwrap_or_else(|| c.shortcut.into())
    }
    pub fn validate(&self) -> Result<(), String> {
        for id in self.0.keys() {
            if !COMMANDS.iter().any(|c| c.id == id) {
                return Err(format!("Unknown command: {id}"));
            }
        }
        let mut used = std::collections::HashMap::new();
        for c in COMMANDS {
            if let Some(key) = parse(&self.effective(c)).map_err(|e| format!("{}: {e}", c.title))?
                && let Some(previous) = used.insert(key, c.title)
            {
                return Err(format!("Shortcut conflict: {previous} and {}", c.title));
            }
        }
        Ok(())
    }
    pub fn path() -> std::path::PathBuf {
        std::env::var_os("ADE_KEYBINDINGS")
            .map(Into::into)
            .unwrap_or_else(|| {
                std::path::PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
                    .join("Library/Application Support/lux-ade/keybindings.json")
            })
    }
    pub fn load() -> Result<Self, String> {
        match std::fs::read(Self::path()) {
            Ok(bytes) => {
                let b: Self = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                b.validate()?;
                Ok(b)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.to_string()),
        }
    }
    pub fn save(&self) -> Result<(), String> {
        self.save_to(&Self::path())
    }
    fn save_to(&self, path: &std::path::Path) -> Result<(), String> {
        self.validate()?;
        let parent = path.parent().ok_or("No settings directory")?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        use std::io::Write;
        let temp = parent.join(ade_core::model::new_id("keybindings-next"));
        let result = (|| -> Result<(), String> {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|e| e.to_string())?;
            let bytes = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
            file.write_all(&bytes).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            std::fs::rename(&temp, path).map_err(|e| e.to_string())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result
    }

    pub fn native_json(&self) -> String {
        serde_json::to_string(&COMMANDS.iter().enumerate().map(|(i,c)|{let shortcut=parse(&self.effective(c)).ok().flatten();serde_json::json!({"index":i,"title":c.title,"group":c.group,"key":shortcut.as_ref().map(|k|k.key.clone()).unwrap_or_default(),"mask":shortcut.map_or(0,|k|k.mask)})}).collect::<Vec<_>>()).unwrap()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_one_settings_write_is_admitted_until_apply_finishes() {
        let permit = SavePermit::acquire().expect("first save admitted");
        assert!(SavePermit::acquire().is_none());
        drop(permit);
        assert!(SavePermit::acquire().is_some());
    }
    #[test]
    fn rejected_settings_preserve_previous_file() {
        let directory = std::env::temp_dir().join(ade_core::model::new_id("settings-test"));
        let path = directory.join("keybindings.json");
        let bindings = Bindings::default();
        bindings.save_to(&path).unwrap();
        let before = std::fs::read(&path).unwrap();
        let mut invalid = Bindings::default();
        invalid.0.insert("missing".into(), "cmd+x".into());
        assert!(invalid.save_to(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(!path.with_extension("json.next").exists());
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn failed_replace_cleans_up_staged_settings() {
        let directory = std::env::temp_dir().join(ade_core::model::new_id("settings-test"));
        let path = directory.join("keybindings.json");
        std::fs::create_dir_all(&path).unwrap();
        assert!(Bindings::default().save_to(&path).is_err());
        assert!(path.is_dir());
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn defaults_are_unique() {
        Bindings::default().validate().unwrap();
    }
    #[test]
    fn conflicts_include_defaults() {
        let mut b = Bindings::default();
        b.0.insert("terminal.new".into(), "shift+cmd+p".into());
        assert!(b.validate().unwrap_err().contains("conflict"));
    }
    #[test]
    fn editing_and_shell_keys_are_protected() {
        for value in ["ctrl+c", "cmd+c", "cmd+w", "cmd+cmd+p", "cmd+enter"] {
            assert!(parse(value).is_err(), "{value}");
        }
        assert!(parse("cmd+alt+t").is_ok());
    }
    #[test]
    fn disabling_and_unknown_commands() {
        let mut b = Bindings::default();
        b.0.insert("palette".into(), String::new());
        b.validate().unwrap();
        b.0.insert("missing".into(), String::new());
        assert!(b.validate().is_err());
    }
}

#[cfg(test)]
mod binding_apply_tests {
    use super::*;
    use std::cell::RefCell;
    #[test]
    fn delayed_startup_cannot_replace_a_successful_settings_save() {
        let order = BindingApplyOrder::default();
        let applied = RefCell::new(vec![]);
        let ticket = order.ticket();
        order.apply_saved(|| applied.borrow_mut().push("user save"));
        assert!(!order.apply_startup(ticket, || applied.borrow_mut().push("old disk value")));
        assert_eq!(*applied.borrow(), ["user save"]);
    }
    #[test]
    fn startup_before_save_and_failed_save_preserve_disk_bindings() {
        let order = BindingApplyOrder::default();
        let applied = RefCell::new(vec![]);
        let ticket = order.ticket();
        // Failed writes never call apply_saved: startup must remain eligible.
        assert!(order.apply_startup(ticket, || applied.borrow_mut().push("saved disk value")));
        order.apply_saved(|| applied.borrow_mut().push("new user save"));
        assert_eq!(*applied.borrow(), ["saved disk value", "new user save"]);
    }
}
