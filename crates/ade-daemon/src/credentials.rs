//! Resolves and stores credential references (architecture section 7).
//!
//! A reference names an environment variable of this daemon or a Keychain
//! generic password. Values are read only when a process that needs them is
//! launched, and are never written to a database, a reply or a log.
//!
//! Items ADE creates live under [`ADE_KEYCHAIN_SERVICE`] with an account that
//! names their owner and a random suffix, so a replaced value never overwrites
//! the item a stored reference still names. `ADE_KEYCHAIN`, when set, is the
//! path of the only keychain ADE reads and writes; otherwise ADE uses the
//! user's default keychain and search list. The Keychain never shows a prompt
//! to this process: a locked keychain or an item that needs permission is an
//! error.
use ade_core::credentials::{ADE_KEYCHAIN_SERVICE, CredentialReference};
use anyhow::{Context, Result, bail};
use std::collections::BTreeMap;

/// The most bytes ADE stores or reads for one secret.
const MAX_SECRET_BYTES: usize = 8 * 1024;

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
            let bytes = keychain::find(service, account)
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

/// Moves `value` into a new Keychain item ADE owns and returns its
/// reference. `scope` names the owner, such as `service/<workspace>/<name>/<KEY>`.
pub fn store_new(scope: &str, value: &str) -> Result<CredentialReference> {
    anyhow::ensure!(
        value.len() <= MAX_SECRET_BYTES && !value.contains('\0'),
        "A secret value must be at most {MAX_SECRET_BYTES} bytes without NUL"
    );
    let account = format!("{scope}/{}", uuid::Uuid::new_v4().simple());
    keychain::add(ADE_KEYCHAIN_SERVICE, &account, value.as_bytes())
        .context("The secret could not be stored in the Keychain")?;
    Ok(CredentialReference::Keychain {
        service: ADE_KEYCHAIN_SERVICE.into(),
        account,
    })
}

/// Whether `reference` is an item ADE owns that holds exactly `value`, so a
/// repeated save may keep it instead of making another.
pub fn owned_holds(reference: &CredentialReference, value: &str) -> bool {
    reference.ade_owned() && resolve(reference).is_ok_and(|stored| stored == value)
}

/// Deletes the item `reference` names when ADE owns it. A reference the user
/// made is never touched. An item already gone counts as deleted.
pub fn delete_owned(reference: &CredentialReference) -> Result<()> {
    match reference {
        CredentialReference::Keychain { service, account } if reference.ade_owned() => {
            keychain::delete(service, account)
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
