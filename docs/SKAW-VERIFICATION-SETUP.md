# SKAW Verification System V2

SKAW Verification is the IC-name registration flow for Discord members. All administrator configuration is managed from one private Discord dashboard:

`/verification panel`

## Dashboard sections

- **Overview** — system status, published panel, selected channel and role summary.
- **General** — verification channel, optional member log channel, and enable/disable control.
- **Roles** — one Unverified role and up to 25 reward roles assigned after registration.
- **Appearance** — panel title, description, banner image URL, footer text, footer icon URL, and embed color.
- **Guide** — member instructions shown by the public Guide button.
- **Members** — member selection, manual registration, verification reset, and explicit role synchronization.
- **Activity** — recent member registration, IC-name update, and reset history.
- **Preview / Publish** — private panel preview and publish/update of the configured public message.

There is no separate administrator audit-log feature. Activity history is limited to member verification operations.

## Requirements

The bot needs:

- Manage Roles
- Manage Nicknames
- A highest role positioned above the Unverified and every configured reward role
- View Channel, Send Messages, Embed Links, and Read Message History in the verification channel
- View Channel, Send Messages, and Embed Links in the optional member log channel

The Unverified role must be able to view the verification channel. The system checks this when enabling and publishing the panel.

## Recommended channel permissions

1. Allow Unverified to view the verification channel so new members can see Register and Guide.
2. Restrict general member categories/channels from Unverified. Do not rely on role assignment alone to hide channels; Discord channel permission overwrites control visibility.
3. Give the intended reward roles access to the member categories/channels.
4. Review other roles and member-specific channel overwrites. Other grants may still expose restricted channels.

## First-time setup

1. Invite the bot with Manage Roles and Manage Nicknames.
2. Place the bot's highest role above Unverified and all reward roles.
3. Open `/verification panel`.
4. In **General**, select a text verification channel.
5. In **Roles**, select one Unverified role and at least one reward role. Up to 25 reward roles can be selected.
6. In **Appearance** and **Guide**, customize the public panel and member instructions.
7. In **General**, enable the system. The dashboard validates the roles, channel, and bot permissions.
8. Use **Preview** to inspect the panel privately, then **Publish** to publish or update the public panel.

The bot edits the saved panel message when it still exists. If the channel changes or the prior message no longer exists, the bot posts a new panel and saves its message ID. Buttons on old panels are rejected.

## Member experience

1. On join, the bot assigns Unverified when the system is enabled and the member does not already have an active verified registration record.
2. The member opens Register and enters first and last IC name.
3. Each name part must contain letters only. Numbers, spaces, and symbols are rejected.
4. The nickname is formatted as `First_Last` and must fit Discord's 32-character nickname limit.
5. On success, the bot applies every configured reward role, removes Unverified, saves the IC registration, and returns a private success message.
6. If another member already uses the same normalized IC name, the member receives a warning but registration is not blocked.
7. Members can submit the form again to update their IC name. Existing values are prefilled when available.

## Existing members and role changes

Changing the configured reward roles does not automatically modify members who were already verified. Their existing role assignment stays as-is.

An administrator can select a member in **Members** and choose **Update Roles**. This explicitly synchronizes that member with the latest reward-role configuration without asking them to register again. The system only removes roles it previously recorded as managed by Verification; unrelated roles are preserved.

**Reset Verification** adds Unverified and removes the reward roles recorded as managed by Verification. It preserves the member's IC record and sets the status to pending so the member can submit registration again.

**Manual Registration** lets an administrator register a selected member from the dashboard.

## Storage and failure behavior

Configuration, member records, duplicate-name index, and the latest 1,000 member activity entries are stored in the bot's existing PostgreSQL-backed key-value storage. No new SQL table or schema migration is required.

The feature refuses to operate in in-memory degraded database mode. If a registration write fails after Discord nickname or role changes, the service attempts to roll those changes back and reports the error.
