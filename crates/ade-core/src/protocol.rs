pub const APPLICATION_PROTOCOL: &str = "ade-application-v1";
pub const RUNTIME_PROTOCOL: &str = "ade-runtime-v8";

// A snapshot travels as base64 in one JSON line; the bound leaves room for a
// quarter of the message per byte, plus 512 KiB for the bounded conversation
// and snapshot metadata, including newline.
pub const MAX_MESSAGE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_SNAPSHOT_BYTES: usize = (MAX_MESSAGE_BYTES as usize - 512 * 1024) / 4;
pub fn check_snapshot_size(bytes: usize) -> Result<(), String> {
    if bytes > MAX_SNAPSHOT_BYTES {
        return Err(format!(
            "Terminal snapshot exceeds JSON transport capacity ({bytes} > {MAX_SNAPSHOT_BYTES} bytes)"
        ));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    #[test]
    fn oversized_snapshot_has_explicit_error() {
        assert!(super::check_snapshot_size(super::MAX_SNAPSHOT_BYTES).is_ok());
        assert!(super::check_snapshot_size(super::MAX_SNAPSHOT_BYTES + 1).is_err());
    }
}
