# SKAW Role Access Manager — Live Server Test Plan

## Purpose

Test the Role Access Manager against the real SKAW Discord guild while keeping the currently running SKAW Bot, existing management roles, and operational channels untouched.

**Do not deploy this feature branch over the currently running production bot for the first live test.** Use a separate QA bot application and Railway service.

## 1. Prepare an isolated QA runtime

1. Create a separate Discord application/bot, for example **SKAW Access QA**. Do not reuse the production bot token.
2. Invite it to the existing SKAW Discord server with the bot and applications.commands OAuth scopes.
3. Configure a separate Railway service from branch feature/skaw-role-access-manager.
4. Use a separate PostgreSQL database for the QA service. Do not point it to the production database.
5. Set the runtime variables using the names expected by this repository:
   - DISCORD_TOKEN — QA bot token
   - CLIENT_ID — QA application ID
   - NODE_ENV=production
   - POSTGRES_URL or DATABASE_URL — QA-only PostgreSQL connection URL
   - OWNER_IDS — optional operator IDs, if needed by other bot features
   - GUILD_ID — SKAW Discord guild ID (setup compatibility)
6. Never paste bot tokens or database passwords into chat, source files, commits, or screenshots.

## 2. Restrict the QA bot role hierarchy

1. Create a temporary role named **RA-TEST**.
2. Give RA-TEST no server-level permissions. Place it immediately above @everyone.
3. Move the QA bot's managed role immediately above RA-TEST, but below every existing SKAW operational role.
4. Give the QA bot role only the permissions needed for the test: Manage Roles, View Channels, Send Messages, Read Message History, and Embed Links.
5. Confirm in Server Settings → Roles that the QA bot role is not above CEO, Management, division, workshop, or other active company roles.
6. Do not assign the QA bot or RA-TEST to any real employee account.

This hierarchy is an important safety boundary: Discord will reject attempts by the QA bot to manage roles at or above its highest role. It does not replace careful target selection.

## 3. Create temporary channels

Create a temporary category named **RA-TEST** with two temporary text channels:

- **#ra-test-synced** — leave this channel synchronized with its category.
- **#ra-test-unsynced** — deliberately make this channel's permission overwrites unsynchronized from the category.

Keep all test channels separate from existing SKAW categories. Do not move, rename, or edit existing production channels for this test.

Add only the QA bot role and the RA-TEST role to the access rules needed for these temporary channels. Use a separate test member account that has no Management, Administrator, or other operational roles if available.

## 4. Preflight checks — read-only only

After the QA bot is online and /access has registered:

1. Run /access panel.
2. Inspect RA-TEST with /access inspect.
3. Run /access channels for RA-TEST.
4. Run /access member for the test member.
5. Run /access compare for RA-TEST and another non-sensitive role if a comparison is needed.
6. Run /access health and treat findings as review prompts, not automatic proof of a problem.
7. Check that role names, channel names, counts, category sync state, and effective access match the actual SKAW server.

Do not make any permission changes during this stage. If the QA bot cannot see or inspect the test category correctly, stop and fix its test-category access first.

## 5. Controlled permission-change tests

Only test RA-TEST and the two RA-TEST channels. Do not select @everyone, management roles, employee roles, workshop roles, production categories, or production channels.

### Test A — single server permission bit

1. Open /access panel and select RA-TEST.
2. Open **Edit Server Permissions**.
3. Use a low-impact permission such as **Use External Emojis**, only if the acting manager has that permission or is the server owner.
4. Preview the change and verify the target role and permission name before confirming.
5. Confirm once, then inspect the role again.
6. Verify unrelated server permission flags did not change.
7. Revoke the test permission and inspect again.

The service captures a role snapshot before the first successful mutation. Confirm the backup ID and audit-persisted result in the success response.

### Test B — one channel overwrite

1. Open the bulk channel editor for RA-TEST.
2. Select only #ra-test-unsynced.
3. Choose **View Channel**, then preview ALLOW.
4. Confirm the preview names only RA-TEST and #ra-test-unsynced.
5. Confirm and verify access with the test member.
6. Repeat with DENY, then INHERIT, checking that other overwrite flags remain unchanged.

Do not use @everyone as the target role.

### Test C — category synchronization

1. Select only the RA-TEST category, not multiple unrelated categories.
2. Verify that the preview clearly identifies the category and warns about synchronized child channels.
3. Apply a low-risk test state.
4. Confirm the synchronized child follows the category change.
5. Confirm the unsynchronized child retains its independent overwrite.
6. Restore the original test-category state before moving on.

If the UI does not make the category's impact clear, cancel the preview and do not apply it.

### Test D — effective member access

After each channel test, run /access member for the test member. Confirm that the result reflects the combination of @everyone, RA-TEST, and the member's channel overwrites.

### Test E — audit and external change monitor

1. Run /access audit and confirm the Role Access Manager change is recorded.
2. Wait at least 20 seconds after the last bot-managed permission change so its internal-event marker has expired.
3. Make one low-risk manual permission change to RA-TEST in Discord Server Settings.
4. Run /access audit again and confirm an external role/channel update entry appears.
4. Treat the actor as unresolved unless the audit record explicitly identifies one; gateway update events alone do not guarantee actor attribution.

## 6. Backup and restore test

1. Run /access backups for RA-TEST and record the backup ID created before a test change.
2. Run /access restore with that backup ID.
3. Read the full restore preview carefully. Restore replaces the selected role's server permission bitfield and its saved channel overwrites; it is not a single-bit undo.
4. Confirm only if the backup belongs to RA-TEST and the preview is expected.
5. Verify the role and test-channel permissions against the original baseline.
6. Check the safety-backup ID and audit result returned after restore.

Do not restore a backup for an operational role during this live test.

## 7. Stop conditions

Stop immediately and make no further changes if any of the following occurs:

- A preview names a role or channel other than the intended test objects.
- The bot role is above any operational role.
- The database is in memory fallback/degraded mode.
- A backup is not created or the response reports audit persistence failure.
- The test member unexpectedly gains access to a production channel.
- A synchronized/unsynchronized channel behaves differently from the preview.
- A restore reports that automatic rollback failed.
- Any active SKAW role or channel changes unexpectedly.

If a change is unexpected, preserve the response, backup ID, and audit entry. Do not attempt repeated edits to “fix” the issue. Review the exact backup and state first.

## 8. Cleanup

After all tests pass:

1. Restore RA-TEST to its original baseline and verify it.
2. Remove RA-TEST from the test member.
3. Remove the test member's temporary access if applicable.
4. Remove the QA bot from the test category, then remove it from the server when QA is complete.
5. Delete the temporary category and channels.
6. Delete the RA-TEST role.
7. Keep the QA database and audit records until the final review is complete.

## 9. Production release gate

Only after the live test passes:

1. Review the Draft pull request and the final GitHub Actions checks.
2. Approve and merge the feature branch to main.
3. Confirm the production Railway service is connected to the intended repository and main branch.
4. Confirm production PostgreSQL is healthy and backed up.
5. Deploy the production bot during a quiet window.
6. Verify /access using read-only commands first.
7. Enable actual production permission changes only after a second reviewer checks the target and preview.

The QA bot service/database and production bot service/database must remain separate throughout testing.
