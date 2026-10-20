# Changelog — SKAW Employee Logs

## v1.3.0 — Per-Event Banner Profiles
- Added separate banner configuration for Sign In, Sign Out, Personal Resignation, other employee activity, Promotion, Mutation, Blacklist, Dismissal, and Warning.
- Employee banner is selected automatically from the entered Activity text.
- Added `/employee-logs set-event-banner` and `/employee-logs clear-event-banner`.
- Kept `/employee-logs set-banner` as a default/fallback banner for compatibility with v1.2 configuration.
- Added per-event banner status to `/employee-logs status`.
- Existing channel routing, sticker configuration, panel workflow, data key, and templates are preserved.
