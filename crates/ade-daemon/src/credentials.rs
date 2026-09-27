//! Resolves and stores credential references (architecture section 7).
//!
//! A reference names an environment variable of this daemon or a Keychain
//! generic password. Values are read only when a process that needs them is
//! launched, and are never written to a database, a reply or a log.
//!
//! Generic passwords live in a [`SecretStore`]. Production uses the macOS
//! Keychain. A debug build started with `ADE_SECRET_STORE=file` uses an
//! encrypted file instead, so tests never reach the Keychain; a release build
//! refuses that setting and does not contain the file store at all.
//!
//! Items ADE creates live under [`ADE_KEYCHAIN_SERVICE`] with an account of
//! `<profile owner>/<scope>/<random>`. The owner is an ID the profile's data
//! directory holds and a backup never copies, so a restored or copied profile
//! owns none of the original's items: it neither reuses nor deletes them.
//! `ADE_KEYCHAIN`, when set, is the path of the only keychain ADE reads and
//! writes; otherwise ADE uses the user's default keychain and search list.
//! The Keychain never shows a prompt to this process: a locked keychain or an
//! item that needs permission is an error.
use ade_core::credentials::{ADE_KEYCHAIN_SERVICE, CredentialReference};
use anyhow::{Context, Result, bail};
use std::collections::BTreeMap;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::OnceLock;

/// The most bytes ADE stores or reads for one secret.
const MAX_SECRET_BYTES: usize = 8 * 1024;
/// The file in the data directory that holds the profile's owner ID.
pub const OWNER_FILE: &str = "secret-owner";

/// Where generic passwords live. `find` fails when the item does not exist;
/// `add` fails when it already does; `delete` of a missing item succeeds.
pub trait SecretStore: Send + Sync {
    fn find(&self, service: &str, account: &str) -> Result<Vec<u8>>;
    fn add(&self, service: &str, account: &str, value: &[u8]) -> Result<()>;
    fn delete(&self, service: &str, account: &str) -> Result<()>;
}

/// The production store: the macOS Keychain, unchanged.
struct KeychainStore;

impl SecretStore for KeychainStore {
    fn find(&self, service: &str, account: &str) -> Result<Vec<u8>> {
        keychain::find(service, account)
    }
    fn add(&self, service: &str, account: &str, value: &[u8]) -> Result<()> {
        keychain::add(service, account, value)
    }
    fn delete(&self, service: &str, account: &str) -> Result<()> {
        keychain::delete(service, account)
    }
}

/// Which store a daemon uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    Keychain,
    /// The test-only encrypted file store.
    File,
}

/// Decides the store from `ADE_SECRET_STORE`. Unset is the Keychain; `file`
/// is the test store, which a release build refuses so it never ships.
pub fn backend(setting: Option<&str>, release: bool) -> Result<Backend> {
    match setting {
        None => Ok(Backend::Keychain),
        Some("file") if release => bail!(
            "ADE_SECRET_STORE=file selects the test-only secret store, which a release build refuses"
        ),
        Some("file") => Ok(Backend::File),
        Some(other) => bail!("ADE_SECRET_STORE={other:?} names no secret store; leave it unset"),
    }
}

struct Profile {
    owner: String,
    store: Box<dyn SecretStore>,
}

static PROFILE: OnceLock<Profile> = OnceLock::new();

/// Chooses the secret store and reads the profile's owner ID. The daemon
/// calls it once before opening any store; until then every secret
/// operation fails rather than reaching a default.
pub fn init(data_dir: &Path) -> Result<()> {
    let setting = match std::env::var("ADE_SECRET_STORE") {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => bail!("ADE_SECRET_STORE is not valid UTF-8"),
    };
    let store: Box<dyn SecretStore> = match backend(setting.as_deref(), !cfg!(debug_assertions))? {
        Backend::Keychain => Box::new(KeychainStore),
        Backend::File => file_store()?,
    };
    let owner = owner_id(data_dir)?;
    PROFILE
        .set(Profile { owner, store })
        .map_err(|_| anyhow::anyhow!("The secret store is already chosen"))
}

#[cfg(debug_assertions)]
fn file_store() -> Result<Box<dyn SecretStore>> {
    Ok(Box::new(file::FileStore::from_env()?))
}

#[cfg(not(debug_assertions))]
fn file_store() -> Result<Box<dyn SecretStore>> {
    bail!("This build has no file secret store")
}

fn profile() -> Result<&'static Profile> {
    PROFILE
        .get()
        .context("The secret store has not been chosen for this process")
}

/// The owner ID in `data_dir`, made on first use. It is written to a
/// temporary file and linked into place, so a crash never leaves it empty and
/// two racing starts agree on one ID.
fn owner_id(data_dir: &Path) -> Result<String> {
    let path = data_dir.join(OWNER_FILE);
    if !path.exists() {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let temporary = data_dir.join(format!(".{OWNER_FILE}.{id}"));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .context("The profile's secret owner ID cannot be written")?;
        file.write_all(id.as_bytes())?;
        file.sync_all()?;
        drop(file);
        let linked = std::fs::hard_link(&temporary, &path);
        let _ = std::fs::remove_file(&temporary);
        match linked {
            Ok(()) => return Ok(id),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(error).context("The profile's secret owner ID cannot be written");
            }
        }
    }
    let id =
        std::fs::read_to_string(&path).context("The profile's secret owner ID cannot be read")?;
    anyhow::ensure!(
        id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "The profile's secret owner ID in {} is damaged",
        path.display()
    );
    Ok(id)
}

/// The value `reference` names now.
pub fn resolve(reference: &CredentialReference) -> Result<String> {
    reference.validate()?;
    match reference {
        CredentialReference::Env(name) => match std::env::var(name) {
            Ok(value) => Ok(value),
            Err(std::env::VarError::NotPresent) => {
                bail!("environment variable {name} is not set for the ADE daemon")
            }
            Err(std::env::VarError::NotUnicode(_)) => {
                bail!("environment variable {name} is not valid UTF-8")
            }
        },
        CredentialReference::Keychain { service, account } => {
            let bytes = profile()
                .and_then(|profile| profile.store.find(service, account))
                .with_context(|| format!("{} cannot be read", reference.describe()))?;
            anyhow::ensure!(
                bytes.len() <= MAX_SECRET_BYTES,
                "{} holds more than {MAX_SECRET_BYTES} bytes",
                reference.describe()
            );
            String::from_utf8(bytes)
                .map_err(|_| anyhow::anyhow!("{} is not valid UTF-8", reference.describe()))
        }
    }
}

/// Resolves every reference in `references`, keyed as given. The first that
/// cannot be resolved refuses the whole set, naming its key.
pub fn resolve_all(
    references: &BTreeMap<String, CredentialReference>,
    kind: &str,
) -> Result<BTreeMap<String, String>> {
    references
        .iter()
        .map(|(key, reference)| {
            resolve(reference)
                .map(|value| (key.clone(), value))
                .map_err(|error| anyhow::anyhow!("{kind} {key} cannot be resolved: {error:#}"))
        })
        .collect()
}

/// Moves `value` into a new item this profile owns and returns its
/// reference. `scope` names the owner, such as `service/<workspace>/<name>/<KEY>`.
pub fn store_new(scope: &str, value: &str) -> Result<CredentialReference> {
    anyhow::ensure!(
        value.len() <= MAX_SECRET_BYTES && !value.contains('\0'),
        "A secret value must be at most {MAX_SECRET_BYTES} bytes without NUL"
    );
    let profile = profile()?;
    let account = format!(
        "{}/{scope}/{}",
        profile.owner,
        uuid::Uuid::new_v4().simple()
    );
    profile
        .store
        .add(ADE_KEYCHAIN_SERVICE, &account, value.as_bytes())
        .context("The secret could not be stored in the Keychain")?;
    Ok(CredentialReference::Keychain {
        service: ADE_KEYCHAIN_SERVICE.into(),
        account,
    })
}

/// Whether this profile made the item `reference` names. An item another
/// profile made, including the original of a restored copy, is not its own.
pub fn owns(reference: &CredentialReference) -> bool {
    profile().is_ok_and(|profile| reference.owned_by(&profile.owner))
}

/// Whether `reference` is an item this profile owns that holds exactly
/// `value`, so a repeated save may keep it instead of making another.
pub fn owned_holds(reference: &CredentialReference, value: &str) -> bool {
    owns(reference) && resolve(reference).is_ok_and(|stored| stored == value)
}

/// Deletes the item `reference` names when this profile owns it. A reference
/// the user made is never touched, and deleting an item another profile made
/// is refused. An item already gone counts as deleted.
pub fn delete_owned(reference: &CredentialReference) -> Result<()> {
    match reference {
        CredentialReference::Keychain { service, account } if reference.ade_owned() => {
            let profile = profile()?;
            anyhow::ensure!(
                reference.owned_by(&profile.owner),
                "{} belongs to another ADE profile, so this profile never deletes it",
                reference.describe()
            );
            profile.store.delete(service, account)
        }
        _ => Ok(()),
    }
}

/// Deletes each owned item, logging rather than failing: the caller's own
/// change already committed, and an orphaned item holds no reference.
pub fn delete_owned_quietly<'a>(references: impl IntoIterator<Item = &'a CredentialReference>) {
    for reference in references {
        if let Err(error) = delete_owned(reference) {
            tracing::warn!("Could not delete {}: {error:#}", reference.describe());
        }
    }
}

/// Items made during a change that has not committed yet. Dropping it
/// deletes them, so a refused or failed save leaves no orphan behind.
#[derive(Default)]
pub struct Pending(Vec<CredentialReference>);

impl Pending {
    pub fn store(&mut self, scope: &str, value: &str) -> Result<CredentialReference> {
        let reference = store_new(scope, value)?;
        self.0.push(reference.clone());
        Ok(reference)
    }
    /// The change committed: its items now belong to the saved references.
    pub fn commit(mut self) {
        self.0.clear();
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        delete_owned_quietly(self.0.iter());
    }
}

/// The test-only secret store: one file of items, encrypted and
/// authenticated under a key from the daemon's environment. Only debug
/// builds contain it.
///
/// `ADE_SECRET_FILE` is the absolute path of the file; its directory must
/// exist, or the store is unavailable, as a missing keychain is. A missing
/// file is an empty store. `ADE_SECRET_KEY` is 32 bytes as 64 hex digits.
///
/// The file is JSON `{"version":1,"nonce","data","tag"}`, all hex. `data` is
/// the JSON list of items XORed with a SHA-256 counter keystream, block `i`
/// being SHA-256(enc_key ‖ nonce ‖ i as u64 big-endian); `tag` is
/// HMAC-SHA-256(mac_key, nonce ‖ data). `enc_key` and `mac_key` are
/// SHA-256 of `ade-secret-file enc\0` and `ade-secret-file mac\0` followed
/// by the key. `e2e/protocol/fixtures/secret-store.ts` implements the same
/// format so specs can add and inspect items as a user would. It guards test
/// values only and is not production cryptography.
#[cfg(debug_assertions)]
pub mod file {
    use super::SecretStore;
    use anyhow::{Context, Result, bail, ensure};
    use serde::{Deserialize, Serialize};
    use sha2::{Digest, Sha256};
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::PathBuf;
    use std::sync::Mutex;

    #[derive(Serialize, Deserialize)]
    struct Item {
        service: String,
        account: String,
        value: String,
    }

    #[derive(Serialize, Deserialize)]
    struct Envelope {
        version: u32,
        nonce: String,
        data: String,
        tag: String,
    }

    pub struct FileStore {
        path: PathBuf,
        enc_key: [u8; 32],
        mac_key: [u8; 32],
        lock: Mutex<()>,
    }

    fn sha256(parts: &[&[u8]]) -> [u8; 32] {
        let mut hash = Sha256::new();
        for part in parts {
            hash.update(part);
        }
        hash.finalize().into()
    }

    fn hmac(key: &[u8; 32], message: &[&[u8]]) -> [u8; 32] {
        let mut inner = [0x36u8; 64];
        let mut outer = [0x5cu8; 64];
        for (index, byte) in key.iter().enumerate() {
            inner[index] ^= byte;
            outer[index] ^= byte;
        }
        let mut parts: Vec<&[u8]> = vec![&inner];
        parts.extend_from_slice(message);
        let digest = sha256(&parts);
        sha256(&[&outer, &digest])
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn unhex(text: &str) -> Result<Vec<u8>> {
        ensure!(
            text.len().is_multiple_of(2) && text.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "not hex"
        );
        (0..text.len())
            .step_by(2)
            .map(|index| Ok(u8::from_str_radix(&text[index..index + 2], 16)?))
            .collect()
    }

    impl FileStore {
        pub fn from_env() -> Result<Self> {
            let path = PathBuf::from(
                std::env::var_os("ADE_SECRET_FILE")
                    .context("ADE_SECRET_STORE=file needs ADE_SECRET_FILE")?,
            );
            ensure!(
                path.is_absolute(),
                "ADE_SECRET_FILE must be an absolute path"
            );
            let key = std::env::var("ADE_SECRET_KEY")
                .ok()
                .and_then(|text| unhex(&text).ok())
                .filter(|key| key.len() == 32)
                .context("ADE_SECRET_STORE=file needs ADE_SECRET_KEY as 64 hex digits")?;
            Ok(Self::new(path, &key))
        }

        pub fn new(path: PathBuf, key: &[u8]) -> Self {
            Self {
                path,
                enc_key: sha256(&[b"ade-secret-file enc\0", key]),
                mac_key: sha256(&[b"ade-secret-file mac\0", key]),
                lock: Mutex::new(()),
            }
        }

        fn keystream(&self, nonce: &[u8], data: &mut [u8]) {
            for (block, chunk) in data.chunks_mut(32).enumerate() {
                let pad = sha256(&[&self.enc_key, nonce, &(block as u64).to_be_bytes()]);
                for (byte, key) in chunk.iter_mut().zip(pad) {
                    *byte ^= key;
                }
            }
        }

        fn load(&self) -> Result<Vec<Item>> {
            let directory = self
                .path
                .parent()
                .context("ADE_SECRET_FILE has no directory")?;
            if !directory.is_dir() {
                bail!(
                    "the secret store directory {} does not exist",
                    directory.display()
                );
            }
            let text = match std::fs::read(&self.path) {
                Ok(text) => text,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
                Err(error) => return Err(error).context("the secret store cannot be read"),
            };
            let envelope: Envelope =
                serde_json::from_slice(&text).context("the secret store is damaged")?;
            ensure!(
                envelope.version == 1,
                "the secret store has an unknown version"
            );
            let nonce = unhex(&envelope.nonce).context("the secret store is damaged")?;
            let mut data = unhex(&envelope.data).context("the secret store is damaged")?;
            let tag = unhex(&envelope.tag).context("the secret store is damaged")?;
            let expected = hmac(&self.mac_key, &[&nonce, &data]);
            ensure!(
                tag.len() == 32
                    && tag
                        .iter()
                        .zip(expected)
                        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
                        == 0,
                "the secret store failed authentication; its key or contents changed"
            );
            self.keystream(&nonce, &mut data);
            serde_json::from_slice(&data).context("the secret store is damaged")
        }

        fn save(&self, items: &[Item]) -> Result<()> {
            let nonce = [
                *uuid::Uuid::new_v4().as_bytes(),
                *uuid::Uuid::new_v4().as_bytes(),
            ]
            .concat();
            let mut data = serde_json::to_vec(items)?;
            self.keystream(&nonce, &mut data);
            let tag = hmac(&self.mac_key, &[&nonce, &data]);
            let envelope = Envelope {
                version: 1,
                nonce: hex(&nonce),
                data: hex(&data),
                tag: hex(&tag),
            };
            let temporary = self
                .path
                .with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)
                .context("the secret store cannot be written")?;
            file.write_all(&serde_json::to_vec(&envelope)?)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&temporary, &self.path).context("the secret store cannot be written")
        }
    }

    impl SecretStore for FileStore {
        fn find(&self, service: &str, account: &str) -> Result<Vec<u8>> {
            let _held = self.lock.lock().unwrap();
            self.load()?
                .into_iter()
                .find(|item| item.service == service && item.account == account)
                .map(|item| item.value.into_bytes())
                .context("the item does not exist")
        }
        fn add(&self, service: &str, account: &str, value: &[u8]) -> Result<()> {
            let _held = self.lock.lock().unwrap();
            let mut items = self.load()?;
            ensure!(
                !items
                    .iter()
                    .any(|item| item.service == service && item.account == account),
                "the item already exists"
            );
            items.push(Item {
                service: service.into(),
                account: account.into(),
                value: String::from_utf8(value.to_vec()).context("a secret must be UTF-8")?,
            });
            self.save(&items)
        }
        fn delete(&self, service: &str, account: &str) -> Result<()> {
            let _held = self.lock.lock().unwrap();
            let mut items = self.load()?;
            let before = items.len();
            items.retain(|item| !(item.service == service && item.account == account));
            if items.len() == before {
                return Ok(());
            }
            self.save(&items)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn items_round_trip_encrypted_and_a_wrong_key_is_refused() {
            let directory = std::env::temp_dir()
                .join(format!("ade-secret-file-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir(&directory).unwrap();
            let path = directory.join("store.json");
            let store = FileStore::new(path.clone(), &[7u8; 32]);
            store.add("s", "a", b"plain-value-123").unwrap();
            assert!(store.add("s", "a", b"again").is_err());
            assert_eq!(store.find("s", "a").unwrap(), b"plain-value-123");
            assert!(
                !String::from_utf8_lossy(&std::fs::read(&path).unwrap())
                    .contains("plain-value-123")
            );
            let other = FileStore::new(path.clone(), &[8u8; 32]);
            assert!(
                other
                    .find("s", "a")
                    .unwrap_err()
                    .to_string()
                    .contains("authentication")
            );
            store.delete("s", "a").unwrap();
            store.delete("s", "a").unwrap();
            assert!(
                store
                    .find("s", "a")
                    .unwrap_err()
                    .to_string()
                    .contains("does not exist")
            );
            let missing = FileStore::new(directory.join("gone/store.json"), &[7u8; 32]);
            assert!(
                missing
                    .find("s", "a")
                    .unwrap_err()
                    .to_string()
                    .contains("does not exist")
            );
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_store_is_chosen_only_by_name_and_never_in_a_release_build() {
        assert_eq!(backend(None, true).unwrap(), Backend::Keychain);
        assert_eq!(backend(None, false).unwrap(), Backend::Keychain);
        assert_eq!(backend(Some("file"), false).unwrap(), Backend::File);
        let refused = backend(Some("file"), true).unwrap_err().to_string();
        assert!(refused.contains("release build refuses"), "{refused}");
        for other in ["", "keychain", "FILE"] {
            assert!(backend(Some(other), false).is_err());
        }
    }
}

#[cfg(target_os = "macos")]
mod keychain {
    use anyhow::{Result, bail};
    use std::ffi::{CString, c_char, c_void};
    use std::os::unix::ffi::OsStrExt;
    use std::sync::Once;

    type OsStatus = i32;
    type Ref = *mut c_void;

    const ERR_SEC_ITEM_NOT_FOUND: OsStatus = -25300;

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecKeychainOpen(path: *const c_char, keychain: *mut Ref) -> OsStatus;
        fn SecKeychainGetStatus(keychain: Ref, status: *mut u32) -> OsStatus;
        fn SecKeychainSetUserInteractionAllowed(allowed: u8) -> OsStatus;
        fn SecKeychainFindGenericPassword(
            keychain_or_array: Ref,
            service_length: u32,
            service: *const c_char,
            account_length: u32,
            account: *const c_char,
            password_length: *mut u32,
            password: *mut *mut c_void,
            item: *mut Ref,
        ) -> OsStatus;
        fn SecKeychainAddGenericPassword(
            keychain: Ref,
            service_length: u32,
            service: *const c_char,
            account_length: u32,
            account: *const c_char,
            password_length: u32,
            password: *const c_void,
            item: *mut Ref,
        ) -> OsStatus;
        fn SecKeychainItemFreeContent(attributes: *mut c_void, data: *mut c_void) -> OsStatus;
        fn SecKeychainItemDelete(item: Ref) -> OsStatus;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: *const c_void);
    }

    fn explain(status: OsStatus) -> String {
        let reason = match status {
            ERR_SEC_ITEM_NOT_FOUND => "the item does not exist",
            -25294 => "the keychain does not exist",
            -25307 => "there is no default keychain",
            -25308 => "the keychain is locked or the item needs permission, and ADE never prompts",
            -25293 => "access was denied",
            -25299 => "the item already exists",
            -128 => "access was cancelled",
            _ => "the Keychain refused the request",
        };
        format!("{reason} (OSStatus {status})")
    }

    /// The keychain ADE is confined to, or null for the user's defaults.
    struct Keychain(Ref);

    impl Keychain {
        fn open() -> Result<Self> {
            static QUIET: Once = Once::new();
            // SAFETY: a process-wide flag with no pointers.
            QUIET.call_once(|| unsafe {
                SecKeychainSetUserInteractionAllowed(0);
            });
            let Some(path) = std::env::var_os("ADE_KEYCHAIN") else {
                return Ok(Self(std::ptr::null_mut()));
            };
            let path = CString::new(std::path::Path::new(&path).as_os_str().as_bytes())?;
            let mut keychain: Ref = std::ptr::null_mut();
            // SAFETY: `path` is a valid C string and `keychain` receives an
            // owned reference, released in `Drop`.
            let status = unsafe { SecKeychainOpen(path.as_ptr(), &mut keychain) };
            if status != 0 {
                bail!(
                    "The ADE_KEYCHAIN keychain cannot be opened: {}",
                    explain(status)
                );
            }
            let opened = Self(keychain);
            let mut state = 0u32;
            // SAFETY: `opened.0` is the keychain just opened.
            let status = unsafe { SecKeychainGetStatus(opened.0, &mut state) };
            if status != 0 {
                bail!(
                    "The ADE_KEYCHAIN keychain is unavailable: {}",
                    explain(status)
                );
            }
            Ok(opened)
        }
    }

    impl Drop for Keychain {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: an owned reference from SecKeychainOpen.
                unsafe { CFRelease(self.0) };
            }
        }
    }

    fn length(text: &str) -> Result<u32> {
        Ok(u32::try_from(text.len())?)
    }

    /// A found item: an owned reference, released on drop.
    struct Item(Ref);

    impl Drop for Item {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: an owned item reference from the lookup.
                unsafe { CFRelease(self.0) };
            }
        }
    }

    /// Finds the item, with its data when `want_data`; none when it does not exist.
    fn lookup(
        keychain: &Keychain,
        service: &str,
        account: &str,
        want_data: bool,
    ) -> Result<Option<(Item, Vec<u8>)>> {
        let mut size = 0u32;
        let mut data: *mut c_void = std::ptr::null_mut();
        let mut item: Ref = std::ptr::null_mut();
        // SAFETY: the name pointers are valid for their stated lengths, and
        // the out-parameters receive memory released below.
        let status = unsafe {
            SecKeychainFindGenericPassword(
                keychain.0,
                length(service)?,
                service.as_ptr().cast(),
                length(account)?,
                account.as_ptr().cast(),
                if want_data {
                    &mut size
                } else {
                    std::ptr::null_mut()
                },
                if want_data {
                    &mut data
                } else {
                    std::ptr::null_mut()
                },
                &mut item,
            )
        };
        if status == ERR_SEC_ITEM_NOT_FOUND {
            return Ok(None);
        }
        if status != 0 {
            bail!("{}", explain(status));
        }
        let item = Item(item);
        let mut bytes = Vec::new();
        if !data.is_null() {
            // SAFETY: the Keychain returned `size` bytes at `data`.
            bytes =
                unsafe { std::slice::from_raw_parts(data.cast::<u8>(), size as usize) }.to_vec();
            // SAFETY: `data` came from SecKeychainFindGenericPassword.
            unsafe { SecKeychainItemFreeContent(std::ptr::null_mut(), data) };
        }
        Ok(Some((item, bytes)))
    }

    pub fn find(service: &str, account: &str) -> Result<Vec<u8>> {
        let keychain = Keychain::open()?;
        match lookup(&keychain, service, account, true)? {
            Some((_, bytes)) => Ok(bytes),
            None => bail!("{}", explain(ERR_SEC_ITEM_NOT_FOUND)),
        }
    }

    pub fn add(service: &str, account: &str, value: &[u8]) -> Result<()> {
        let keychain = Keychain::open()?;
        // SAFETY: every pointer is valid for its stated length; no item
        // reference is requested.
        let status = unsafe {
            SecKeychainAddGenericPassword(
                keychain.0,
                length(service)?,
                service.as_ptr().cast(),
                length(account)?,
                account.as_ptr().cast(),
                u32::try_from(value.len())?,
                value.as_ptr().cast(),
                std::ptr::null_mut(),
            )
        };
        if status != 0 {
            bail!("{}", explain(status));
        }
        Ok(())
    }

    pub fn delete(service: &str, account: &str) -> Result<()> {
        let keychain = Keychain::open()?;
        let Some((item, _)) = lookup(&keychain, service, account, false)? else {
            return Ok(());
        };
        // SAFETY: `item` holds the owned reference the lookup returned.
        let status = unsafe { SecKeychainItemDelete(item.0) };
        if status != 0 && status != ERR_SEC_ITEM_NOT_FOUND {
            bail!("{}", explain(status));
        }
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    use anyhow::{Result, bail};

    pub fn find(_service: &str, _account: &str) -> Result<Vec<u8>> {
        bail!("the Keychain is available only on macOS")
    }
    pub fn add(_service: &str, _account: &str, _value: &[u8]) -> Result<()> {
        bail!("the Keychain is available only on macOS")
    }
    pub fn delete(_service: &str, _account: &str) -> Result<()> {
        bail!("the Keychain is available only on macOS")
    }
}
