use std::ffi::{CString, c_char, c_void};
unsafe extern "C" {
    fn ade_commands_watch(
        parent: *mut c_void,
        callback: extern "C" fn(*mut c_void, u32),
        context: *mut c_void,
    ) -> *mut c_void;
    fn ade_commands_unwatch(handle: *mut c_void);
    fn ade_commands_configure(json: *const c_char);
    pub fn ade_focus_kind(parent: *mut c_void) -> u32;
    pub fn ade_focus_parent(parent: *mut c_void);
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Event {
    Command(usize),
    Overflow,
}
#[derive(Default)]
struct Pending {
    commands: std::collections::VecDeque<usize>,
    overflow: bool,
}
pub(crate) struct Sender {
    pending: std::sync::Arc<std::sync::Mutex<Pending>>,
    wake: async_channel::Sender<()>,
}
pub(crate) struct Events {
    pending: std::sync::Arc<std::sync::Mutex<Pending>>,
    wake: async_channel::Receiver<()>,
}
pub(crate) fn event_channel() -> (Sender, Events) {
    let pending = std::sync::Arc::new(std::sync::Mutex::new(Pending::default()));
    let (tx, rx) = async_channel::bounded(1);
    (
        Sender {
            pending: pending.clone(),
            wake: tx,
        },
        Events { pending, wake: rx },
    )
}
impl Sender {
    fn publish(&self, index: usize) {
        if self.wake.is_closed() {
            return;
        }
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.commands.len() < 32 {
                pending.commands.push_back(index);
            } else {
                pending.overflow = true;
            }
        }
        let _ = self.wake.try_send(());
    }
}
impl Events {
    pub(crate) async fn recv(&self) -> Result<Event, async_channel::RecvError> {
        loop {
            let event = {
                let mut pending = self.pending.lock().unwrap();
                if let Some(index) = pending.commands.pop_front() {
                    Some(Event::Command(index))
                } else if std::mem::take(&mut pending.overflow) {
                    Some(Event::Overflow)
                } else {
                    None
                }
            };
            if let Some(event) = event {
                return Ok(event);
            }
            self.wake.recv().await?;
        }
    }
}
pub struct Bridge {
    handle: *mut c_void,
    sender: *mut Sender,
}
extern "C" fn receive(context: *mut c_void, index: u32) {
    let sender = unsafe { &*(context as *const Sender) };
    sender.publish(index as usize);
}
impl Bridge {
    pub fn new(parent: *mut c_void) -> (Self, Events) {
        let (tx, rx) = event_channel();
        let sender = Box::into_raw(Box::new(tx));
        let handle = unsafe { ade_commands_watch(parent, receive, sender.cast()) };
        (Self { handle, sender }, rx)
    }
    pub fn configure(bindings: &crate::commands::Bindings) {
        let json = CString::new(bindings.native_json()).unwrap();
        unsafe { ade_commands_configure(json.as_ptr()) }
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        unsafe {
            ade_commands_unwatch(self.handle);
            drop(Box::from_raw(self.sender));
        }
    }
}

/// Register standard editing actions through GPUI so native menu tags resolve
/// against its action table. OS selectors still reach terminal/webview responders.
pub fn install_edit_menu(cx: &mut gpui_kit::App) {
    use gpui_kit::component::input::{Copy, Cut, Paste, Redo, SelectAll, Undo};
    use gpui_kit::{Menu, MenuItem, OsAction};
    cx.set_menus(vec![
        Menu {
            name: "lux-ade".into(),
            items: vec![],
            disabled: false,
        },
        Menu {
            name: "Edit".into(),
            disabled: false,
            items: vec![
                MenuItem::os_action("Undo", Undo, OsAction::Undo),
                MenuItem::os_action("Redo", Redo, OsAction::Redo),
                MenuItem::Separator,
                MenuItem::os_action("Cut", Cut, OsAction::Cut),
                MenuItem::os_action("Copy", Copy, OsAction::Copy),
                MenuItem::os_action("Paste", Paste, OsAction::Paste),
                MenuItem::Separator,
                MenuItem::os_action("Select All", SelectAll, OsAction::SelectAll),
            ],
        },
    ]);
}

#[cfg(test)]
mod admission_tests {
    use super::*;
    #[test]
    fn native_callback_reports_overflow_without_reordering_accepted_commands() {
        let (sender, events) = event_channel();
        let context = (&sender as *const Sender).cast_mut().cast();
        for index in 0..100 {
            receive(context, index);
        }
        drop(sender);
        let mut commands = Vec::new();
        let mut overflow = 0;
        loop {
            let mut read = std::pin::pin!(events.recv());
            match std::future::Future::poll(
                read.as_mut(),
                &mut std::task::Context::from_waker(std::task::Waker::noop()),
            ) {
                std::task::Poll::Ready(Ok(Event::Command(index))) => commands.push(index),
                std::task::Poll::Ready(Ok(Event::Overflow)) => overflow += 1,
                std::task::Poll::Ready(Err(_)) => break,
                std::task::Poll::Pending => panic!("closed bridge must drain"),
            }
        }
        assert_eq!(commands, (0..32).collect::<Vec<_>>());
        assert_eq!(overflow, 1, "native command overflow disappears silently");
    }
}
