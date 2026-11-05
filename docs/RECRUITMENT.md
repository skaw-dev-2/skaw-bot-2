# SKAW Recruitment Manager

The Recruitment Manager is a standalone SKAW workflow for employment applications and business partnerships. It does not reuse the legacy \`/ticket\` or \`/apply\` persistence rules.

## Command

Use \`/recruitment panel\` with the Discord **Manage Server** permission. The dashboard is ephemeral and restricted to the administrator who opened it.

## First-time setup

1. Open **Profiles** and configure each position or partnership profile. Five starter profiles are provisioned on first startup: Mechanic, Trucker, Builder, Modshoper and Partnership. They are deliberately disabled until reviewed and configured.
2. For each profile, edit its name, type, division and channel prefix; add the profile description, criteria, requirements, terms, benefits and manual form template.
3. Configure reviewer roles, a private ticket category and an optional information channel for each profile. Reviewer access is scoped to the profile snapshot attached to each application.
4. Open **Panel Content** and select the public recruitment channel, transcript archive channel and recruitment log channel. Edit the general copy and appearance.
5. Enable only profiles that are ready to receive submissions, then publish the public panel.

## Applicant flow

Members select a profile from the public dropdown. The bot responds ephemerally with the profile details and an **Apply** button. Applying creates a private channel and posts a manual form template. Applicants type their answers and upload evidence directly in that channel, then select **Submit for Review**.

Applications are unlimited per member and per profile. There is no per-member cooldown or one-pending-application lock. Duplicate processing of the same Discord interaction is guarded by the unique interaction ID in PostgreSQL.

## IDs and numbering

A PostgreSQL upsert counter assigns one increasing sequence per guild across every profile type. Public application IDs use \`SKAW-REC-000001\`; channel names use the profile prefix plus a four-digit minimum sequence, such as \`mechanic-0001\` or \`partnership-0002\`. The sequence does not reset when a profile is changed or archived.

## Application and ticket states

Application status and ticket status are stored separately. Application statuses: \`awaiting_submission\`, \`submitted\`, \`under_review\`, \`interview\`, \`partnership_discussion\`, \`revision_required\`, \`accepted\`, \`rejected\`, and \`withdrawn\`. Ticket status: \`creating\`, \`creation_failed\`, \`open\`, \`closed\`, and \`archived\`. Closing a ticket does not reject an application.

Profile-scoped reviewers may claim/unclaim applications, change application status from the ticket controls, close/reopen tickets, write private internal notes from the ticket and archive tickets. Internal notes are stored in the Recruitment event table, not posted to the applicant-visible channel. Archiving generates HTML transcript data in PostgreSQL and optionally sends the transcript to the configured archive channel; it retrieves up to 1,000 messages in pages and clearly marks the transcript when older history exceeds that cap. The channel is retained rather than deleted.

## PostgreSQL, migration and backups

Recruitment requires a healthy PostgreSQL connection and fails closed in degraded in-memory mode. Its tables are included in the shared auto-create/migration schema, encrypted-backup required-table checks and restore verification checks.

Run \`npm run migrate\` before deployment when your release process uses explicit migrations. Run \`npm run test:recruitment\` to test the pure helpers and transcript escaping. The database tables are additive and are not destructive to existing ticket/application tables.

## Permissions

The bot needs Manage Channels to create private application channels, and channel permissions must allow it to view and send messages, manage overwrites and read history. Configure valid profile-specific reviewer roles and ensure the bot role is high enough for any accepted role it will assign. Server administrators with Manage Server can access the management dashboard and global review view.

## Current scope

This release includes the central panel, dynamic profile creation/edit/enable/disable/archive, profile-specific reviewer access, manual ticket forms, unlimited applications, persistent numbering, application/ticket status separation, claim controls, internal notes, transcript archiving, audit events and recovery of channel creation interrupted before the channel ID was saved.

Automatic reminder schedules, timed auto-close/retention policies, adding/removing additional ticket participants, ticket move/rename controls, full dashboard search/filtering and explicit delete-channel retention controls are not part of this initial build.
