//! Workspace file contracts: bounded, read-only listing, search and preview.
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<FileListRequest, FileList>("file.list", Tier::Query),
        OperationSpec::new::<FileSearchRequest, FileSearch>("file.search", Tier::Query),
        OperationSpec::new::<FilePreviewRequest, FilePreview>("file.preview", Tier::Query),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// `file.list`: one page of a workspace directory.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct FileListRequest {
    pub workspace_id: String,
    /// Workspace-relative directory; the workspace root when absent or empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub path: Option<String>,
    /// The `next_cursor` of the previous page for the same path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// Page size, 1 to 100; the daemon uses 100 when it is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub limit: Option<u64>,
}

/// `file.search`: one page of entries whose name contains the query, ignoring case.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct FileSearchRequest {
    pub workspace_id: String,
    /// 1 to 256 bytes.
    pub query: String,
    /// The `next_cursor` of the previous page for the same query.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// Page size, 1 to 100; the daemon uses 100 when it is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub limit: Option<u64>,
}

/// `file.preview`: the bounded contents of one workspace file.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct FilePreviewRequest {
    pub workspace_id: String,
    /// Workspace-relative file path.
    pub path: String,
}

wire_tag!(FileListTag, "file_list");
wire_tag!(FileSearchTag, "file_search");
wire_tag!(FilePreviewTag, "file_preview");

/// A directory entry's type, read without following symbolic links.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    Directory,
    File,
    Symlink,
    Other,
}

/// One entry in a listing or search result.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct FileEntry {
    /// Display name; a name that is not UTF-8 is shown lossily.
    pub name: String,
    /// Workspace-relative path. A non-UTF-8 component is encoded as U+E000
    /// followed by its unpadded URL-safe Base64 bytes.
    pub path: String,
    pub kind: FileKind,
    /// Byte size of a regular file; null for every other kind.
    pub size: Option<u64>,
}

/// The `file.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct FileList {
    #[serde(rename = "type")]
    pub tag: FileListTag,
    pub path: String,
    pub entries: Vec<FileEntry>,
    /// Null when the directory has no more entries.
    pub next_cursor: Option<String>,
    pub incomplete: bool,
}

/// The `file.search` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct FileSearch {
    #[serde(rename = "type")]
    pub tag: FileSearchTag,
    pub results: Vec<FileEntry>,
    /// Null when the search has finished.
    pub next_cursor: Option<String>,
    /// True when depth, path-length or directory limits cut the search short.
    pub incomplete: bool,
}

/// How a preview presents the file.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PreviewKind {
    Text,
    Image,
    Unsupported,
}

/// The `file.preview` reply. `text` carries `mime` and `text`; `image` carries
/// `mime` and `bytes_base64`; `unsupported` carries neither.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct FilePreview {
    #[serde(rename = "type")]
    pub tag: FilePreviewTag,
    pub path: String,
    pub kind: PreviewKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes_base64: Option<String>,
    /// The file's byte size.
    pub size: u64,
    /// True when the file exceeds the 256 KiB preview limit.
    pub truncated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::bundle;
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

    fn names(op: &str) -> (String, String) {
        let bundle = bundle();
        let spec = bundle["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|spec| spec["name"] == op)
            .unwrap_or_else(|| panic!("{op} is registered"))
            .clone();
        (
            spec["request"].as_str().unwrap().to_owned(),
            spec["response"].as_str().unwrap().to_owned(),
        )
    }

    fn valid(name: &str, value: &Value) -> bool {
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": bundle()["$defs"],
            "$ref": format!("#/$defs/{name}"),
        });
        jsonschema::validator_for(&schema).unwrap().is_valid(value)
    }

    fn request<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let (name, _) = names(op);
        assert!(valid(&name, &wire), "{name} rejected {wire}");
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        let mut again = serde_json::to_value(decoded).unwrap();
        again["op"] = json!(op);
        assert_eq!(again, wire);
    }

    fn response<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let (_, name) = names(op);
        assert!(valid(&name, &wire), "{name} rejected {wire}");
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), wire);
    }

    #[test]
    fn requests_round_trip_as_callers_send_them() {
        request::<FileListRequest>(
            "file.list",
            json!({"op": "file.list", "workspace_id": "w", "path": "", "limit": 100}),
        );
        request::<FileListRequest>(
            "file.list",
            json!({"op": "file.list", "workspace_id": "w", "path": "src", "cursor": "ab", "limit": 5}),
        );
        request::<FileSearchRequest>(
            "file.search",
            json!({"op": "file.search", "workspace_id": "w", "query": "main", "limit": 100}),
        );
        request::<FilePreviewRequest>(
            "file.preview",
            json!({"op": "file.preview", "workspace_id": "w", "path": "README.md"}),
        );
        let (name, _) = names("file.search");
        assert!(!valid(
            &name,
            &json!({"op": "file.search", "workspace_id": "w"})
        ));
        let (name, _) = names("file.preview");
        assert!(!valid(
            &name,
            &json!({"op": "file.preview", "workspace_id": "w", "path": "a", "limit": 1})
        ));
    }

    #[test]
    fn replies_round_trip_in_the_daemon_shape() {
        response::<FileList>(
            "file.list",
            json!({"type": "file_list", "path": "src", "entries": [
                {"name": "main.rs", "path": "src/main.rs", "kind": "file", "size": 12},
                {"name": "bin", "path": "src/bin", "kind": "directory", "size": null},
            ], "next_cursor": "00ff", "incomplete": false}),
        );
        response::<FileSearch>(
            "file.search",
            json!({"type": "file_search", "results": [
                {"name": "link", "path": "link", "kind": "symlink", "size": null},
            ], "next_cursor": null, "incomplete": true}),
        );
        response::<FilePreview>(
            "file.preview",
            json!({"type": "file_preview", "path": "a.txt", "kind": "text", "mime": "text/plain",
                "text": "hi", "size": 2, "truncated": false}),
        );
        response::<FilePreview>(
            "file.preview",
            json!({"type": "file_preview", "path": "a.png", "kind": "image", "mime": "image/png",
                "bytes_base64": "iVBORw0KGgo=", "size": 8, "truncated": false}),
        );
        response::<FilePreview>(
            "file.preview",
            json!({"type": "file_preview", "path": "a.html", "kind": "unsupported",
                "size": 300000, "truncated": true}),
        );
    }
}
