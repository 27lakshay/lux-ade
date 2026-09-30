use ade_core::appearance::{CursorColor, Rgb, TerminalAppearance};
use std::ffi::c_void;
use std::ptr::NonNull;

unsafe extern "C" {
    fn ade_vt_appearance(
        terminal: *mut c_void,
        foreground: *const Rgb,
        background: *const Rgb,
        cursor: *const Rgb,
        palette: *const Rgb,
        dark: bool,
    ) -> i32;
    fn ade_vt_notify_scheme(
        terminal: *mut c_void,
        dark: bool,
        callback: unsafe extern "C" fn(*mut c_void, *mut c_void, *const u8, usize),
        userdata: *mut c_void,
    ) -> i32;
    fn ade_vt_new(cols: u16, rows: u16) -> *mut c_void;
    fn ade_vt_free(terminal: *mut c_void);
    fn ade_vt_reply_callback(
        terminal: *mut c_void,
        callback: unsafe extern "C" fn(*mut c_void, *mut c_void, *const u8, usize),
        userdata: *mut c_void,
    ) -> i32;
    fn ade_vt_write(terminal: *mut c_void, bytes: *const u8, len: usize);
    fn ade_vt_resize(
        terminal: *mut c_void,
        cols: u16,
        rows: u16,
        cell_width: u32,
        cell_height: u32,
    ) -> i32;
    fn ade_vt_info(terminal: *mut c_void, values: *mut u16) -> i32;
    fn ade_vt_snapshot(
        terminal: *mut c_void,
        bytes: *mut *mut u8,
        len: *mut usize,
        plain: bool,
    ) -> i32;
    fn ade_vt_buffer_free(bytes: *mut u8, len: usize);
    fn ade_vt_encode(terminal: *mut c_void, bytes: *mut *mut u8, len: *mut usize) -> i32;
    #[cfg(test)]
    fn ade_vt_decode(bytes: *const u8, len: usize, terminal: *mut *mut c_void) -> i32;
}

// The FFI callback stores the Vec header's address. Boxing keeps that address
// stable when TerminalState moves; the Vec's backing allocation alone does not.
#[allow(clippy::box_collection)]
pub struct TerminalState(NonNull<c_void>, Box<Vec<u8>>);
unsafe extern "C" fn collect_reply(
    _: *mut c_void,
    userdata: *mut c_void,
    bytes: *const u8,
    len: usize,
) {
    // Ghostty calls synchronously while State's mutex exclusively owns this model.
    let output = unsafe { &mut *userdata.cast::<Vec<u8>>() };
    if len != 0 {
        output.extend_from_slice(unsafe { std::slice::from_raw_parts(bytes, len) });
    }
}
// The daemon exclusively accesses this instance while holding State's mutex.
unsafe impl Send for TerminalState {}

impl TerminalState {
    pub fn set_appearance(&mut self, appearance: &TerminalAppearance) -> Result<(), String> {
        let cursor = match &appearance.cursor {
            CursorColor::Literal(color) => color as *const Rgb,
            CursorColor::Cell(_) => std::ptr::null(),
        };
        if appearance.palette.len() != 256 {
            return Err("A terminal palette must contain 256 colors".into());
        }
        let result = unsafe {
            ade_vt_appearance(
                self.0.as_ptr(),
                &appearance.foreground,
                &appearance.background,
                cursor,
                appearance.palette.as_ptr(),
                appearance.dark,
            )
        };
        if result != 0 {
            return Err(format!("libghostty-vt appearance: {result}"));
        }
        Ok(())
    }
    pub fn notify_scheme(&mut self, dark: bool) -> Result<(), String> {
        let result = unsafe {
            ade_vt_notify_scheme(
                self.0.as_ptr(),
                dark,
                collect_reply,
                (&mut *self.1 as *mut Vec<u8>).cast(),
            )
        };
        if result != 0 {
            return Err(format!("libghostty-vt scheme notification: {result}"));
        }
        Ok(())
    }
    pub fn new(cols: u16, rows: u16) -> Result<Self, String> {
        let terminal = NonNull::new(unsafe { ade_vt_new(cols, rows) })
            .ok_or_else(|| "libghostty-vt initialization failed".to_string())?;
        Self::with_replies(terminal)
    }
    fn with_replies(terminal: NonNull<c_void>) -> Result<Self, String> {
        let mut state = Self(terminal, Box::default());
        let result = unsafe {
            ade_vt_reply_callback(
                terminal.as_ptr(),
                collect_reply,
                (&mut *state.1 as *mut Vec<u8>).cast(),
            )
        };
        if result != 0 {
            return Err(format!("libghostty-vt reply callback: {result}"));
        }
        Ok(state)
    }
    pub fn take_replies(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.1)
    }
    pub fn write(&mut self, bytes: &[u8]) {
        unsafe { ade_vt_write(self.0.as_ptr(), bytes.as_ptr(), bytes.len()) }
    }
    #[cfg(test)]
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        self.resize_pixels(cols, rows, 0, 0)
    }
    pub fn resize_pixels(
        &mut self,
        cols: u16,
        rows: u16,
        width: u16,
        height: u16,
    ) -> Result<(), String> {
        let result = unsafe {
            ade_vt_resize(
                self.0.as_ptr(),
                cols,
                rows,
                (width / cols) as u32,
                (height / rows) as u32,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(format!("libghostty-vt resize: {result}"))
        }
    }
    pub fn info(&self) -> [u16; 9] {
        let mut values = [0; 9];
        unsafe {
            ade_vt_info(self.0.as_ptr(), values.as_mut_ptr());
        }
        values
    }
    fn format(&self, plain: bool) -> Result<Vec<u8>, String> {
        let mut bytes = std::ptr::null_mut();
        let mut len = 0;
        let result = unsafe { ade_vt_snapshot(self.0.as_ptr(), &mut bytes, &mut len, plain) };
        if result != 0 {
            return Err(format!("libghostty-vt format: {result}"));
        }
        let output = if len == 0 {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(bytes, len).to_vec() }
        };
        unsafe {
            ade_vt_buffer_free(bytes, len);
        }
        Ok(output)
    }
    pub fn snapshot(&self) -> Result<Vec<u8>, String> {
        // RIS establishes the defaults assumed by Ghostty's mode formatter.
        let mut output = b"\x1bc".to_vec();
        output.extend(self.format(false)?);
        Ok(output)
    }
    pub fn binary_snapshot(&self) -> Result<Vec<u8>, String> {
        let mut bytes = std::ptr::null_mut();
        let mut len = 0;
        let result = unsafe { ade_vt_encode(self.0.as_ptr(), &mut bytes, &mut len) };
        if result != 0 {
            return Err(format!("libghostty-vt binary snapshot: {result}"));
        }
        let output = if len == 0 {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(bytes, len).to_vec() }
        };
        unsafe { ade_vt_buffer_free(bytes, len) };
        Ok(output)
    }
    #[cfg(test)]
    fn from_binary(bytes: &[u8]) -> Result<Self, String> {
        let mut terminal = std::ptr::null_mut();
        let result = unsafe { ade_vt_decode(bytes.as_ptr(), bytes.len(), &mut terminal) };
        if result != 0 {
            return Err(format!("libghostty-vt decode: {result}"));
        }
        Self::with_replies(
            NonNull::new(terminal).ok_or_else(|| "decoder returned no terminal".to_string())?,
        )
    }
    #[cfg(test)]
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.format(true).unwrap()).into_owned()
    }
}
impl Drop for TerminalState {
    fn drop(&mut self) {
        unsafe {
            ade_vt_free(self.0.as_ptr());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replies_use_authoritative_cursor_and_pixel_geometry() {
        let mut terminal = TerminalState::new(80, 24).unwrap();
        terminal.resize_pixels(80, 24, 800, 480).unwrap();
        terminal.take_replies();
        terminal.write(b"\x1b[10;20H\x1b[6n\x1b[14t\x1b[16t");
        assert_eq!(
            terminal.take_replies(),
            b"\x1b[10;20R\x1b[4;480;800t\x1b[6;20;10t"
        );
        assert!(terminal.take_replies().is_empty());
    }
    #[test]
    fn symbolic_cursor_fill_keeps_ghostty_osc12_default_and_override() {
        let mut appearance = TerminalAppearance::default();
        appearance.cursor = CursorColor::Cell(ade_core::appearance::CellColor::CellForeground);
        let mut terminal = TerminalState::new(80, 24).unwrap();
        terminal.set_appearance(&appearance).unwrap();

        let query_cursor = |terminal: &mut TerminalState| {
            terminal.take_replies();
            terminal.write(b"\x1b]12;?\x07");
            terminal.take_replies()
        };
        let rgb = appearance.foreground;
        let default_reply = format!(
            "\x1b]12;rgb:{:02x}{:02x}/{:02x}{:02x}/{:02x}{:02x}\x07",
            rgb.r, rgb.r, rgb.g, rgb.g, rgb.b, rgb.b
        );
        assert_eq!(query_cursor(&mut terminal), default_reply.as_bytes());

        terminal.write(b"\x1b]12;#123456\x07");
        assert_eq!(
            query_cursor(&mut terminal),
            b"\x1b]12;rgb:1212/3434/5656\x07"
        );
        terminal.write(b"\x1b]112\x07");
        assert_eq!(query_cursor(&mut terminal), default_reply.as_bytes());
    }
    #[test]
    fn binary_restores_both_screens_history_and_unfinished_input() {
        for (prefix, continuation) in [
            (b"\x1b[3".as_slice(), b"1mRED".as_slice()),
            (&[0xe4, 0xbd][..], &[0xa0][..]),
            (b"\x1b]2;unfinished".as_slice(), b" title\x07".as_slice()),
        ] {
            let mut original = TerminalState::new(40, 8).unwrap();
            original.write(b"HISTORY_MARKER\r\n");
            for row in 0..100 {
                original.write(format!("line {row}\r\n").as_bytes());
            }
            original.write(b"PRIMARY_MARKER\x1b[?1049hALTERNATE_MARKER");
            original.write(prefix);
            let mut restored =
                TerminalState::from_binary(&original.binary_snapshot().unwrap()).unwrap();
            assert_eq!(original.info(), restored.info());
            // A second reconnect before the unfinished sequence completes must
            // preserve its continuation as well.
            restored = TerminalState::from_binary(&restored.binary_snapshot().unwrap()).unwrap();
            original.write(continuation);
            restored.write(continuation);
            assert_eq!(
                original.format(false).unwrap(),
                restored.format(false).unwrap()
            );
            assert!(restored.text().contains("ALTERNATE_MARKER"));
            original.write(b"\x1b[?1049l");
            restored.write(b"\x1b[?1049l");
            assert_eq!(
                original.format(false).unwrap(),
                restored.format(false).unwrap()
            );
            assert!(restored.text().contains("PRIMARY_MARKER"));
            assert!(restored.text().contains("HISTORY_MARKER"));
        }
    }

    #[test]
    fn binary_rejects_truncation_and_corruption() {
        let mut terminal = TerminalState::new(20, 5).unwrap();
        terminal.write(b"preserve me");
        let bytes = terminal.binary_snapshot().unwrap();
        for length in [0, 8, bytes.len() / 2, bytes.len() - 1] {
            assert!(TerminalState::from_binary(&bytes[..length]).is_err());
        }
        let mut damaged = bytes.clone();
        let middle = damaged.len() / 2;
        damaged[middle] ^= 1;
        assert!(TerminalState::from_binary(&damaged).is_err());
        assert!(terminal.text().contains("preserve me"));
    }

    #[test]
    fn continuation_overflow_fails_explicitly_then_recovers_at_ground() {
        let mut terminal = TerminalState::new(20, 5).unwrap();
        terminal.write(b"\x1b]2;");
        terminal.write(&vec![b'x'; 1024 * 1024 + 1]);
        assert!(terminal.binary_snapshot().is_err());
        terminal.write(b"\x07OK");
        let recovered = TerminalState::from_binary(&terminal.binary_snapshot().unwrap()).unwrap();
        assert_eq!(terminal.text(), recovered.text());
    }

    #[test]
    fn restores_active_screen_cursor_styles_and_modes() {
        let mut original = TerminalState::new(40, 12).unwrap();
        original.write(
            b"primary\x1b[?1049h\x1b[2J\x1b[3;5H\x1b[31mRED\x1b[0m\x1b[?25l\x1b[?2004h\x1b[?1h",
        );
        let snapshot = original.snapshot().unwrap();
        let mut recovered = TerminalState::new(40, 12).unwrap();
        recovered.write(&snapshot);
        assert_eq!(original.text(), recovered.text());
        assert_eq!(original.info(), recovered.info());
        assert_eq!(recovered.info()[4], 1);
        assert_eq!(recovered.info()[5], 0);
        assert_eq!(recovered.info()[7], 1);
        assert_eq!(recovered.info()[8], 1);
        // Canonical formatter equality compares styles without assuming one
        // equivalent SGR byte encoding (e.g. 31 versus 0;31).
        assert_eq!(
            original.format(false).unwrap(),
            recovered.format(false).unwrap()
        );
    }
    #[test]
    fn wraps_utf8_across_chunks_and_tracks_resize() {
        let mut original = TerminalState::new(20, 5).unwrap();
        original.write(&[0xe4, 0xbd]);
        original.write(&[0xa0]);
        original.write(b"\x1b[2;3Habc");
        original.resize(30, 10).unwrap();
        let mut recovered = TerminalState::new(30, 10).unwrap();
        recovered.write(&original.snapshot().unwrap());
        assert_eq!(original.info(), recovered.info());
        assert_eq!(original.text(), recovered.text());
        assert!(recovered.text().contains('你'));
    }

    #[test]
    fn unfinished_input_is_not_an_exact_formatter_recovery() {
        for (prefix, continuation) in [
            (b"\x1b[3".as_slice(), b"1mRED".as_slice()),
            (&[0xe4, 0xbd][..], &[0xa0][..]),
        ] {
            let mut original = TerminalState::new(20, 5).unwrap();
            original.write(prefix);
            assert_eq!(
                original.info()[6],
                0,
                "snapshot metadata exposes unfinished input"
            );
            let mut recovered = TerminalState::new(20, 5).unwrap();
            recovered.write(&original.snapshot().unwrap());
            original.write(continuation);
            recovered.write(continuation);
            // This intentionally records the formatter's boundary: complete
            // parser continuation requires Ghostty's binary snapshot codec.
            assert_ne!(original.text(), recovered.text());
        }
    }
}
