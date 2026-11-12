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


## SKAW Group website notifications

The bot exposes a signed server-to-server endpoint at `POST /api/integrations/website/events`. It accepts HMAC-SHA256 signed JSON notifications from the SKAW Group website and posts a compact embed to a private Discord channel.

Configure these variables on the bot host:
- `SKAW_WEBSITE_WEBHOOK_SECRET`: a long random secret. It must exactly match `SKAW_BOT_WEBHOOK_SECRET` on the website.
- `SKAW_WEBSITE_NOTIFICATION_CHANNEL_ID`: the private Discord text channel where website intake notifications should be posted.

Configure these variables on the website's Vercel project:
- `SKAW_BOT_WEBHOOK_URL`: the full HTTPS endpoint URL, for example `https://YOUR-BOT-HOST/api/integrations/website/events`.
- `SKAW_BOT_WEBHOOK_SECRET`: the same secret configured on the bot host.

The endpoint rejects requests without a valid HMAC signature, validates event types and fields, suppresses duplicate event IDs while the bot process is running, and does not include submitter contact details or full message contents in Discord notifications. Website forms continue to save to the website CMS when bot notifications are unavailable.
