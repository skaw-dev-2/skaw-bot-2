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

## SKAW Group Website Integration

The bot exposes a signed server-to-server notification endpoint for the SKAW Group website. It is used for short notifications about new Contact Center inquiries, partnership proposals, Support Center requests, and career applications.

### Configure the bot host

Set these environment variables on the bot service:

- `SKAW_WEBSITE_WEBHOOK_SECRET` — a long random secret shared with the website's `SKAW_BOT_WEBHOOK_SECRET`. Keep it private.
- `SKAW_WEBSITE_NOTIFICATIONS_CHANNEL_ID` — optional ID of a private Discord text channel where management notifications should be sent. If omitted, the bot sends direct messages to the users already listed in `OWNER_IDS`.

The endpoint is mounted on the existing Express web server at:

```text
POST /integrations/website
Content-Type: application/json
```

The bot host must already have a public HTTPS base URL so the website can reach this route. Use that base URL plus `/integrations/website` as the website's `SKAW_BOT_WEBHOOK_URL`.

### Security and payload handling

- HMAC-SHA256 signature covers the timestamp, event ID, and exact raw request body.
- Requests more than five minutes from server time are rejected.
- Event IDs are de-duplicated in process memory for ten minutes.
- Only minimal summaries and reference IDs are sent to Discord. Full inquiry/application details remain in the protected website CMS.
- The endpoint does not read or write the bot PostgreSQL database.

After setting environment variables, restart the bot process. Verify `/health` and `/ready`, then submit one controlled test inquiry from the website. Do not put the shared secret in client-side variables, source code, logs, or Discord messages.

### Tests

```bash
npm run test:website-webhook
```
