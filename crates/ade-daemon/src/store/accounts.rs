use super::*;

impl Store {
    fn account_home(&self, id: &str) -> Result<PathBuf> {
        use std::os::unix::fs::MetadataExt;
        let suffix = id.strip_prefix("account_").context("Invalid account ID")?;
        ensure!(
            suffix.len() == 36
                && suffix.split('-').map(str::len).eq([8, 4, 4, 4, 12])
                && suffix
                    .chars()
                    .all(|character| character == '-' || character.is_ascii_hexdigit()),
            "Invalid account ID"
        );
        let homes = self.data_directory.join("provider-accounts");
        let home = homes.join(id);
        let profile_owner = std::fs::metadata(&self.data_directory)?.uid();
        for directory in [&homes, &home] {
            let metadata = std::fs::symlink_metadata(directory)?;
            ensure!(
                metadata.is_dir()
                    && !metadata.file_type().is_symlink()
                    && metadata.uid() == profile_owner
                    && metadata.mode() & 0o077 == 0,
                "Account native home is unavailable or redirected"
            );
        }
        Ok(home)
    }
    pub fn create_account(&self, provider: &str, name: &str) -> Result<Account> {
        crate::provider::descriptor(provider)?;
        let name = name.trim();
        ensure!(
            !name.is_empty() && name.len() <= 80 && !name.contains(['\0', '\n', '\r']),
            "Account name must contain 1 to 80 characters without control line breaks"
        );
        let id = new_id("account");
        let homes = self.data_directory.join("provider-accounts");
        match std::fs::create_dir(&homes) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        let homes_metadata = std::fs::symlink_metadata(&homes)?;
        ensure!(
            homes_metadata.is_dir() && !homes_metadata.file_type().is_symlink(),
            "Account native home root is redirected"
        );
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
        ensure!(
            homes_metadata.uid() == std::fs::metadata(&self.data_directory)?.uid(),
            "Account native home root has another owner"
        );
        std::fs::set_permissions(&homes, std::fs::Permissions::from_mode(0o700))?;
        let home = homes.join(&id);
        std::fs::create_dir(&home)?;
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700))?;
        let home = self.account_home(&id)?;
        let account = Account {
            id,
            provider: provider.into(),
            name: name.into(),
            native_home: home.to_string_lossy().into_owned(),
            generation: 0,
            state: "unverified".into(),
            claude_identity: None,
            codex_identity: None,
            omp_identity: None,
        };
        if provider == "codex" {
            use std::io::Write;
            let mut config = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(home.join("config.toml"))?;
            config.write_all(b"cli_auth_credentials_store = \"file\"\n")?;
            config.sync_all()?;
        }
        self.connection.execute(
            "INSERT INTO accounts(id,provider,data) VALUES(?1,?2,?3)",
            params![account.id, account.provider, encode(&account)?],
        )?;
        Ok(account)
    }
    pub fn accounts(&self) -> Result<Vec<Account>> {
        all::<Account>(&self.connection, "SELECT data FROM accounts ORDER BY rowid")?
            .into_iter()
            .map(|mut account| {
                account.native_home = self
                    .account_home(&account.id)?
                    .to_string_lossy()
                    .into_owned();
                Ok(account)
            })
            .collect()
    }
    pub fn account(&self, id: &str) -> Result<Account> {
        let mut account: Account = one(&self.connection, "accounts", id)?;
        account.native_home = self
            .account_home(&account.id)?
            .to_string_lossy()
            .into_owned();
        Ok(account)
    }
    pub fn verify_claude_account(
        &self,
        id: &str,
        generation: u64,
        identity: ClaudeIdentity,
    ) -> Result<Account> {
        let tx = self.transaction()?;
        let mut account: Account = one(&tx, "accounts", id)?;
        ensure!(
            account.provider == "claude",
            "Account does not use Claude Code"
        );
        ensure!(
            account.generation == generation,
            "Account changed during verification"
        );
        ensure!(
            account
                .claude_identity
                .as_ref()
                .is_none_or(|pinned| pinned == &identity),
            "Claude account identity changed; disable the account before binding a new identity"
        );
        account.state = "verified".into();
        account.claude_identity = Some(identity);
        tx.execute(
            "UPDATE accounts SET data=?2 WHERE id=?1",
            params![id, encode(&account)?],
        )?;
        tx.commit()?;
        self.account(id)
    }
    pub fn verify_codex_account(
        &self,
        id: &str,
        generation: u64,
        identity: ade_core::model::CodexIdentity,
    ) -> Result<Account> {
        let tx = self.transaction()?;
        let mut account: Account = one(&tx, "accounts", id)?;
        ensure!(account.provider == "codex", "Account does not use Codex");
        ensure!(
            account.generation == generation,
            "Account changed during verification"
        );
        ensure!(
            account
                .codex_identity
                .as_ref()
                .is_none_or(|pinned| pinned == &identity),
            "Codex account identity changed; disable the account before binding a new identity"
        );
        account.state = "verified".into();
        account.codex_identity = Some(identity);
        tx.execute(
            "UPDATE accounts SET data=?2 WHERE id=?1",
            params![id, encode(&account)?],
        )?;
        tx.commit()?;
        self.account(id)
    }
    pub fn verify_omp_account(
        &self,
        id: &str,
        generation: u64,
        identity: ade_core::model::OmpIdentity,
    ) -> Result<Account> {
        let tx = self.transaction()?;
        let mut account: Account = one(&tx, "accounts", id)?;
        ensure!(account.provider == "omp", "Account does not use Oh My Pi");
        ensure!(
            account.generation == generation,
            "Account changed during verification"
        );
        ensure!(
            account
                .omp_identity
                .as_ref()
                .is_none_or(|pinned| pinned == &identity),
            "Oh My Pi account identity changed; disable the account before binding a new identity"
        );
        account.state = "verified".into();
        account.omp_identity = Some(identity);
        tx.execute(
            "UPDATE accounts SET data=?2 WHERE id=?1",
            params![id, encode(&account)?],
        )?;
        tx.commit()?;
        self.account(id)
    }
    pub fn disable_account(&self, id: &str) -> Result<Account> {
        let tx = self.transaction()?;
        let mut account: Account = one(&tx, "accounts", id)?;
        account.generation = account
            .generation
            .checked_add(1)
            .context("Account generation exhausted")?;
        account.state = "disabled".into();
        account.claude_identity = None;
        account.codex_identity = None;
        account.omp_identity = None;
        tx.execute(
            "UPDATE accounts SET data=?2 WHERE id=?1",
            params![id, encode(&account)?],
        )?;
        tx.commit()?;
        self.account(id)
    }
}
