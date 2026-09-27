//! Pure bundle validation: `SKILL.md` frontmatter, path rules, limits and the
//! content hash. Nothing here touches the filesystem.
//!
//! The name and description rules follow the Agent Skills specification
//! (agentskills.io/specification, read 2026-09-27).
use ade_core::contract::skills::{SkillFile, SkillManifest};
use sha2::{Digest, Sha256};

pub const SKILL_FILE: &str = "SKILL.md";
pub const MAX_FILES: usize = 1000;
pub const MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_SKILL_FILE_BYTES: u64 = 1024 * 1024;
pub const MAX_DEPTH: usize = 16;
const MAX_PATH_BYTES: usize = 1024;
const HASH_DOMAIN: &str = "ade-skill-bundle-v1\n";

/// Entries a bundle read skips and records in its provenance.
pub fn excluded_entry(name: &str) -> bool {
    matches!(name, ".git" | ".DS_Store")
}

/// One file read from a bundle directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub path: String,
    pub data: Vec<u8>,
    pub executable: bool,
}

/// A validated bundle: its manifest and the bytes of every listed file, in
/// manifest order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bundle {
    pub manifest: SkillManifest,
    pub data: Vec<Vec<u8>>,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The bundle hash covers each file's path, mode and content, in path order,
/// so renaming, re-moding or editing any file changes it.
pub fn content_hash(files: &[SkillFile]) -> String {
    let mut hash = Sha256::new();
    hash.update(HASH_DOMAIN.as_bytes());
    for file in files {
        let mode = if file.executable { "755" } else { "644" };
        hash.update(format!("{}\0{mode}\0{}\n", file.path, file.sha256).as_bytes());
    }
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A skill name: 1 to 64 of `a-z`, `0-9` and `-`, without a leading,
/// trailing or doubled hyphen.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
}

/// A relative, `/`-separated bundle path with no empty, `.` or `..` part and
/// no control characters.
pub fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= MAX_PATH_BYTES
        && !path.chars().any(char::is_control)
        && !path.contains('\\')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// The frontmatter fields the catalog reads. Other keys are allowed and kept
/// only in the file itself.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Frontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
    pub license: Option<String>,
    pub compatibility: Option<String>,
}

const READ_KEYS: &[&str] = &["name", "description", "license", "compatibility"];

/// Reads the YAML frontmatter of `SKILL.md`. It supports the scalar forms
/// skills use for the fields it reads: plain (with indented continuation
/// lines), single- and double-quoted on one line, and `|` or `>` block
/// scalars. Anything else in a read field fails closed rather than guessing.
pub fn frontmatter(text: &str) -> Result<Frontmatter, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return Err("SKILL.md must start with a --- frontmatter line".into());
    }
    let mut body = Vec::new();
    let mut closed = false;
    for line in lines {
        let trimmed = line.trim_end();
        if trimmed == "---" || trimmed == "..." {
            closed = true;
            break;
        }
        body.push(line.trim_end_matches('\r'));
    }
    if !closed {
        return Err("SKILL.md frontmatter is not closed".into());
    }
    let mut fields = Frontmatter::default();
    let mut seen = Vec::new();
    let mut index = 0;
    while index < body.len() {
        let line = body[index];
        index += 1;
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        if line.starts_with('\t') {
            return Err("SKILL.md frontmatter uses a tab for indentation".into());
        }
        if line.starts_with(' ') {
            return Err("SKILL.md frontmatter has an unexpected indented line".into());
        }
        let Some((key, rest)) = line.split_once(':') else {
            return Err(format!("SKILL.md frontmatter line is not a key: {line}"));
        };
        let key = key.trim();
        if seen.contains(&key) {
            return Err(format!("SKILL.md frontmatter repeats {key}"));
        }
        seen.push(key);
        // Indented lines that follow belong to this key.
        let start = index;
        while index < body.len()
            && (body[index].trim().is_empty() || body[index].starts_with([' ', '\t']))
        {
            index += 1;
        }
        let continuation = &body[start..index];
        if !READ_KEYS.contains(&key) {
            continue;
        }
        let value = scalar(key, rest.trim(), continuation)?;
        let slot = match key {
            "name" => &mut fields.name,
            "description" => &mut fields.description,
            "license" => &mut fields.license,
            _ => &mut fields.compatibility,
        };
        *slot = Some(value);
    }
    Ok(fields)
}

fn scalar(key: &str, head: &str, continuation: &[&str]) -> Result<String, String> {
    let lines = || {
        continuation
            .iter()
            .map(|line| line.trim())
            .collect::<Vec<_>>()
    };
    if let Some(indicator) = head.strip_prefix(['|', '>']) {
        let indicator = indicator.split('#').next().unwrap_or("").trim();
        if !indicator
            .chars()
            .all(|c| matches!(c, '-' | '+' | '1'..='9'))
        {
            return Err(format!("SKILL.md {key} has an unsupported block indicator"));
        }
        let lines = lines();
        let text = if head.starts_with('|') {
            lines.join("\n")
        } else {
            // Folding: single line breaks become spaces, blank lines stay breaks.
            let mut out = String::new();
            let mut blank = false;
            for line in lines {
                if line.is_empty() {
                    out.push('\n');
                    blank = true;
                } else {
                    if !out.is_empty() && !blank {
                        out.push(' ');
                    }
                    out.push_str(line);
                    blank = false;
                }
            }
            out
        };
        return Ok(text.trim().to_owned());
    }
    let has_more = continuation.iter().any(|line| !line.trim().is_empty());
    if head.starts_with(['"', '\'']) {
        if has_more {
            return Err(format!("SKILL.md {key} is a multi-line quoted string"));
        }
        return quoted(key, head);
    }
    if head.is_empty() {
        return Err(format!("SKILL.md {key} must be a string"));
    }
    if head.starts_with(['[', '{', '&', '*', '!', '@', '`']) {
        return Err(format!("SKILL.md {key} must be a plain string"));
    }
    let first = strip_comment(head);
    if !has_more {
        return Ok(first.to_owned());
    }
    // A plain scalar may continue on indented lines; they fold with spaces.
    let mut parts = vec![first.to_owned()];
    for line in lines() {
        if line.is_empty() {
            parts.push("\n".into());
        } else if line.contains(": ") || line.starts_with("- ") {
            return Err(format!("SKILL.md {key} must be a string"));
        } else {
            parts.push(strip_comment(line).to_owned());
        }
    }
    Ok(parts.join(" ").replace(" \n ", "\n").trim().to_owned())
}

fn strip_comment(text: &str) -> &str {
    text.find(" #").map_or(text, |at| &text[..at]).trim()
}

fn quoted(key: &str, head: &str) -> Result<String, String> {
    let quote = head.chars().next().unwrap_or('"');
    let mut out = String::new();
    let mut chars = head[1..].char_indices();
    while let Some((at, c)) = chars.next() {
        if c == quote {
            if quote == '\'' && head[1 + at + 1..].starts_with('\'') {
                out.push('\'');
                chars.next();
                continue;
            }
            let rest = head[1 + at + 1..].trim();
            if !rest.is_empty() && !rest.starts_with('#') {
                return Err(format!("SKILL.md {key} has text after its closing quote"));
            }
            return Ok(out);
        }
        if quote == '"' && c == '\\' {
            match chars.next().map(|(_, c)| c) {
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some('/') => out.push('/'),
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                _ => return Err(format!("SKILL.md {key} uses an unsupported escape")),
            }
            continue;
        }
        out.push(c);
    }
    Err(format!("SKILL.md {key} has no closing quote"))
}

/// Validates the files read from a skill directory named `entry` and builds
/// its manifest. The directory name must equal the skill name, as providers
/// look skills up by directory.
pub fn validate(entry: &str, mut files: Vec<Entry>) -> Result<Bundle, String> {
    if files.len() > MAX_FILES {
        return Err(format!("Bundle has more than {MAX_FILES} files"));
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let mut total = 0u64;
    for pair in files.windows(2) {
        if pair[0].path == pair[1].path {
            return Err(format!("Bundle lists {} twice", pair[0].path));
        }
    }
    for file in &files {
        if !valid_path(&file.path) {
            return Err(format!("Bundle path is invalid: {:?}", file.path));
        }
        total += file.data.len() as u64;
        if total > MAX_TOTAL_BYTES {
            return Err("Bundle exceeds 32 MiB".into());
        }
    }
    let skill = files
        .iter()
        .find(|file| file.path == SKILL_FILE)
        .ok_or("Bundle has no SKILL.md at its root")?;
    if skill.data.len() as u64 > MAX_SKILL_FILE_BYTES {
        return Err("SKILL.md exceeds 1 MiB".into());
    }
    let text = std::str::from_utf8(&skill.data).map_err(|_| "SKILL.md is not UTF-8")?;
    let fields = frontmatter(text)?;
    let name = fields.name.ok_or("SKILL.md frontmatter has no name")?;
    if !valid_name(&name) {
        return Err(format!(
            "Skill name {name:?} must be 1-64 lowercase letters, digits and single hyphens"
        ));
    }
    if name != entry {
        return Err(format!(
            "Skill name {name:?} does not match its directory {entry:?}"
        ));
    }
    let description = fields
        .description
        .ok_or("SKILL.md frontmatter has no description")?;
    let count = description.chars().count();
    if count == 0 || count > 1024 {
        return Err("Skill description must be 1-1024 characters".into());
    }
    if let Some(compatibility) = &fields.compatibility {
        let count = compatibility.chars().count();
        if count == 0 || count > 500 {
            return Err("Skill compatibility must be 1-500 characters".into());
        }
    }
    let manifest_files: Vec<SkillFile> = files
        .iter()
        .map(|file| SkillFile {
            path: file.path.clone(),
            size: file.data.len() as u64,
            sha256: sha256_hex(&file.data),
            executable: file.executable,
        })
        .collect();
    let manifest = SkillManifest {
        name,
        description,
        license: fields.license,
        compatibility: fields.compatibility,
        content_hash: content_hash(&manifest_files),
        files: manifest_files,
        total_bytes: total,
    };
    Ok(Bundle {
        manifest,
        data: files.into_iter().map(|file| file.data).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, data: &str) -> Entry {
        Entry {
            path: path.into(),
            data: data.as_bytes().to_vec(),
            executable: false,
        }
    }

    fn skill(name: &str, description: &str) -> Entry {
        entry(
            SKILL_FILE,
            &format!("---\nname: {name}\ndescription: {description}\n---\n# Body\n"),
        )
    }

    #[test]
    fn names_follow_the_agent_skills_rules() {
        for good in ["pdf", "pdf-processing", "a1", "x"] {
            assert!(valid_name(good), "{good}");
        }
        let long = "a".repeat(65);
        for bad in [
            "",
            "PDF",
            "-pdf",
            "pdf-",
            "pdf--x",
            "pdf_x",
            "pdf x",
            long.as_str(),
        ] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn paths_stay_inside_the_bundle() {
        assert!(valid_path("SKILL.md"));
        assert!(valid_path("scripts/run.sh"));
        for bad in ["", "/abs", "a//b", "./a", "a/../b", "..", "a\\b", "a\nb"] {
            assert!(!valid_path(bad), "{bad:?}");
        }
    }

    #[test]
    fn frontmatter_reads_plain_quoted_and_block_scalars() {
        let text = "---\nname: pdf\ndescription: >\n  Extracts text\n  from PDFs.\n\n  Use for forms.\nlicense: 'Apache-2.0 ''x'''\ncompatibility: \"Needs \\\"qpdf\\\"\" # note\nmetadata:\n  author: me\n---\nbody";
        let fields = frontmatter(text).unwrap();
        assert_eq!(fields.name.as_deref(), Some("pdf"));
        assert_eq!(
            fields.description.as_deref(),
            Some("Extracts text from PDFs.\nUse for forms.")
        );
        assert_eq!(fields.license.as_deref(), Some("Apache-2.0 'x'"));
        assert_eq!(fields.compatibility.as_deref(), Some("Needs \"qpdf\""));

        let literal = frontmatter("---\nname: a\ndescription: |-\n  one\n  two\n---\n").unwrap();
        assert_eq!(literal.description.as_deref(), Some("one\ntwo"));
        let folded =
            frontmatter("---\nname: a # c\ndescription: Reads\n  long text\n---\n").unwrap();
        assert_eq!(folded.name.as_deref(), Some("a"));
        assert_eq!(folded.description.as_deref(), Some("Reads long text"));
        let crlf = frontmatter("---\r\nname: a\r\ndescription: d\r\n---\r\n").unwrap();
        assert_eq!(crlf.description.as_deref(), Some("d"));
    }

    #[test]
    fn frontmatter_fails_closed_on_forms_it_cannot_read() {
        for (text, problem) in [
            ("name: a\n", "must start"),
            ("---\nname: a\n", "not closed"),
            ("---\nname: a\nname: b\n---\n", "repeats"),
            ("---\nname: [a]\n---\n", "plain string"),
            ("---\ndescription:\n  key: value\n---\n", "must be a string"),
            ("---\ndescription: \"open\n---\n", "no closing quote"),
            (
                "---\ndescription: \"a\" b\n---\n",
                "after its closing quote",
            ),
            ("---\ndescription: 'a\n  b'\n---\n", "multi-line quoted"),
            ("---\n\tname: a\n---\n", "tab"),
            ("---\n  name: a\n---\n", "indented"),
        ] {
            let error = frontmatter(text).unwrap_err();
            assert!(error.contains(problem), "{text:?}: {error}");
        }
    }

    #[test]
    fn validate_builds_a_sorted_manifest_and_stable_hash() {
        let mut script = entry("scripts/run.sh", "echo hi");
        script.executable = true;
        let bundle = validate("pdf", vec![script.clone(), skill("pdf", "Reads PDFs.")]).unwrap();
        let manifest = &bundle.manifest;
        assert_eq!(manifest.name, "pdf");
        assert_eq!(manifest.description, "Reads PDFs.");
        assert_eq!(
            manifest
                .files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            ["SKILL.md", "scripts/run.sh"]
        );
        assert_eq!(bundle.data[1], b"echo hi");
        assert_eq!(
            manifest.total_bytes,
            manifest.files.iter().map(|f| f.size).sum::<u64>()
        );
        assert_eq!(manifest.content_hash.len(), 64);

        let again = validate("pdf", vec![skill("pdf", "Reads PDFs."), script.clone()]).unwrap();
        assert_eq!(again.manifest.content_hash, manifest.content_hash);
        let mut plain = script.clone();
        plain.executable = false;
        let remoded = validate("pdf", vec![skill("pdf", "Reads PDFs."), plain]).unwrap();
        assert_ne!(remoded.manifest.content_hash, manifest.content_hash);
        let mut moved = script;
        moved.path = "scripts/go.sh".into();
        let renamed = validate("pdf", vec![skill("pdf", "Reads PDFs."), moved]).unwrap();
        assert_ne!(renamed.manifest.content_hash, manifest.content_hash);
    }

    #[test]
    fn validate_rejects_incomplete_or_mismatched_bundles() {
        let cases: Vec<(&str, Vec<Entry>, &str)> = vec![
            ("pdf", vec![entry("README.md", "x")], "no SKILL.md"),
            ("pdf", vec![skill("other", "d")], "does not match"),
            ("PDF", vec![skill("PDF", "d")], "lowercase"),
            (
                "pdf",
                vec![entry(SKILL_FILE, "---\nname: pdf\n---\n")],
                "no description",
            ),
            (
                "pdf",
                vec![skill("pdf", &"d".repeat(1025))],
                "1-1024 characters",
            ),
            (
                "pdf",
                vec![skill("pdf", "d"), entry("../escape", "x")],
                "path is invalid",
            ),
            (
                "pdf",
                vec![skill("pdf", "d"), entry("a", "x"), entry("a", "y")],
                "twice",
            ),
            (
                "pdf",
                vec![Entry {
                    path: SKILL_FILE.into(),
                    data: vec![0xff, 0xfe],
                    executable: false,
                }],
                "UTF-8",
            ),
        ];
        for (name, files, problem) in cases {
            let error = validate(name, files).unwrap_err();
            assert!(error.contains(problem), "{problem}: {error}");
        }
        let many = (0..=MAX_FILES)
            .map(|index| entry(&format!("f{index}"), ""))
            .collect();
        assert!(validate("pdf", many).unwrap_err().contains("more than"));
        let big = Entry {
            path: "big.bin".into(),
            data: vec![0; MAX_TOTAL_BYTES as usize + 1],
            executable: false,
        };
        assert!(
            validate("pdf", vec![skill("pdf", "d"), big])
                .unwrap_err()
                .contains("32 MiB")
        );
    }
}
