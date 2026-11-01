# TitanBot

Modular Discord bot for SKAW Group.

## Requirements

- Node.js 20 or newer
- Discord bot credentials
- PostgreSQL database configuration for persistent storage

## Run locally

Install dependencies:

~~~bash
npm ci
~~~

Start the bot:

~~~bash
npm start
~~~

Configure the environment and application settings for your deployment before starting the bot.

## Maintenance scripts

- **migrate:check** — check database migrations
- **migrate:status** — inspect migration status
- **backup:db** — create an encrypted full PostgreSQL backup in database/backups/
- **backup:verify** — verify archive hash, decryptability, and required PostgreSQL tables
- **restore:db** — restore an encrypted backup to POSTGRES_RESTORE_URL (requires --confirm)
- **restore:verify** — inspect restored tables and SKAW feature keys using POSTGRES_VERIFY_URL
- **backup:drill** — run the PostgreSQL restore drill in an isolated database
- **test:backup-crypto** — test encryption, wrong-key rejection, and tamper detection
- **test:role-templates** — run role template tests
- **test:employee-logs** — run employee log tests

## Database backup and migration

Read **docs/DATABASE-BACKUP-MIGRATION.md** before creating, committing, or restoring a database archive. The repository is public: only encrypted .dump.enc archives may be committed. Never commit .env, database URLs, bot tokens, encryption keys, or plaintext .dump files.
