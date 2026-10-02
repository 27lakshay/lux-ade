//! Physical JSONL positions, never ADE message sequences.
use std::io::{BufRead, Seek, SeekFrom};

/// Count real newline boundaries without decoding or allocating the prefix.
/// Beyond the bounded prefix, byte identity stays available but line identity is unknown.
pub fn line_ordinal<R: BufRead + Seek>(
    reader: &mut R,
    offset: u64,
    max_prefix: u64,
) -> std::io::Result<Option<usize>> {
    if offset > max_prefix {
        reader.seek(SeekFrom::Start(offset - 1))?;
        let mut last = [0];
        reader.read_exact(&mut last)?;
        if last[0] != b'\n' {
            return Err(std::io::Error::other(
                "Native cursor is not a record boundary",
            ));
        }
        return Ok(None);
    }
    reader.seek(SeekFrom::Start(0))?;
    let mut remaining = offset;
    let mut ordinal = 0usize;
    let mut last = b'\n';
    while remaining != 0 {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        let take = chunk.len().min(remaining as usize);
        let prefix = &chunk[..take];
        ordinal += prefix.iter().filter(|&&byte| byte == b'\n').count();
        last = prefix[take - 1];
        reader.consume(take);
        remaining -= take as u64;
    }
    if last != b'\n' {
        return Err(std::io::Error::other(
            "Native cursor is not a record boundary",
        ));
    }
    Ok(Some(ordinal))
}

/// Match the import codec's canonical line key only when the reader measured it.
/// Bytes outside that measured prefix keep a clearly separate physical source identity.
pub fn record_key(key: &str, offset: u64, ordinal: Option<usize>, max_prefix: u64) -> String {
    let suffix = key.strip_prefix("line:0").unwrap_or(key);
    match ordinal.filter(|_| offset <= max_prefix) {
        Some(ordinal) => format!("line:{ordinal}{suffix}"),
        None => format!("byte:{offset}{suffix}"),
    }
}
