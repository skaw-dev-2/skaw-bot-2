# SKAW Verification System

SKAW Verification is the IC-name registration flow for Discord members. It is separate from the legacy account-age/server-size verification service.

## Requirements

The bot needs:

- Manage Roles
- Manage Nicknames
- A highest role positioned above both Verified and Unverified
- View Channel, Send Messages, Embed Links, and Read Message History in the verification channel
- View Channel, Send Messages, and Embed Links in the optional staff log channel

The Unverified role must be able to view the verification channel. The setup command checks this before saving the configuration.

## Recommended channel permissions

1. Allow Unverified to view the verification channel so new members can see the Register and Guide buttons.
2. Restrict general member categories/channels from Unverified. Do not rely on the role assignment alone to hide channels; Discord channel permission overwrites control visibility.
3. Give Verified the intended access to general member categories/channels.
4. Review other roles and member-specific channel overwrites. A separate role or member overwrite may still grant access to a restricted channel.

## Configure and publish

Run /verification setup and select:

- verified-role: role assigned after successful registration
- unverified-role: role assigned to new arrivals
- channel: channel for the registration panel
- log-channel: optional private staff log channel
- panel-title, panel-description, guide-text, image-url: optional panel customization

Then run /verification publish. Running publish again updates the stored panel message instead of creating a duplicate when the original message still exists.

## Member experience

1. On join, the bot assigns Unverified when this feature is enabled for the guild.
2. The member opens Register and enters first and last IC name.
3. Each name part must contain letters only. Numbers, spaces, and symbols are rejected.
4. The nickname is formatted as First_Last and must fit Discord's 32-character nickname limit.
5. On success, the bot assigns Verified, removes Unverified, stores the registration, and returns an ephemeral success message.
6. If another member already uses the same normalized IC name, the member receives a warning but registration is not blocked.
7. The member can submit the form again to update their IC name. Existing form values are prefilled when available.

Members already in the server before setup are not modified automatically. This avoids unexpectedly changing existing role access. Administrators can use /verification manual for an individual registration or /verification reset when a member must register again.

## Administrator commands

- /verification setup — configure roles, channel, optional log channel, and panel content
- /verification publish — publish or update the panel
- /verification status — inspect the configuration
- /verification logs — inspect recent registration actions
- /verification manual — register a selected member
- /verification reset — restore Unverified and require the selected member to register again

## Storage and failure behavior

Configuration, member records, duplicate-name index, and the latest 1,000 activity entries are stored in the bot's existing PostgreSQL-backed key-value storage. No new SQL table or schema migration is required.

Registration requires PostgreSQL to be available. If a write fails after Discord nickname or role changes, the service attempts to roll those changes back and reports an error. The feature refuses to operate in the in-memory degraded database mode.
