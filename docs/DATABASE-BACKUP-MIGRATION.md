# SKAW Bot — Database Backup & Railway Migration

This guide describes the supported backup and restore flow for the SKAW Bot PostgreSQL database.

> **Repository visibility:** the SKAW Bot repository is public. Only encrypted files ending in .dump.enc and their non-secret .manifest.json files are allowed in database/backups/. Never commit plaintext .dump/.sql, .env, Discord tokens, PostgreSQL connection strings, or BACKUP_ENCRYPTION_KEY.

## What the database archive contains

The backup command uses PostgreSQL pg_dump in custom archive format. It captures the whole selected database, not a hand-picked list of features. This includes the application tables, migration ledger, indexes, functions/triggers, and all rows in temp_data and cache_data.

The key-value table temp_data is persistent PostgreSQL storage in this application. Despite the word “temp”, it stores many durable SKAW feature records, including:

- Employee Logs configuration, audit history, individual records, Auto Role settings, and backfill markers.
- Employee Directory index and member records.
- Employee Role Registry.
- Message Manager allowed roles and managed-message records.
- Role Templates.
- Company Structure configuration and published-message references.
- Role Access Manager snapshots and audit records.
- Auto Responder templates and settings.
- Auto Message schedules.
- Counting Game and other key-value feature data.

The structured PostgreSQL tables include guild/user data, birthdays, giveaways, tickets, AFK, welcome and leveling configurations, user levels, economy, verification audit, invite tracking, and application roles. The complete archive also includes cache_data.

A database dump does **not** copy live Discord server objects (roles, channels, current member-role assignments, messages, webhooks), in-memory sessions/drafts/cooldowns, Railway settings/secrets, external assets, or the MySKAW/Base44 website database. Those are separate migration items. Channel/role/message IDs saved in PostgreSQL remain references to objects in Discord; they are not exports of those objects.

## Requirements

- Node.js 20 or newer (run npm ci first).
- PostgreSQL client tools pg_dump and pg_restore, installed and available in PATH.
- A source database connection string in POSTGRES_URL (or DATABASE_URL).
- A strong BACKUP_ENCRYPTION_KEY of at least 32 UTF-8 bytes.

## 1. Create and protect the encryption key

Generate a random key once on your own computer:

~~~powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
~~~

Save the output in a password manager or another secure offline location. **The same key is required for every future verification and restore of archives encrypted with it.** Do not put it in GitHub, a commit, an issue, a chat message, or the backup manifest. Losing the key makes the encrypted archives unrecoverable.

Put the key in your local .env file (which is gitignored):

~~~dotenv
BACKUP_ENCRYPTION_KEY=PASTE_THE_RANDOM_KEY_HERE
BACKUP_DIR=./database/backups
~~~

Do not use the sample/CI key from the GitHub Actions workflow for a real database.

## Connecting from your Windows PC

Railway's private hostname (for example, a host ending in .railway.internal) is intended for services inside the same Railway project. It is not normally reachable directly from your home computer.

For a local backup, use one of these methods:

1. In the old Railway PostgreSQL service, open **Settings → Networking**, enable a **TCP Proxy/Public Access**, then copy the external connection string from the service's DATABASE_PUBLIC_URL variable into your local POSTGRES_URL. Use the TCP proxy host and port supplied by Railway, not the service's ordinary HTTP domain. Railway notes that TCP Proxy traffic may incur network-egress charges. See the [Railway PostgreSQL connection guide](https://docs.railway.com/databases/postgresql) and [TCP Proxy guide](https://docs.railway.com/networking/tcp-proxy).
2. Alternatively, use the Railway CLI SSH tunnel: run the command shown below, keep that terminal open while the backup runs, and use the local tunnel connection details it prints. See the [railway connect CLI guide](https://docs.railway.com/cli/connect).

~~~powershell
railway connect Postgres --tunnel-only
~~~

If the external connection URL does not include sslmode=require, set POSTGRES_SSL=true in your local .env when the database endpoint requires SSL. Do not paste your actual connection URL into chat or commit it.

## 2. Create an encrypted full backup

Set the **old/source** Railway PostgreSQL connection string in your local .env:

~~~dotenv
POSTGRES_URL=postgresql://...OLD_DATABASE_CONNECTION...
~~~

Then run:

~~~powershell
npm ci
npm run backup:db
~~~

The command creates two files under database/backups/:

- skaw-postgres-[timestamp].dump.enc — encrypted full PostgreSQL archive (AES-256-GCM; key derived with scrypt).
- skaw-postgres-[timestamp].dump.enc.manifest.json — non-secret metadata, including file size, SHA-256, schema version, PostgreSQL client version, and table inventory.

The plaintext dump is created only in a temporary OS directory and removed when the command exits, including on failure. PostgreSQL connection credentials are passed to the client through libpq environment variables rather than being placed in pg_dump/pg_restore command-line arguments. The script checks that pg_restore --list can read the archive and that all required SKAW application tables plus schema_migrations are present before accepting the backup.

The bot can remain online while pg_dump runs; PostgreSQL gives the dump a consistent database snapshot. For the cleanest migration window, avoid intentionally changing critical settings while the backup is running.

## 3. Verify before committing

Run:

~~~powershell
npm run backup:verify
~~~

Verification checks the manifest, file size, SHA-256, authenticated decryption, archive readability, and required table inventory. A successful check proves the encrypted file is readable with the saved key and structurally contains the required table definitions. It does not prove a live production restore has succeeded; that is why the restore drill and post-restore verification are separate steps.

## 4. Store the encrypted archive in the public GitHub repository

Only after backup:verify passes, review the exact staged files:

~~~powershell
git status --short
git add database/backups/*.dump.enc database/backups/*.dump.enc.manifest.json
git status --short
git commit -m "Add encrypted PostgreSQL backup"
git push
~~~

The .gitignore intentionally excludes plaintext .dump and .sql files, while allowing only encrypted archives and their manifests in database/backups/.

GitHub blocks ordinary Git files larger than 100 MB. If an encrypted archive approaches or exceeds that limit, do not rename, split, or upload the plaintext dump. Use a separately configured encrypted archive store or Git LFS after checking its limits and billing. Keep at least one independent copy outside the same GitHub account/repository as well.

## 5. Restore to the NEW Railway PostgreSQL database

1. Create a new PostgreSQL service in the new Railway project.
2. Do not start the bot against the new database yet.
3. Clone the repository containing the encrypted archive onto your computer and run npm ci.
4. Put the original BACKUP_ENCRYPTION_KEY in the local .env file.
5. Set the **new/target** database URL as POSTGRES_RESTORE_URL in .env:

~~~dotenv
POSTGRES_RESTORE_URL=postgresql://...NEW_DATABASE_CONNECTION...
~~~

Restore into a new, empty database whenever possible:

~~~powershell
npm run restore:db -- --input "database/backups/EXACT_BACKUP_FILENAME.dump.enc" --confirm
~~~

The restore script checks the archive manifest and SHA-256, authenticates/decrypts the archive into a temporary OS directory, checks required table definitions again, then runs pg_restore with --exit-on-error and --single-transaction. Connection credentials are supplied through libpq environment variables, not process arguments. It does not print the database URL in its logs. The restore operation modifies the target database; double-check that POSTGRES_RESTORE_URL points to the new database before using --confirm.

The restore script refuses to fall back to POSTGRES_URL and rejects an exact match to the source database endpoint. Legacy plaintext .dump files are rejected by default. Only use --allow-plaintext for a trusted local legacy dump, and keep that file out of GitHub.

## 6. Verify the restored database before starting the bot

Set POSTGRES_VERIFY_URL to the **new** database (it may be the same value as POSTGRES_RESTORE_URL):

~~~dotenv
POSTGRES_VERIFY_URL=postgresql://...NEW_DATABASE_CONNECTION...
~~~

Then run:

~~~powershell
npm run restore:verify
npm run migrate:check
~~~

restore:verify confirms all required tables exist, reports row counts for each table, and counts stored keys for the important SKAW features in temp_data. A zero key count is informational: that feature might not have been configured or used on the server. Compare the report with the source database report before switching the bot over.

Only after verification passes should the new Railway bot service receive the new POSTGRES_URL and be started. Re-enter the Discord token and other environment variables as Railway secrets. Never copy .env into GitHub.

## 7. Commands and safety notes

| Command | Purpose |
|---|---|
| npm run backup:db | Create encrypted full database backup |
| npm run backup:verify | Verify one encrypted archive and manifest |
| npm run restore:db -- --input [file] --confirm | Restore to POSTGRES_RESTORE_URL |
| npm run restore:verify | Inspect tables and SKAW feature key inventory on POSTGRES_VERIFY_URL |
| npm run backup:drill | Existing isolated PostgreSQL restore drill |
| npm run test:backup-crypto | Test encryption round-trip, wrong-key rejection, tamper detection, and manifest validation |

- Keep the encryption key separate from the public repository and from the archive itself.
- Do not upload production database dumps to GitHub Actions artifacts or logs.
- Do not run restore against the old/production database as a test.
- The GitHub Actions restore drill uses a disposable test PostgreSQL service and a CI-only encryption key. It is not a backup of Railway production.
- The repository backup does not replace an independent offline copy. Keep more than one protected copy.
