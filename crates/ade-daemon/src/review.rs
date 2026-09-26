//! Daemon-owned review: Git is authoritative; clients send intent, never shell commands.
//! References: Orca's literal pathspecs/per-file reads, T3's bounded diffs, Herdr's
//! demand-driven refresh, Paseo's unborn-index handling, Ghostex's typed operations.
use crate::{
    model::{new_id, now_ms},
    worktrees::{self, ReviewGuard, Worktrees},
};
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Component, Path},
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

type StatusCache = Arc<Mutex<Option<(Instant, Value)>>>;

pub struct Review {
    worktrees: Arc<Worktrees>,
    db: Mutex<Connection>,
    // A short shared cache collapses refreshes from multiple windows. No polling
    // or repository scan exists when no Changes window requests it.
    cache: Mutex<std::collections::HashMap<String, StatusCache>>,
}
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty() && !s.contains('\0') && s.len() <= 16384)
        .with_context(|| format!("Missing or invalid {key}"))
}
fn fingerprint(parts: &[&[u8]]) -> String {
    let mut h = DefaultHasher::new();
    for part in parts {
        part.hash(&mut h);
    }
    format!("{:016x}", h.finish())
}
fn path_arg(path: &str) -> Result<()> {
    ensure!(
        !path.is_empty()
            && !path.contains('\0')
            && path.len() <= 4096
            && Path::new(path)
                .components()
                .all(|c| matches!(c, Component::Normal(_))),
        "Invalid repository-relative path"
    );
    Ok(())
}
struct Git<'a> {
    root: &'a str,
    guard: &'a ReviewGuard,
    binding: (u64, u64),
    common_binding: Option<(u64, u64)>,
}
impl Git<'_> {
    fn ensure_root_bound(&self) -> Result<()> {
        ensure!(
            fs::metadata(self.root)
                .is_ok_and(|item| { item.is_dir() && (item.dev(), item.ino()) == self.binding }),
            ade_core::error::NeedsRebind
        );
        Ok(())
    }
    fn run(&self, args: &[&str], input: Option<Vec<u8>>, timeout: u64) -> Result<Value> {
        let mut c = Command::new(std::env::current_exe()?);
        c.args(["--worktree-worker", "git"]);
        worktrees::neutral(&mut c);
        c.current_dir(self.root)
            .env("ADE_EXPECT_CWD_DEV", self.binding.0.to_string())
            .env("ADE_EXPECT_CWD_INO", self.binding.1.to_string())
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_LITERAL_PATHSPECS", "1")
            .env("GIT_EDITOR", "true")
            .args(["-c", "color.ui=false", "-c", "core.quotePath=true"])
            .args(args);
        if let Some((device, inode)) = self.common_binding {
            c.env("ADE_EXPECT_GIT_COMMON_DEV", device.to_string())
                .env("ADE_EXPECT_GIT_COMMON_INO", inode.to_string());
        }
        if cfg!(debug_assertions)
            && std::env::var("ADE_E2E_WORKER_PAUSE_ENABLED").as_deref() == Ok("1")
            && let Ok(directory) = std::env::var("ADE_E2E_REVIEW_PAUSE_DIR")
        {
            c.env_remove("ADE_E2E_REVIEW_PAUSE_DIR")
                .env("ADE_E2E_WORKER_PAUSE_DIR", directory);
        }
        worktrees::run_input(c, timeout, Some(&self.guard.file), input)
    }
    fn text(&self, args: &[&str]) -> Result<String> {
        let out = self.run(args, None, 15)?;
        Ok(worktrees::successful(&out)?.to_owned())
    }
    fn index_token(&self, head: &str) -> Result<String> {
        let index = self.text(&["rev-parse", "--path-format=absolute", "--git-path", "index"])?;
        let mut h = DefaultHasher::new();
        head.hash(&mut h);
        match fs::File::open(index.trim_end()) {
            Ok(mut f) => {
                let mut b = [0; 65536];
                loop {
                    let n = f.read(&mut b)?;
                    if n == 0 {
                        break;
                    }
                    h.write(&b[..n]);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                "unborn".hash(&mut h);
            }
            Err(e) => return Err(e.into()),
        }
        Ok(format!("{:016x}", h.finish()))
    }
    fn status(&self) -> Result<Value> {
        self.ensure_root_bound()?;
        let raw = self.text(&[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--no-ahead-behind",
            "--untracked-files=all",
            "--no-renames",
        ])?;
        let mut state = parse_status(&raw)?;
        let head = format!("{}:{}", state["head"], state["branch"]);
        let token = self.index_token(&head)?;
        let mut stamps = String::new();
        for file in state["files"].as_array().unwrap() {
            let path = file["path"].as_str().unwrap();
            if let Ok(m) = fs::symlink_metadata(Path::new(self.root).join(path)) {
                use std::os::unix::fs::MetadataExt;
                stamps.push_str(&format!(
                    "{}:{}:{}:{}:{}:{};",
                    m.ino(),
                    m.len(),
                    m.mtime(),
                    m.mtime_nsec(),
                    m.ctime(),
                    m.ctime_nsec()
                ));
            }
        }
        self.ensure_root_bound()?;
        state["index_token"] = json!(token);
        state["revision"] = json!(fingerprint(&[
            raw.as_bytes(),
            token.as_bytes(),
            stamps.as_bytes()
        ]));
        state["type"] = json!("review_status");
        state["root"] = json!(self.root);
        Ok(state)
    }
    fn diff(&self, path: &str, staged: bool) -> Result<Value> {
        path_arg(path)?;
        let state = self.status()?;
        let file = state["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["path"] == path)
            .context("File is no longer changed; refresh")?;
        ensure!(
            file[if staged { "staged" } else { "unstaged" }] == true,
            "This file has no changes in that area"
        );
        let mut args = vec![
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-renames",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--unified=3",
        ];
        if staged {
            args.push("--cached");
        }
        let untracked = file["untracked"] == true;
        if untracked {
            args.extend(["--no-index", "--", "/dev/null", path]);
        } else {
            args.extend(["--", path]);
        }
        let out = self.run(&args, None, 15)?;
        if !(untracked && out["exit_code"] == 1) {
            worktrees::successful(&out)?;
        }
        let patch = out["stdout"].as_str().context("Missing diff")?;
        let (header, hunks) = split_patch(patch);
        let special = file["conflict"] == true
            || patch.contains("Binary files ")
            || patch.contains("GIT binary patch")
            || header.lines().any(|l| {
                l.starts_with("old mode ")
                    || l.starts_with("new mode ")
                    || l.contains("160000")
                    || l.contains("120000")
            })
            || hunks.is_empty();
        // Do not keep/render a second complete copy of a large patch in each window.
        let token = fingerprint(&[
            patch.as_bytes(),
            state["index_token"].as_str().unwrap().as_bytes(),
        ]);
        Ok(
            json!({"type":"review_diff","path":path,"staged":staged,"token":token,
            "header":header,"hunks":hunks,"hunk_actions":!special,"conflict":file["conflict"],"binary":patch.contains("Binary files "),"bytes":patch.len()}),
        )
    }
}
fn parse_status(raw: &str) -> Result<Value> {
    let mut files = Vec::new();
    let mut branch = "";
    let mut head = "";
    let mut records = raw.split('\0');
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if let Some(v) = record.strip_prefix("# branch.head ") {
            branch = v;
            continue;
        }
        if let Some(v) = record.strip_prefix("# branch.oid ") {
            head = v;
            continue;
        }
        if record.starts_with('#') {
            continue;
        }
        let (path, xy, sub, conflict, untracked) = if let Some(path) = record.strip_prefix("? ") {
            (path, "??", "N...", false, true)
        } else {
            let n = match record.as_bytes()[0] {
                b'1' => 9,
                b'2' => 10,
                b'u' => 11,
                _ => bail!("Unsupported Git status entry"),
            };
            let fields: Vec<_> = record.splitn(n, ' ').collect();
            ensure!(fields.len() == n, "Malformed Git status");
            if record.starts_with('2') {
                records.next().context("Missing rename source")?;
            }
            (
                fields[n - 1],
                fields[1],
                fields[2],
                record.starts_with('u'),
                false,
            )
        };
        path_arg(path)?;
        ensure!(xy.len() == 2, "Malformed status code");
        files.push(json!({"path":path,"code":xy,"staged":!untracked && !conflict && xy.as_bytes()[0]!=b'.',
            "unstaged":untracked || conflict || xy.as_bytes()[1]!=b'.',"conflict":conflict,"untracked":untracked,"submodule":sub!="N..."}));
        ensure!(
            files.len() <= 20000,
            "More than 20,000 changed files; narrow the repository before using Changes"
        );
    }
    Ok(
        json!({"files":files,"branch":branch,"head":head,"conflicts":files.iter().filter(|f|f["conflict"]==true).count()}),
    )
}
fn split_patch(patch: &str) -> (String, Vec<String>) {
    let mut header = String::new();
    let mut hunks: Vec<String> = Vec::new();
    for line in patch.split_inclusive('\n') {
        if line.starts_with("@@ ") {
            hunks.push(String::new());
        }
        if let Some(hunk) = hunks.last_mut() {
            hunk.push_str(line);
        } else {
            header.push_str(line);
        }
    }
    (header, hunks)
}
impl Review {
    pub fn open(path: &Path, worktrees: Arc<Worktrees>) -> Result<Arc<Self>> {
        let db = Connection::open(path)?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "FULL")?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, root TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL);")?;
        db.execute("UPDATE jobs SET result=json_set(result,'$.status','interrupted','$.error','Daemon stopped during Git operation. Refresh and inspect Git history before retrying; this request will not run again.') WHERE json_extract(result,'$.status')='running'",[])?;
        Ok(Arc::new(Self {
            worktrees,
            db: Mutex::new(db),
            cache: Mutex::new(Default::default()),
        }))
    }
    fn job(&self, root: &str, id: &str, request: Option<&Value>) -> Result<Option<Value>> {
        let db = self.db.lock().unwrap();
        let row: Option<(String, String, String)> = db
            .query_row(
                "SELECT root,request,result FROM jobs WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((old_root, old_request, result)) = row {
            ensure!(old_root == root, "Operation belongs to another workspace");
            if let Some(request) = request {
                ensure!(
                    serde_json::from_str::<Value>(&old_request)? == *request,
                    "Request ID was used for different parameters"
                );
            }
            return Ok(Some(
                json!({"type":"review_operation","operation":serde_json::from_str::<Value>(&result)?}),
            ));
        }
        Ok(None)
    }
    pub fn command(
        self: &Arc<Self>,
        root: &str,
        workspace_binding: (u64, u64),
        common_binding: Option<(u64, u64)>,
        request: &Value,
    ) -> Result<Value> {
        let metadata = fs::metadata(root)?;
        ensure!(
            metadata.is_dir() && (metadata.dev(), metadata.ino()) == workspace_binding,
            ade_core::error::NeedsRebind
        );
        let canonical = worktrees::git(root, &["rev-parse", "--show-toplevel"])?;
        let git_root = canonical.as_str();
        let metadata = fs::metadata(git_root)?;
        let binding = (metadata.dev(), metadata.ino());
        ensure!(
            metadata.is_dir()
                && fs::metadata(root).is_ok_and(|item| {
                    item.is_dir() && (item.dev(), item.ino()) == workspace_binding
                }),
            ade_core::error::NeedsRebind
        );
        let root = git_root;
        let op = string(request, "op")?;
        if op == "review.operation" {
            return self
                .job(root, string(request, "request_id")?, None)?
                .context("Unknown review operation");
        }
        if op == "review.status" {
            // Coalesce per workspace; one slow repository never holds the cache
            // map or blocks reads for another repository.
            let entry = {
                let mut cache = self.cache.lock().unwrap();
                if cache.len() >= 64 && !cache.contains_key(root) {
                    cache.clear();
                }
                cache
                    .entry(root.into())
                    .or_insert_with(|| Arc::new(Mutex::new(None)))
                    .clone()
            };
            let mut cached = entry.lock().unwrap();
            if let Some((time, value)) = cached.as_ref()
                && time.elapsed() < Duration::from_millis(750)
                && request["force"] != true
            {
                return Ok(value.clone());
            }
            let guard = self.worktrees.review_guard(root)?;
            let state = Git {
                root,
                guard: &guard,
                binding,
                common_binding,
            }
            .status()?;
            *cached = Some((Instant::now(), state.clone()));
            return Ok(state);
        }
        if op == "review.diff" {
            let guard = self.worktrees.review_guard(root)?;
            return Git {
                root,
                guard: &guard,
                binding,
                common_binding,
            }
            .diff(string(request, "path")?, request["staged"] == true);
        }
        ensure!(
            [
                "review.stage",
                "review.unstage",
                "review.hunk",
                "review.commit"
            ]
            .contains(&op),
            "Unknown review operation"
        );
        let id = string(request, "request_id")?;
        ensure!(id.len() <= 256, "Request ID too long");
        if let Some(job) = self.job(root, id, Some(request))? {
            return Ok(job);
        }
        let guard = self.worktrees.review_guard(root)?;
        if let Some(job) = self.job(root, id, Some(request))? {
            return Ok(job);
        }
        let job = json!({"id":id,"status":"running","started_at":now_ms(),"op":op});
        self.db.lock().unwrap().execute(
            "INSERT INTO jobs(id,root,request,result) VALUES(?1,?2,?3,?4)",
            params![id, root, request.to_string(), job.to_string()],
        )?;
        let hub = self.clone();
        let root = root.to_owned();
        let request = request.clone();
        let mut completed = job.clone();
        std::thread::spawn(move || {
            let git = Git {
                root: &root,
                guard: &guard,
                binding,
                common_binding,
            };
            let result = hub.mutate(&git, &request);
            match result {
                Ok(value) => {
                    completed["status"] = json!("succeeded");
                    completed["result"] = value;
                }
                Err(e) => {
                    completed["status"] = json!("failed");
                    let failure = ade_core::error::error_envelope(e);
                    completed["error"] = failure["message"].clone();
                    completed["code"] = failure["code"].clone();
                    completed["recovery"] = failure["recovery"].clone();
                }
            }
            completed["finished_at"] = json!(now_ms());
            if let Err(e) = hub.db.lock().unwrap().execute(
                "UPDATE jobs SET result=?1 WHERE id=?2",
                params![
                    completed.to_string(),
                    request["request_id"].as_str().unwrap()
                ],
            ) {
                eprintln!("Could not persist Git receipt: {e}");
            }
            if cfg!(debug_assertions)
                && std::env::var("ADE_E2E_WORKER_PAUSE_ENABLED").as_deref() == Ok("1")
                && let Ok(directory) = std::env::var("ADE_E2E_REVIEW_PAUSE_DIR")
            {
                let _ = fs::write(Path::new(&directory).join("done"), completed.to_string());
            }
            drop(guard);
            hub.cache.lock().unwrap().remove(&root);
        });
        Ok(json!({"type":"review_operation","operation":job}))
    }
    fn mutate(&self, git: &Git, request: &Value) -> Result<Value> {
        let state = git.status()?;
        let op = string(request, "op")?;
        if op == "review.commit" {
            let message = string(request, "message")?;
            ensure!(!message.trim().is_empty(), "Commit message is empty");
            ensure!(
                request["index_token"] == state["index_token"],
                "Staged changes or HEAD changed. Review them again before committing."
            );
            ensure!(
                state["conflicts"] == 0,
                "Resolve and stage conflicting files before committing"
            );
            ensure!(
                state["files"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|f| f["staged"] == true),
                "There are no staged changes to commit"
            );
            // Explicit user action: Git owns identity, hooks and signing policy. No
            // add-all, amend, --no-verify, identity overrides, or automatic retry.
            let out = git.run(
                &["commit", "--file=-"],
                Some(message.as_bytes().to_vec()),
                120,
            )?;
            worktrees::successful(&out)?;
            return Ok(
                json!({"head":git.text(&["rev-parse","HEAD"])?.trim(),"output":out["stdout"]}),
            );
        }
        let path = string(request, "path")?;
        path_arg(path)?;
        let file = state["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["path"] == path)
            .context("File is no longer changed; refresh")?;
        if op == "review.hunk" {
            ensure!(
                file["conflict"] != true,
                "Resolve conflicts before staging hunks"
            );
            let staged = request["staged"] == true;
            let diff = git.diff(path, staged)?;
            ensure!(
                diff["token"] == request["token"],
                "Diff changed since review; reload it before applying a hunk"
            );
            ensure!(
                diff["hunk_actions"] == true,
                "This change must be staged or unstaged as a whole file"
            );
            let index = request["hunk"].as_u64().context("Missing hunk index")? as usize;
            let hunk = diff["hunks"]
                .as_array()
                .and_then(|h| h.get(index))
                .and_then(Value::as_str)
                .context("Unknown hunk")?;
            let patch = format!("{}{hunk}", diff["header"].as_str().unwrap()).into_bytes();
            let mut args = vec!["apply", "--cached", "--whitespace=nowarn"];
            if staged {
                args.push("--reverse");
            }
            args.push("-");
            let out = git.run(&args, Some(patch), 30)?;
            worktrees::successful(&out)?;
        } else {
            ensure!(
                request["revision"] == state["revision"],
                "Changes moved since review; refresh before staging or unstaging"
            );
            let args = if op == "review.stage" {
                ensure!(file["unstaged"] == true, "File has no unstaged changes");
                vec!["add", "--", path]
            } else if state["head"] == "(initial)" {
                ensure!(file["staged"] == true, "File has no staged changes");
                vec!["rm", "--cached", "-f", "--", path]
            } else {
                ensure!(file["staged"] == true, "File has no staged changes");
                vec!["restore", "--staged", "--", path]
            };
            let out = git.run(&args, None, 30)?;
            worktrees::successful(&out)?;
        }
        Ok(json!({"changed":path,"action":op,"receipt":new_id("git-result")}))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn status_preserves_literal_paths_and_conflicts() {
        let s=parse_status("# branch.head main\0# branch.oid abc\x001 MM N... 100644 100644 100644 a b [x]\nname\0? --new\0u UU N... 100644 100644 100644 100644 a b c conflict\0").unwrap();
        assert_eq!(s["files"][0]["path"], "[x]\nname");
        assert_eq!(s["files"][0]["staged"], true);
        assert_eq!(s["files"][0]["unstaged"], true);
        assert_eq!(s["conflicts"], 1);
    }
    #[test]
    fn hunks_keep_no_newline_markers() {
        let (header, hunks) = split_patch(
            "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n@@ -12 +12 @@\n-c\n+d\n",
        );
        assert!(header.ends_with("+++ b/a\n"));
        assert_eq!(hunks.len(), 2);
        assert!(hunks[0].contains("\\ No newline"));
    }
    #[test]
    fn paths_cannot_escape() {
        for p in ["../a", "/a", "a/../b", ""] {
            assert!(path_arg(p).is_err());
        }
        for p in ["[a]", ":(glob)*", "--file", "space name"] {
            assert!(path_arg(p).is_ok());
        }
    }
}
