//! Immutable prompt content. Attachment bytes live in the daemon's store, not
//! in mutable user files or client projections.
use crate::model::Attachment;
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

pub const ATTACHMENT_LIMIT: usize = 8 * 1024 * 1024;
pub const ATTACHMENT_COUNT: usize = 8;

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Content {
    pub attachment: Attachment,
    pub data: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Prompt {
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<Content>,
}
pub fn media_type(bytes: &[u8]) -> Result<&'static str> {
    ensure!(
        !bytes.is_empty() && bytes.len() <= ATTACHMENT_LIMIT,
        "Attachment must contain between 1 byte and 8 MiB of data"
    );
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok("image/png");
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Ok("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Ok("image/gif");
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return Ok("image/webp");
    }
    ensure!(
        bytes.len() <= 1024 * 1024 && !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok(),
        "Supported attachments: PNG, JPEG, GIF, WebP, and UTF-8 text files up to 1 MiB"
    );
    Ok("text/plain")
}
impl Content {
    pub fn text_block(&self) -> Result<String> {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(&self.data)?;
        Ok(format!(
            "Attached file {}:\n{}",
            self.attachment.name,
            String::from_utf8(bytes)?
        ))
    }
}
