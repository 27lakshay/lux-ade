//! Main-thread-only native Ghostty surface. Its child is `ade-attach`; the daemon
//! owns the real shell PTY, so dropping this view does not terminate the session.
use std::{
    cell::Cell,
    ffi::{CString, c_char, c_void},
    marker::PhantomData,
    ptr::NonNull,
    rc::Rc,
};

unsafe extern "C" {
    fn ade_accessibility_register_child(parent: *mut c_void, child: *const c_void);
    fn ade_terminal_init(resources: *const c_char) -> bool;
    fn ade_terminal_create(
        parent: *mut c_void,
        command: *const c_char,
        cwd: *const c_char,
    ) -> *mut c_void;
    fn ade_terminal_bounds(view: *mut c_void, x: f64, y: f64, w: f64, h: f64, scale: f64);
    fn ade_terminal_focus(view: *mut c_void);
    fn ade_terminal_is_focused(view: *mut c_void) -> bool;
    fn ade_native_view_is_focused(view: *const c_void) -> bool;
    fn ade_terminal_visible(view: *mut c_void, visible: bool);
    fn ade_terminal_exited(view: *mut c_void) -> bool;
    fn ade_terminal_restore(view: *mut c_void, bytes: *const u8, len: usize) -> bool;
    fn ade_terminal_feed(view: *mut c_void, bytes: *const u8, len: usize) -> bool;
    fn ade_terminal_resize_grid(view: *mut c_void, cols: u16, rows: u16) -> bool;
    fn ade_terminal_destroy(view: *mut c_void);
}

pub struct Terminal {
    view: Cell<Option<NonNull<c_void>>>,
    // AppKit/Ghostty surface ownership cannot move to another thread.
    _main_thread: PhantomData<Rc<()>>,
}

impl Terminal {
    pub fn detached() -> Self {
        Self {
            view: Cell::new(None),
            _main_thread: PhantomData,
        }
    }
    pub fn detach(&self) {
        if let Some(view) = self.view.take() {
            unsafe { ade_terminal_destroy(view.as_ptr()) }
        }
    }
    /// # Safety
    /// `parent` must be a live AppKit NSView belonging to the current GPUI window.
    /// Call on the main thread and drop before destroying the parent window.
    pub unsafe fn new(parent: *mut c_void, command: &str, cwd: &str) -> anyhow::Result<Self> {
        anyhow::ensure!(!parent.is_null(), "missing parent NSView");
        let installed = crate::resources::resource("ghostty");
        let resources = std::env::var_os("GHOSTTY_RESOURCES_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                if installed.is_dir() {
                    installed
                } else {
                    env!("ADE_GHOSTTY_RESOURCES").into()
                }
            });
        let resources = CString::new(resources.to_string_lossy().as_bytes())?;
        let command = CString::new(command)?;
        let cwd = CString::new(cwd)?;
        anyhow::ensure!(
            unsafe { ade_terminal_init(resources.as_ptr()) },
            "Ghostty initialization failed"
        );
        let view =
            NonNull::new(unsafe { ade_terminal_create(parent, command.as_ptr(), cwd.as_ptr()) })
                .ok_or_else(|| anyhow::anyhow!("Ghostty surface creation failed"))?;
        Ok(Self {
            view: Cell::new(Some(view)),
            _main_thread: PhantomData,
        })
    }
    /// GPUI bounds in logical points, measured from the parent view's top left.
    pub fn set_bounds(&self, x: f64, y: f64, width: f64, height: f64, scale: f64) {
        let Some(view) = self.view.get() else {
            return;
        };
        if [x, y, width, height, scale].iter().all(|v| v.is_finite())
            && width > 0.
            && height > 0.
            && scale > 0.
        {
            unsafe { ade_terminal_bounds(view.as_ptr(), x, y, width, height, scale) }
        }
    }
    pub fn is_focused(&self) -> bool {
        self.view
            .get()
            .is_some_and(|view| unsafe { ade_terminal_is_focused(view.as_ptr()) })
    }
    pub fn focus(&self) {
        if let Some(view) = self.view.get() {
            unsafe { ade_terminal_focus(view.as_ptr()) }
        }
    }
    pub fn set_visible(&self, visible: bool) {
        if let Some(view) = self.view.get() {
            unsafe { ade_terminal_visible(view.as_ptr(), visible) }
        }
    }

    pub fn exited(&self) -> bool {
        self.view
            .get()
            .is_none_or(|view| unsafe { ade_terminal_exited(view.as_ptr()) })
    }
    pub fn restore(&self, bytes: &[u8]) -> anyhow::Result<()> {
        let Some(view) = self.view.get() else {
            return Ok(());
        };
        anyhow::ensure!(
            unsafe { ade_terminal_restore(view.as_ptr(), bytes.as_ptr(), bytes.len()) },
            "Native Ghostty rejected the terminal snapshot"
        );
        Ok(())
    }
    pub fn feed(&self, bytes: &[u8]) -> anyhow::Result<()> {
        let Some(view) = self.view.get() else {
            return Ok(());
        };
        anyhow::ensure!(
            unsafe { ade_terminal_feed(view.as_ptr(), bytes.as_ptr(), bytes.len()) },
            "Native Ghostty rejected terminal output"
        );
        Ok(())
    }
    pub fn resize_grid(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        let Some(view) = self.view.get() else {
            return Ok(());
        };
        anyhow::ensure!(
            unsafe { ade_terminal_resize_grid(view.as_ptr(), cols, rows) },
            "Native Ghostty rejected terminal resize"
        );
        Ok(())
    }
}
impl Drop for Terminal {
    fn drop(&mut self) {
        self.detach();
    }
}

unsafe extern "C" {
    fn ade_child_window_attach(parent: *mut c_void, child: *mut c_void) -> *mut c_void;
    fn ade_child_window_detach(link: *mut c_void);
}

/// Parents a separate GPUI popup above the workspace's native terminal/browser.
/// Owns the relationship, not the windows. The GPUI popup still needs explicit
/// dismissal and its owning window/entity should keep this value alive.
pub struct NativeChildWindow {
    link: NonNull<c_void>,
    _main_thread: PhantomData<Rc<()>>,
}
impl NativeChildWindow {
    /// # Safety
    /// Both pointers must be live GPUI AppKit content views on the main thread.
    /// Use an ordinary `WindowKind::PopUp` or `Dialog`, not `AnchoredPopup`, which
    /// this version of GPUI does not implement on macOS. Child windows are centered.
    pub unsafe fn attach(parent: *mut c_void, child: *mut c_void) -> anyhow::Result<Self> {
        anyhow::ensure!(
            !parent.is_null() && !child.is_null(),
            "missing native window view"
        );
        let link = NonNull::new(unsafe { ade_child_window_attach(parent, child) })
            .ok_or_else(|| anyhow::anyhow!("unable to attach popup to workspace window"))?;
        Ok(Self {
            link,
            _main_thread: PhantomData,
        })
    }
}
impl Drop for NativeChildWindow {
    fn drop(&mut self) {
        unsafe { ade_child_window_detach(self.link.as_ptr()) }
    }
}

/// # Safety
/// `view` must be a live AppKit NSView queried on the UI thread.
pub unsafe fn native_view_is_focused(view: *const c_void) -> bool {
    unsafe { ade_native_view_is_focused(view) }
}

/// Expose an embedded native view alongside the host's GPUI accessibility tree.
/// Registration holds a weak native reference and ignores hidden views.
///
/// # Safety
/// Both pointers must be live NSViews in the current window. Call on the main
/// thread while holding the native child owner; no pointer ownership transfers.
pub unsafe fn register_accessible_child(parent: *mut c_void, child: *const c_void) {
    unsafe {
        ade_accessibility_register_child(parent, child);
    }
}
