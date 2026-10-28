# TitanBot

Modular Discord bot for SKAW Group.

## Requirements

- Node.js 20 or newer
- Discord bot credentials
- Database configuration for persistent storage

## Run locally

Install dependencies:

```bash
npm ci
```

Start the bot:

```bash
npm start
```

Configure the environment and application settings for your deployment before starting the bot.

## Maintenance scripts

- `npm run migrate:check` — check database migrations
- `npm run migrate:status` — inspect migration status
- `npm run test:role-templates` — run role template tests
- `npm run test:employee-logs` — run employee log tests
