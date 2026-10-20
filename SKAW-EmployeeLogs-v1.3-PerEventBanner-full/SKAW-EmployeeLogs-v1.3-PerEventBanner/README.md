# SKAW Employee Logs v1.3 — Corporate Edition with Per-Event Banners

A panel-driven personnel record feature for TitanBot / SKAW GROUP using existing discord.js v14 components and `client.db`. All six output types are professional blue-accent Discord embeds with consistent typography, Unicode emoji markers, optional banners per exact event, automatic issuer identity, timestamp, and an optional server sticker attached to the same message. Per-event banners are selected independently; older global banner configuration remains a fallback.

## Included record types

- 📋 Employee Activity Record — sign in, sign out, resignation, or a custom activity.
- 🏆 Employee Promotion Letter — previous rank and new rank.
- 🔄 Employee Mutation Record — previous position, new position, and mutation details.
- 🛡️ Employee Blacklist Notice — position and reason.
- ⛔ Employee Dismissal Notice — position and reason.
- ⚠️ Employee Warning Notice — warning level (for example `1/2`) and reason.

The standard visual style uses SKAW blue `#2563eb`, `SKAW GROUP • PEOPLE OPERATIONS` branding, labelled fields, a footer, and Discord's message timestamp. Emoji markers are standard Unicode, so they do not depend on custom server emoji availability. The image banner appears beneath the embed content. Sign In, Sign Out, Resignation, other Employee Activity, Promotion, Mutation, Blacklist, Dismissal, and Warning may each have their own image.

## Visual preview (illustrative)

```text
🏢 SKAW GROUP • PEOPLE OPERATIONS
📋  EMPLOYEE ACTIVITY RECORD
WORKFORCE • ACTIVITY REGISTER

👤  EMPLOYEE        @Member
🏷️  POSITION        @SKAW Employee
📌  ACTIVITY        Personal Resignation
🧾  RECORDED BY     @Staff

Regards,
SKAW Management.
[optional full-width SKAW banner image]
SKAW GROUP • PEOPLE OPERATIONS  •  Timestamp
```

The real message is a Discord embed with a blue left accent. A configured sticker is sent as a separate native Discord sticker alongside the embed, not embedded into the image itself.

## Safe installation

1. Extract `SKAW-EmployeeLogs-v1.3-PerEventBanner` beside—not inside—the TitanBot repository. Example layout:

   ```text
   /workspaces/
   ├── skaw-bot/
   └── SKAW-EmployeeLogs-v1.3-PerEventBanner/
   ```

2. From the root of `/workspaces/skaw-bot`, run the installer using the package's actual path:

   ```bash
   node ../SKAW-EmployeeLogs-v1.3-PerEventBanner/scripts/install-skaw-employee-logs-v1.3.mjs
   ```

   If you extracted it elsewhere, locate the installer first:

   ```bash
   find /workspaces -type f -name "install-skaw-employee-logs-v1.3.mjs" -print
   ```

3. The installer backs up every target file it will replace and adds the interaction listener to `src/app.js` only if the import/hook is not already present. No package dependency or SQL migration is added. Save the printed backup path.

4. Run the static checker and local unit-style test from the TitanBot repo root:

   ```bash
   node scripts/check-employee-logs-v1.3.mjs
   node scripts/test-employee-logs-v1.3.mjs
   ```

   The unit-style test uses the installed `discord.js` library and mocked database/channel objects; it does not send messages to a live Discord server.

5. Review the result before committing or pushing:

   ```bash
   git status --short
   git --no-pager diff -- src/app.js
   git --no-pager diff --stat
   ```

   Do not run `npm audit fix` as part of this feature installation.

## Configure the logs

All setup commands are restricted to server members with **Manage Server** permission. Configure one destination channel for each record type: repeat `/employee-logs set-channel`, choose a `type`, and choose its destination channel. Use `/employee-logs status` to review the configuration.

Install an interactive panel in your staff channel with `/employee-logs panel` and choose the channel. Staff with **Manage Server** permission can select a record type, choose the member and relevant role(s), then fill out the modal. The issuing staff member is recorded automatically in the embed.

## Banner image

Set an optional full-width banner below all log embeds:

```text
/employee-logs set-banner url:<direct-https-image-url>
```

Use a direct HTTPS image URL that Discord can render, such as a Discord CDN image URL. A normal webpage URL may not render as an image. The default banner is used only when the exact event has no individual banner. To remove the fallback, use `/employee-logs clear-banner`.

### Separate banner per log/event

Use `/employee-logs set-event-banner event:<event> url:<direct-https-image-url>` to set a unique banner for one event. Supported events:

- `employee-sign-in` — Sign In
- `employee-sign-out` — Sign Out
- `employee-resignation` — Personal Resignation
- `employee-other` — Other Employee Activity
- `promotion`, `mutation`, `blacklist`, `dismissal`, `warning`

For Employee Activity, the system matches the Activity text from the form. Text such as `Sign In`, `Login`, or `Clock In` uses the Sign In banner; `Sign Out`, `Logout`, or `Clock Out` uses Sign Out; text containing resignation/resign uses the Resignation banner; anything else uses the Other Activity banner. If an exact banner is not configured, the default banner (if set) is used. Otherwise, no image is attached.

Remove one override with `/employee-logs clear-event-banner event:<event>`. `/employee-logs status` displays which event overrides are configured.

## Optional sticker support

You can attach one available server sticker to one particular log type. This is optional; emoji markers are still shown even if no sticker is configured. In Discord Developer Mode, copy the ID of a sticker that is available in the current server, then use:

```text
/employee-logs set-sticker type:<log-type> sticker_id:<sticker-id>
```

To remove it for that log type, use `/employee-logs clear-sticker type:<log-type>`. `/employee-logs status` displays whether a sticker ID is configured. Stickers are sent together with the embed using Discord's native message sticker option. If Discord rejects the sticker (invalid/unavailable sticker or missing permission), the service retries the message with the embed alone so that the official log record is not lost. Make sure the sticker belongs to or is usable in the server and that the bot can use it.

## Required bot permissions

The bot needs `View Channel`, `Send Messages`, and `Embed Links` in each destination channel. Sticker use may require additional server/sticker availability permissions. The app uses the existing `client.db` key `guild:<guildId>:employee_logs`; the config stores per-type destination channel IDs, optional banner URL, per-type sticker IDs, per-event banner overrides, per-type sticker IDs, and update metadata.

## Rollback

Use the backup path printed by the installer. Run this from the TitanBot repository root:

```bash
node ../SKAW-EmployeeLogs-v1.3-PerEventBanner/scripts/rollback-skaw-employee-logs-v1.3.mjs /tmp/skaw-employee-logs-v1.3-backup-<timestamp>
```

Replace `<timestamp>` with the actual printed folder. Then check `git status --short`. If the package is in a different directory, adjust the rollback script path accordingly.

## Validation scope

The static checker runs JavaScript syntax checks and validates expected integration points, all six templates, branded embed style, actor recording, banner/sticker configuration, safe mentions, and startup handler integration. This does not prove live Discord permissions, sticker availability, or Railway behavior; test the workflow in your server after deployment before relying on it for official HR records.
