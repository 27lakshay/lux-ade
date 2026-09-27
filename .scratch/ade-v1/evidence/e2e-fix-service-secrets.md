# E2E fix: service secrets (F089, D15)

## Defect

**F089 secret values stored in plain text and exported.** `secret_env` values
sit in `Config.env` in the `services` table of `sessions.sqlite`. A backup
copied that database whole, so every bundle carried each secret in clear,
although D15 requires bundles to exclude secret data.

## Fix

The backup now withholds every secret service value, and the manifest states it.

- `ade-core services::withhold_secret_values` replaces each secret value in a
  stored service record with `[redacted]` and leaves every other field as stored.
  `holds_secret_values` reports a record that still holds one. It counts a
  malformed secret list as holding one, so an unreadable record is never
  treated as having no secrets.
- `ade-control backup create` rewrites the copied `sessions.sqlite` with
  `secure_delete` on, before the history-projection step's `VACUUM`, so no
  freed page keeps an old value. It then verifies the copy
  (`coverage::secrets_verdict`) before hashing it.
- Backup format 5 declares the exclusion: `excluded` gains "secret service
  environment values…", and `coverage` gains
  `sessions.sqlite#service_secrets: excluded`. Format 4 bundles still read
  (`EXCLUDED_V4`, `COVERAGE_V4`). `inspect` and `restore` of a format-5 bundle
  refuse a database that holds a secret value.
- A restored service keeps its configuration, and each secret reads as
  `[redacted]`. `service.start` refuses it with a definite refusal before
  anything is reserved or launched:
  `Secret API_TOKEN was withheld from a backup; configure its value before starting the service`
  (`Config::ensure_secrets_present`, checked in phase 1 of `start_service`, a
  pure in-memory check). Re-saving the redacted view is refused
  (`keep_secrets`: "was withheld from a backup; send its value"), so the
  placeholder never becomes a launch value. Sending the value again makes the
  service launch with it.

## Tests

- E2E `e2e/protocol/backup/secrets.spec.ts` "a backup withholds secret service
  values and the restored service needs them sent again". It checks that no
  file in the bundle contains the secret's bytes. It checks the manifest's
  format, exclusion and coverage. It checks that the source profile still
  launches with the real value. A bundle doctored to hold the secret fails
  `inspect`. After a restore, `service.start` is refused and nothing is
  reserved. A redacted re-save is refused. A re-sent value reaches the process.
- `e2e/protocol/backup/restore.spec.ts` now expects format 5.
- Pure tests: `ade-core services::tests::a_backup_copy_withholds_every_secret_value_and_a_restored_service_cannot_start_until_resent`
  and `ade-control backup::coverage::tests::format_5_declares_withheld_service_secrets_and_format_4_still_reads`.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/backup e2e/protocol/services2`: 20 passed.
- `pnpm check:static`: passed.

## Open

- The live profile still stores secret values in plain text in its own
  `sessions.sqlite`, which lives in the profile's private data directory.
  Section 7 of the architecture asks for secret references, such as Keychain
  items. That needs a secret store the E2E harness can scope away from the
  user's login keychain. This fix removes the export, not the at-rest copy.
- A format-4 bundle made before this fix still holds secrets. Restore accepts
  it unchanged.
