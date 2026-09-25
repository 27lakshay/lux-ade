pub const APPLICATION_PROTOCOL: &str = "ade-application-v1";
pub const RUNTIME_PROTOCOL: &str = "ade-runtime-v8";

// Decimal byte-array JSON needs at most four bytes per binary byte. Reserve
// 512 KiB for the bounded conversation and snapshot metadata, including newline.
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
// New clients negotiate base64; the native snapshot format and legacy byte-array
// encoding remain compatible. Enforce the decoded bound before allocating either.
pub fn decode_snapshot(event: &serde_json::Value) -> anyhow::Result<Vec<u8>> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    if let Some(encoded) = event.get("terminal_snapshot_base64") {
        anyhow::ensure!(
            event.get("terminal_snapshot_bytes").is_none(),
            "Ambiguous terminal snapshot encoding"
        );
        let text = encoded
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid base64 snapshot"))?;
        anyhow::ensure!(
            text.len() <= MAX_SNAPSHOT_BYTES.div_ceil(3) * 4,
            "Terminal snapshot exceeds decoded capacity"
        );
        let bytes = STANDARD.decode(text)?;
        check_snapshot_size(bytes.len()).map_err(anyhow::Error::msg)?;
        return Ok(bytes);
    }
    let values = event["terminal_snapshot_bytes"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Missing terminal snapshot bytes"))?;
    check_snapshot_size(values.len()).map_err(anyhow::Error::msg)?;
    values
        .iter()
        .map(|v| {
            v.as_u64()
                .and_then(|n| u8::try_from(n).ok())
                .ok_or_else(|| anyhow::anyhow!("Invalid terminal snapshot byte"))
        })
        .collect()
}
#[cfg(test)]
mod tests {
    #[test]
    fn compact_and_legacy_snapshots_preserve_every_byte() {
        use base64::Engine as _;
        let bytes: Vec<u8> = (0..=255).collect();
        let compact = serde_json::json!({"terminal_snapshot_base64":base64::engine::general_purpose::STANDARD.encode(&bytes)});
        assert_eq!(super::decode_snapshot(&compact).unwrap(), bytes);
        assert_eq!(
            super::decode_snapshot(&serde_json::json!({"terminal_snapshot_bytes":bytes})).unwrap(),
            bytes
        );
        for bad in [
            serde_json::json!({"terminal_snapshot_base64":"!invalid"}),
            serde_json::json!({"terminal_snapshot_base64":"AQ==","terminal_snapshot_bytes":[1]}),
            serde_json::json!({"terminal_snapshot_bytes":[256]}),
        ] {
            assert!(super::decode_snapshot(&bad).is_err());
        }
        assert!(super::decode_snapshot(&serde_json::json!({"terminal_snapshot_base64":"A".repeat(super::MAX_SNAPSHOT_BYTES.div_ceil(3)*4+4)})).is_err());
    }
    #[test]
    fn oversized_snapshot_has_explicit_error() {
        assert!(super::check_snapshot_size(super::MAX_SNAPSHOT_BYTES).is_ok());
        assert!(super::check_snapshot_size(super::MAX_SNAPSHOT_BYTES + 1).is_err());
    }
}
