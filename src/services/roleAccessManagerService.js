import { randomUUID } from 'node:crypto';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

const DATA_VERSION = 1;
const AUDIT_LIMIT = 500;
const BACKUP_LIMIT = 40;
const CHANGE_TTL_MS = 10 * 60 * 1000;
const INTERNAL_EVENT_TTL_MS = 15 * 1000;
const pendingChanges = new Map();
const editorSessions = new Map();
const internalChangeMarkers = new Map();

const PERMISSION_GROUPS = [
  { key: 'server', label: 'Server & Administration' },
  { key: 'membership', label: 'Membership & Moderation' },
  { key: 'text', label: 'Text & Community' },
  { key: 'voice', label: 'Voice & Stage' },
  { key: 'events', label: 'Events, Expressions & Apps' },
  { key: 'other', label: 'Other Permissions' },
];

const HIGH_RISK_PERMISSIONS = [
  'Administrator',
  'ManageGuild',
  'ManageRoles',
  'ManageChannels',
  'ManageWebhooks',
  'BanMembers',
  'KickMembers',
  'ModerateMembers',
  'ViewAuditLog',
];

const PAGE_SIZE = 18;

function permissionBit(flagName) {
  const bit = PermissionFlagsBits[flagName];
  return typeof bit === 'bigint' ? bit : null;
}

function hasRawBit(bitfield, flagName) {
  const bit = permissionBit(flagName);
  if (bit === null) return false;
  return (BigInt(bitfield ?? 0) & bit) === bit;
}

function groupPermission(flagName) {
  if ([
    'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels',
    'ViewAuditLog', 'ManageWebhooks', 'ManageEvents', 'ViewGuildInsights',
  ].includes(flagName)) return 'server';
  if ([
    'KickMembers', 'BanMembers', 'ModerateMembers', 'ChangeNickname',
    'ManageNicknames',
  ].includes(flagName)) return 'membership';
  if ([
    'SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads',
    'CreatePrivateThreads', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory',
    'MentionEveryone', 'UseExternalEmojis', 'UseExternalStickers', 'AddReactions',
    'ManageMessages', 'ManageThreads', 'UseApplicationCommands',
    'UseExternalApps', 'SendTTSMessages', 'CreatePolls', 'PinMessages',
    'ViewChannel',
  ].includes(flagName)) return 'text';
  if ([
    'Connect', 'Speak', 'Stream', 'MuteMembers', 'DeafenMembers',
    'MoveMembers', 'UseVAD', 'PrioritySpeaker', 'RequestToSpeak',
    'UseSoundboard', 'UseExternalSounds', 'SetVoiceChannelStatus',
  ].includes(flagName)) return 'voice';
  if ([
    'CreateEvents', 'ManageEvents', 'CreateGuildExpressions',
    'ManageGuildExpressions', 'UseEmbeddedActivities',
  ].includes(flagName)) return 'events';
  return 'other';
}

export function formatPermissionName(flagName) {
  return String(flagName || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .trim();
}

export function getPermissionEntries() {
  const entries = Object.keys(PermissionFlagsBits)
    .filter(name => permissionBit(name) !== null)
    .map(name => ({
      name,
      label: formatPermissionName(name),
      group: groupPermission(name),
      bit: permissionBit(name),
    }));

  const order = new Map(PERMISSION_GROUPS.map((group, index) => [group.key, index]));
  return entries.sort((a, b) =>
    (order.get(a.group) ?? 99) - (order.get(b.group) ?? 99) ||
    a.label.localeCompare(b.label),
  );
}

export function getRolePermissionState(role, flagName) {
  return hasRawBit(role?.permissions?.bitfield ?? 0n, flagName);
}

export function getRolePermissionPage(role, page = 0) {
  const entries = getPermissionEntries();
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const currentPage = Math.min(pages - 1, Math.max(0, Number(page) || 0));
  const items = entries.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
    .map(entry => ({
      ...entry,
      enabled: getRolePermissionState(role, entry.name),
    }));

  return { page: currentPage, pages, total: entries.length, items };
}

function isInspectableGuildChannel(channel) {
  return Boolean(
    channel &&
    channel.guild &&
    channel.permissionOverwrites?.cache &&
    !channel.isThread?.(),
  );
}

function channelTypeName(channel) {
  return ChannelType[channel?.type] || String(channel?.type ?? 'Unknown');
}

function channelCategoryName(channel) {
  if (channel?.type === ChannelType.GuildCategory) return channel.name;
  return channel?.parent?.name || 'Uncategorized';
}

function getChannelPermissionOverwriteState(channel, roleId, flagName) {
  const overwrite = channel?.permissionOverwrites?.cache?.get(String(roleId));
  if (!overwrite) return null;
  const bit = permissionBit(flagName);
  if (bit === null) return null;
  if ((overwrite.allow.bitfield & bit) === bit) return true;
  if ((overwrite.deny.bitfield & bit) === bit) return false;
  return null;
}

export function getRoleChannelAccessEntries(guild, role) {
  const channels = [...(guild?.channels?.cache?.values?.() || [])]
    .filter(isInspectableGuildChannel)
    .sort((a, b) =>
      channelCategoryName(a).localeCompare(channelCategoryName(b)) ||
      a.rawPosition - b.rawPosition ||
      a.name.localeCompare(b.name),
    );

  return channels.map(channel => {
    const effective = channel.permissionsFor(role);
    const overwrite = channel.permissionOverwrites.cache.get(role.id) || null;
    const isCategory = channel.type === ChannelType.GuildCategory;

    return {
      channelId: channel.id,
      name: channel.name,
      type: channelTypeName(channel),
      categoryName: isCategory ? 'CATEGORY' : channelCategoryName(channel),
      categoryId: channel.parentId || null,
      isCategory,
      canView: Boolean(effective?.has(PermissionFlagsBits.ViewChannel)),
      hasDirectOverwrite: Boolean(overwrite),
      overwriteState: getChannelPermissionOverwriteState(channel, role.id, 'ViewChannel'),
      isSynced: typeof channel.permissionsLocked === 'boolean' ? channel.permissionsLocked : null,
    };
  });
}

export function getMemberEffectiveAccessEntries(guild, member) {
  const channels = [...(guild?.channels?.cache?.values?.() || [])]
    .filter(isInspectableGuildChannel)
    .sort((a, b) =>
      channelCategoryName(a).localeCompare(channelCategoryName(b)) ||
      a.rawPosition - b.rawPosition ||
      a.name.localeCompare(b.name),
    );

  return channels.map(channel => {
    const effective = channel.permissionsFor(member);
    return {
      channelId: channel.id,
      name: channel.name,
      type: channelTypeName(channel),
      categoryName: channelCategoryName(channel),
      canView: Boolean(effective?.has(PermissionFlagsBits.ViewChannel)),
      canSendMessages: Boolean(effective?.has(PermissionFlagsBits.SendMessages)),
      canManageMessages: Boolean(effective?.has(PermissionFlagsBits.ManageMessages)),
      canConnect: Boolean(effective?.has(PermissionFlagsBits.Connect)),
    };
  });
}

export function compareRoleAccess(guild, firstRole, secondRole) {
  const permissionEntries = getPermissionEntries();
  const permissionDifferences = permissionEntries
    .map(entry => ({
      name: entry.name,
      label: entry.label,
      first: getRolePermissionState(firstRole, entry.name),
      second: getRolePermissionState(secondRole, entry.name),
    }))
    .filter(entry => entry.first !== entry.second);

  const firstChannels = new Map(
    getRoleChannelAccessEntries(guild, firstRole).map(item => [item.channelId, item]),
  );
  const secondChannels = new Map(
    getRoleChannelAccessEntries(guild, secondRole).map(item => [item.channelId, item]),
  );
  const channelDifferences = [];
  for (const [channelId, first] of firstChannels) {
    const second = secondChannels.get(channelId);
    if (second && first.canView !== second.canView) {
      channelDifferences.push({
        channelId,
        name: first.name,
        categoryName: first.categoryName,
        first: first.canView,
        second: second.canView,
      });
    }
  }

  return { permissionDifferences, channelDifferences };
}

export function analyzeGuildPermissionHealth(guild) {
  const issues = [];
  const roles = [...(guild?.roles?.cache?.values?.() || [])]
    .filter(role => role.id !== guild.id)
    .sort((a, b) => b.position - a.position);

  for (const role of roles) {
    if (getRolePermissionState(role, 'Administrator')) {
      issues.push({
        severity: 'critical',
        type: 'administrator_role',
        roleId: role.id,
        message: 'Role "' + role.name + '" has Administrator.',
      });
      continue;
    }

    const risky = HIGH_RISK_PERMISSIONS
      .filter(flag => flag !== 'Administrator' && getRolePermissionState(role, flag));
    if (risky.length >= 3) {
      issues.push({
        severity: 'warning',
        type: 'elevated_role',
        roleId: role.id,
        message: 'Role "' + role.name + '" has several elevated permissions: ' + risky.join(', ') + '.',
      });
    }
  }

  const channels = [...(guild?.channels?.cache?.values?.() || [])]
    .filter(channel => isInspectableGuildChannel(channel) && channel.type !== ChannelType.GuildCategory);

  let everyoneVisibleChannels = 0;
  let unsyncedChannels = 0;
  for (const channel of channels) {
    const everyoneAccess = channel.permissionsFor(guild.roles.everyone);
    if (everyoneAccess?.has(PermissionFlagsBits.ViewChannel)) everyoneVisibleChannels += 1;
    if (channel.permissionsLocked === false) unsyncedChannels += 1;
  }

  if (everyoneVisibleChannels > 0) {
    issues.push({
      severity: 'info',
      type: 'everyone_visible',
      message: everyoneVisibleChannels + ' channel(s) are visible to @everyone. Review whether this is intentional.',
    });
  }
  if (unsyncedChannels > 0) {
    issues.push({
      severity: 'info',
      type: 'unsynced_channels',
      message: unsyncedChannels + ' channel(s) have permission overwrites that are not synchronized with their category.',
    });
  }

  return {
    roleCount: roles.length,
    channelCount: channels.length,
    issues,
    criticalCount: issues.filter(item => item.severity === 'critical').length,
    warningCount: issues.filter(item => item.severity === 'warning').length,
    infoCount: issues.filter(item => item.severity === 'info').length,
  };
}

function auditKey(guildId) {
  return 'guild:' + guildId + ':role_access:audit:v' + DATA_VERSION;
}

function backupKey(guildId) {
  return 'guild:' + guildId + ':role_access:backups:v' + DATA_VERSION;
}

function requirePersistentDatabase(client) {
  const database = client?.db;
  if (!database?.get || !database?.set) {
    throw new Error('The database is not available. Permission changes are disabled until database storage is ready.');
  }
  const status = database.getStatus?.();
  if (database.isDegraded?.() || status?.isDegraded === true) {
    throw new Error('Permission changes are disabled while the database is in memory fallback mode. Restore PostgreSQL first so backups remain durable.');
  }
}

async function prependStoredRecord(client, key, record, maxItems) {
  const existing = await client.db.get(key, []);
  const items = Array.isArray(existing) ? existing : [];
  await client.db.set(key, [record, ...items].slice(0, maxItems));
}

export async function getRoleAccessAudit(client, guildId, limit = 20) {
  if (!client?.db?.get || !guildId) return [];
  const items = await client.db.get(auditKey(guildId), []);
  return (Array.isArray(items) ? items : []).slice(0, Math.min(100, Math.max(1, Number(limit) || 20)));
}

export async function getRoleAccessBackups(client, guildId, limit = 20) {
  if (!client?.db?.get || !guildId) return [];
  const items = await client.db.get(backupKey(guildId), []);
  return (Array.isArray(items) ? items : []).slice(0, Math.min(40, Math.max(1, Number(limit) || 20)));
}

async function saveAuditRecord(client, guildId, record) {
  try {
    await prependStoredRecord(client, auditKey(guildId), {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...record,
    }, AUDIT_LIMIT);
    return true;
  } catch {
    return false;
  }
}

async function captureRoleSnapshot(guild, role) {
  const channelOverwrites = [];
  const channels = [...guild.channels.cache.values()].filter(isInspectableGuildChannel);
  for (const channel of channels) {
    const overwrite = channel.permissionOverwrites.cache.get(role.id);
    if (!overwrite) continue;
    channelOverwrites.push({
      channelId: channel.id,
      allow: overwrite.allow.bitfield.toString(),
      deny: overwrite.deny.bitfield.toString(),
    });
  }

  return {
    version: DATA_VERSION,
    guildId: guild.id,
    roleId: role.id,
    roleName: role.name,
    rolePermissions: role.permissions.bitfield.toString(),
    channelOverwrites,
    capturedAt: new Date().toISOString(),
  };
}

async function saveBackup(client, guild, role, reason, actorId) {
  const snapshot = await captureRoleSnapshot(guild, role);
  const backup = {
    id: randomUUID().replaceAll('-', '').slice(0, 20),
    createdAt: new Date().toISOString(),
    createdBy: String(actorId),
    reason,
    snapshot,
  };
  await prependStoredRecord(client, backupKey(guild.id), backup, BACKUP_LIMIT);
  return backup;
}

async function fetchActorAndBot(guild, actorId) {
  const actor = await guild.members.fetch(actorId).catch(() => null);
  if (!actor) throw new Error('Your server member profile could not be verified. Refresh the server and try again.');
  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!botMember) throw new Error('Could not verify the bot member in this server.');
  return { actor, botMember };
}

function assertCanManageRole(actor, botMember, guild, role, options = {}) {
  const allowEveryoneChannel = options.allowEveryoneChannel === true;
  const isEveryone = String(role.id) === String(guild.id);

  if (isEveryone && !allowEveryoneChannel) {
    throw new Error('@everyone cannot be edited at server-permission level.');
  }
  if (role.managed) {
    throw new Error('This is an integration-managed role and cannot be edited by Role Access Manager.');
  }
  if (!actor.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error('You need Manage Roles permission to configure role permissions.');
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error('The bot needs Manage Roles permission before it can edit role permissions.');
  }
  if (actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(role) <= 0) {
    throw new Error('Rank protection blocked this action. Your highest role must be above the selected role.');
  }
  if (botMember.roles.highest.comparePositionTo(role) <= 0) {
    throw new Error('The bot role must be positioned above the selected role in Server Settings → Roles.');
  }
  if (!isEveryone && role.editable === false) {
    throw new Error('Discord reports that this role is not editable by the bot. Check the bot role hierarchy.');
  }
}

function assertPermissionChangeAllowed(actor, guild, flagName, nextValue) {
  if (flagName === 'Administrator' && actor.id !== guild.ownerId) {
    throw new Error('For safety, only the server owner can grant or revoke Administrator through this panel.');
  }
  const bit = permissionBit(flagName);
  if (bit === null) throw new Error('Unknown Discord permission flag.');
  if (nextValue === true && actor.id !== guild.ownerId &&
      !actor.permissions.has(bit) &&
      !actor.permissions.has(PermissionFlagsBits.Administrator)) {
    throw new Error('Discord permission hierarchy: you cannot grant a permission that you do not have yourself.');
  }
}

function assertChannelPermissionGrantAllowed(actor, guild, channel, flagName, nextValue) {
  if (nextValue !== true || actor.id === guild.ownerId ||
      actor.permissions.has(PermissionFlagsBits.Administrator)) return;
  const bit = permissionBit(flagName);
  if (bit === null) throw new Error('Unknown Discord permission flag.');
  const effective = channel.permissionsFor(actor);
  if (!effective?.has(bit)) {
    throw new Error('You cannot grant ' + flagName + ' in #' + channel.name +
      ' because you do not currently have that permission in the target channel.');
  }
}

function getOverwriteState(channel, roleId, flagName) {
  const overwrite = channel.permissionOverwrites.cache.get(String(roleId));
  if (!overwrite) return null;
  const bit = permissionBit(flagName);
  if (bit === null) return null;
  if ((overwrite.allow.bitfield & bit) === bit) return true;
  if ((overwrite.deny.bitfield & bit) === bit) return false;
  return null;
}

function markerKey(kind, id) {
  return kind + ':' + String(id);
}

function markInternalChange(kind, id) {
  internalChangeMarkers.set(markerKey(kind, id), Date.now() + INTERNAL_EVENT_TTL_MS);
}

export function consumeInternalRoleAccessEvent(kind, id) {
  const key = markerKey(kind, id);
  const expiresAt = internalChangeMarkers.get(key);
  if (!expiresAt) return false;
  internalChangeMarkers.delete(key);
  return expiresAt >= Date.now();
}

function cleanupEphemeralState() {
  const now = Date.now();
  for (const [token, item] of pendingChanges) {
    if (item.expiresAt <= now) pendingChanges.delete(token);
  }
  for (const [token, item] of editorSessions) {
    if (item.expiresAt <= now) editorSessions.delete(token);
  }
  for (const [key, expiresAt] of internalChangeMarkers) {
    if (expiresAt <= now) internalChangeMarkers.delete(key);
  }
}

export function createChannelEditorSession({ guildId, actorId, roleId, channelIds }) {
  cleanupEphemeralState();
  const ids = [...new Set((channelIds || []).map(String))].slice(0, 25);
  if (!ids.length) throw new Error('Select at least one channel.');
  const token = randomUUID().replaceAll('-', '').slice(0, 16);
  editorSessions.set(token, {
    guildId: String(guildId),
    actorId: String(actorId),
    roleId: String(roleId),
    channelIds: ids,
    expiresAt: Date.now() + CHANGE_TTL_MS,
  });
  return token;
}

export function getChannelEditorSession(token, actorId, guildId) {
  cleanupEphemeralState();
  const session = editorSessions.get(String(token));
  if (!session || session.actorId !== String(actorId) || session.guildId !== String(guildId)) return null;
  return session;
}

export function createRoleChannelAccessSession({ guildId, actorId, roleId, selectedCategoryId = null }) {
  cleanupEphemeralState();
  const token = randomUUID().replaceAll('-', '').slice(0, 16);
  const session = {
    kind: 'role-channel-visibility',
    token,
    guildId: String(guildId),
    actorId: String(actorId),
    roleId: String(roleId),
    selectedCategoryId: selectedCategoryId ? String(selectedCategoryId) : 'uncategorized',
    categoryPage: 0,
    channelPage: 0,
    desiredStates: {},
    expiresAt: Date.now() + CHANGE_TTL_MS,
  };
  editorSessions.set(token, session);
  return session;
}

export function getRoleChannelAccessSession(token, actorId, guildId) {
  cleanupEphemeralState();
  const session = editorSessions.get(String(token));
  if (!session || session.kind !== 'role-channel-visibility' ||
      session.actorId !== String(actorId) || session.guildId !== String(guildId)) return null;
  return session;
}

export function updateRoleChannelAccessSession(token, actorId, guildId, updates = {}) {
  const session = getRoleChannelAccessSession(token, actorId, guildId);
  if (!session) return null;
  if (Object.hasOwn(updates, 'selectedCategoryId')) {
    session.selectedCategoryId = String(updates.selectedCategoryId || 'uncategorized');
  }
  if (Object.hasOwn(updates, 'categoryPage')) {
    session.categoryPage = Math.max(0, Number(updates.categoryPage) || 0);
  }
  if (Object.hasOwn(updates, 'channelPage')) {
    session.channelPage = Math.max(0, Number(updates.channelPage) || 0);
  }
  session.expiresAt = Date.now() + CHANGE_TTL_MS;
  return session;
}

export function stageRoleChannelAccessStates(token, actorId, guildId, desiredStates = {}) {
  const session = getRoleChannelAccessSession(token, actorId, guildId);
  if (!session) throw new Error('This access panel expired. Reopen /access panel.');
  for (const [channelId, value] of Object.entries(desiredStates || {})) {
    if (typeof value !== 'boolean') continue;
    session.desiredStates[String(channelId)] = value;
  }
  session.expiresAt = Date.now() + CHANGE_TTL_MS;
  return session;
}

export function deleteRoleChannelAccessSession(token, actorId, guildId) {
  const session = getRoleChannelAccessSession(token, actorId, guildId);
  if (!session) return false;
  return editorSessions.delete(String(token));
}

export function createPendingRolePermissionChange({ guildId, actorId, roleId, flagName, nextValue, previousValue }) {
  cleanupEphemeralState();
  const token = randomUUID().replaceAll('-', '').slice(0, 16);
  const pending = {
    token,
    scope: 'server',
    guildId: String(guildId),
    actorId: String(actorId),
    roleId: String(roleId),
    flagName,
    nextValue: Boolean(nextValue),
    previousValue: Boolean(previousValue),
    expiresAt: Date.now() + CHANGE_TTL_MS,
  };
  pendingChanges.set(token, pending);
  return pending;
}

export function createPendingChannelPermissionChange({
  guildId, actorId, roleId, channelIds, flagName, nextValue, previousValues,
  nextValues = null, previousEffectiveValues = null,
}) {
  cleanupEphemeralState();
  const token = randomUUID().replaceAll('-', '').slice(0, 16);
  const pending = {
    token,
    scope: 'channel',
    guildId: String(guildId),
    actorId: String(actorId),
    roleId: String(roleId),
    channelIds: [...new Set((channelIds || []).map(String))].slice(0, 500),
    flagName,
    nextValue,
    nextValues: nextValues ? { ...nextValues } : null,
    previousValues: { ...previousValues },
    previousEffectiveValues: previousEffectiveValues ? { ...previousEffectiveValues } : null,
    expiresAt: Date.now() + CHANGE_TTL_MS,
  };
  pendingChanges.set(token, pending);
  return pending;
}

export function getPendingRolePermissionChange(token, actorId, guildId) {
  cleanupEphemeralState();
  const pending = pendingChanges.get(String(token));
  if (!pending || pending.actorId !== String(actorId) || pending.guildId !== String(guildId)) return null;
  return pending;
}

export function cancelPendingRolePermissionChange(token, actorId) {
  const pending = pendingChanges.get(String(token));
  if (!pending || pending.actorId !== String(actorId)) return false;
  pendingChanges.delete(String(token));
  return true;
}

export async function createServerPermissionPreview(client, guild, actorId, roleId, flagName, nextValue) {
  const role = guild.roles.cache.get(String(roleId)) || await guild.roles.fetch(String(roleId)).catch(() => null);
  if (!role) throw new Error('Selected role no longer exists.');
  const { actor, botMember } = await fetchActorAndBot(guild, actorId);
  assertCanManageRole(actor, botMember, guild, role);
  const bit = permissionBit(flagName);
  if (bit === null) throw new Error('Unknown Discord permission flag.');
  assertPermissionChangeAllowed(actor, guild, flagName, Boolean(nextValue));
  const previousValue = getRolePermissionState(role, flagName);
  if (previousValue === Boolean(nextValue)) throw new Error('No change needed. This permission already has the selected state.');
  return createPendingRolePermissionChange({
    guildId: guild.id,
    actorId,
    roleId: role.id,
    flagName,
    nextValue,
    previousValue,
  });
}

export async function createChannelPermissionPreview(client, guild, actorId, sessionToken, flagName, nextValue) {
  const session = getChannelEditorSession(sessionToken, actorId, guild.id);
  if (!session) throw new Error('This channel selection has expired. Reopen the Access Manager and select the channels again.');
  const role = guild.roles.cache.get(session.roleId) || await guild.roles.fetch(session.roleId).catch(() => null);
  if (!role) throw new Error('Selected role no longer exists.');
  const { actor, botMember } = await fetchActorAndBot(guild, actorId);
  assertCanManageRole(actor, botMember, guild, role, { allowEveryoneChannel: true });
  if (flagName === 'Administrator') {
    throw new Error('Administrator is a server-level permission and cannot be edited through channel overwrites.');
  }

  const previousValues = {};
  const validChannelIds = [];
  for (const channelId of session.channelIds) {
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!isInspectableGuildChannel(channel)) {
      throw new Error('A selected channel is no longer available or cannot receive permission overwrites. No changes were made.');
    }
    if (!channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error('The bot cannot manage role overwrites in #' + channel.name + '. Check its channel access and permissions. No changes were made.');
    }
    assertChannelPermissionGrantAllowed(actor, guild, channel, flagName, nextValue);
    previousValues[channelId] = getOverwriteState(channel, role.id, flagName);
    validChannelIds.push(channelId);
  }

  if (!validChannelIds.length) throw new Error('No valid channels were selected.');
  if (validChannelIds.every(id => previousValues[id] === nextValue)) {
    throw new Error('No change needed. All selected channels already have this permission state.');
  }

  return createPendingChannelPermissionChange({
    guildId: guild.id,
    actorId,
    roleId: role.id,
    channelIds: validChannelIds,
    flagName,
    nextValue,
    previousValues,
  });
}

export async function createRoleChannelVisibilityPreview(client, guild, actorId, sessionToken) {
  const session = getRoleChannelAccessSession(sessionToken, actorId, guild.id);
  if (!session) throw new Error('This access panel expired. Reopen /access panel.');

  const role = guild.roles.cache.get(session.roleId) || await guild.roles.fetch(session.roleId).catch(() => null);
  if (!role) throw new Error('Selected role no longer exists.');
  const { actor, botMember } = await fetchActorAndBot(guild, actorId);
  assertCanManageRole(actor, botMember, guild, role);

  if (getRolePermissionState(role, 'Administrator')) {
    throw new Error('This role has Administrator. Administrator bypasses channel visibility rules, so its channel access cannot be managed here.');
  }

  const desiredStates = session.desiredStates || {};
  const previousValues = {};
  const previousEffectiveValues = {};
  const nextValues = {};
  const channelIds = [];

  for (const [channelId, rawDesired] of Object.entries(desiredStates)) {
    if (typeof rawDesired !== 'boolean') continue;
    const channel = guild.channels.cache.get(String(channelId)) ||
      await guild.channels.fetch(String(channelId)).catch(() => null);
    if (!isInspectableGuildChannel(channel)) {
      throw new Error('A selected channel or category is no longer available. No changes were made.');
    }
    if (!channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error('The bot cannot manage access in #' + channel.name + '. Check its channel permissions. No changes were made.');
    }

    const currentEffective = Boolean(channel.permissionsFor(role)?.has(PermissionFlagsBits.ViewChannel));
    if (currentEffective === rawDesired) continue;

    assertChannelPermissionGrantAllowed(actor, guild, channel, 'ViewChannel', rawDesired);
    previousValues[channel.id] = getOverwriteState(channel, role.id, 'ViewChannel');
    previousEffectiveValues[channel.id] = currentEffective;
    nextValues[channel.id] = rawDesired;
    channelIds.push(channel.id);
  }

  if (!channelIds.length) {
    throw new Error('Belum ada perubahan akses. Centang atau hapus centang channel terlebih dahulu.');
  }

  return createPendingChannelPermissionChange({
    guildId: guild.id,
    actorId,
    roleId: role.id,
    channelIds,
    flagName: 'ViewChannel',
    nextValue: null,
    nextValues,
    previousValues,
    previousEffectiveValues,
  });
}

export async function applyPendingRolePermissionChange(client, guild, actorId, token) {
  requirePersistentDatabase(client);
  const pending = getPendingRolePermissionChange(token, actorId, guild.id);
  if (!pending) throw new Error('This preview is no longer available. It may have expired or been opened by another member. Start a new edit.');

  const role = guild.roles.cache.get(pending.roleId) || await guild.roles.fetch(pending.roleId).catch(() => null);
  if (!role) throw new Error('Selected role no longer exists. Nothing was changed.');
  const { actor, botMember } = await fetchActorAndBot(guild, actorId);
  assertCanManageRole(actor, botMember, guild, role, { allowEveryoneChannel: pending.scope === 'channel' });
  if (pending.scope === 'server') {
    assertPermissionChangeAllowed(actor, guild, pending.flagName, pending.nextValue);
    const currentValue = getRolePermissionState(role, pending.flagName);
    if (currentValue !== pending.previousValue) {
      pendingChanges.delete(token);
      throw new Error('The role permission changed after the preview was created. Refresh the panel and review the new state before applying.');
    }

    const backup = await saveBackup(client, guild, role, 'Before server permission change', actorId);
    const bit = permissionBit(pending.flagName);
    const currentBitfield = role.permissions.bitfield;
    const nextBitfield = pending.nextValue ? (currentBitfield | bit) : (currentBitfield & ~bit);
    markInternalChange('role', role.id);

    try {
      await role.setPermissions(nextBitfield, 'SKAW Role Access Manager: ' + pending.flagName + ' ' + (pending.nextValue ? 'granted' : 'revoked') + ' by ' + actorId);
    } catch (error) {
      internalChangeMarkers.delete(markerKey('role', role.id));
      throw new Error('Discord rejected this permission change. The saved backup remains available. ' + (error?.message || 'Unknown Discord API error.'));
    }

    const auditPersisted = await saveAuditRecord(client, guild.id, {
      action: 'server_permission_update',
      source: 'SKAW Role Access Manager',
      actorId: String(actorId),
      roleId: role.id,
      roleName: role.name,
      permission: pending.flagName,
      previousValue: pending.previousValue,
      nextValue: pending.nextValue,
      backupId: backup.id,
    });
    pendingChanges.delete(token);
    return { scope: 'server', role, permission: pending.flagName, previousValue: pending.previousValue, nextValue: pending.nextValue, backupId: backup.id, auditPersisted };
  }

  if (pending.scope === 'channel') {
    const channelRecords = [];
    for (const channelId of pending.channelIds) {
      const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
      if (!isInspectableGuildChannel(channel)) throw new Error('A selected channel no longer exists. No changes were made.');
      if (!channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageRoles)) {
        throw new Error('The bot cannot manage the overwrite in #' + channel.name + '. No changes were made.');
      }

      const nextValue = pending.nextValues
        ? pending.nextValues[channelId]
        : pending.nextValue;
      if (nextValue !== true && nextValue !== false && nextValue !== null) {
        throw new Error('The access change contains an invalid View Channel state. No changes were made.');
      }

      assertChannelPermissionGrantAllowed(actor, guild, channel, pending.flagName, nextValue);
      const currentValue = getOverwriteState(channel, role.id, pending.flagName);
      if (currentValue !== pending.previousValues[channelId]) {
        pendingChanges.delete(token);
        throw new Error('Permissions in #' + channel.name + ' changed after the preview. Refresh and review the new state. No changes were made.');
      }
      if (pending.previousEffectiveValues &&
          Boolean(channel.permissionsFor(role)?.has(PermissionFlagsBits.ViewChannel)) !==
            Boolean(pending.previousEffectiveValues[channelId])) {
        pendingChanges.delete(token);
        throw new Error('Effective visibility for #' + channel.name + ' changed after the preview. Refresh and review the new state. No changes were made.');
      }
      channelRecords.push({ channel, nextValue });
    }

    const backup = await saveBackup(client, guild, role, 'Before channel visibility update', actorId);
    const changed = [];
    const reason = 'SKAW Role Access Manager: ViewChannel visibility updated by ' + actorId;
    try {
      for (const record of channelRecords) {
        const { channel, nextValue } = record;
        markInternalChange('channel', channel.id);
        await channel.permissionOverwrites.edit(role.id, {
          [pending.flagName]: nextValue,
        }, { reason });
        changed.push(record);
      }
    } catch (error) {
      let rollbackFailed = false;
      for (const record of changed.reverse()) {
        const { channel } = record;
        try {
          markInternalChange('channel', channel.id);
          await channel.permissionOverwrites.edit(role.id, {
            [pending.flagName]: pending.previousValues[channel.id],
          }, { reason: 'SKAW Role Access Manager rollback after a partial visibility update' });
        } catch {
          internalChangeMarkers.delete(markerKey('channel', channel.id));
          rollbackFailed = true;
        }
      }
      await saveAuditRecord(client, guild.id, {
        action: 'channel_visibility_update_failed',
        source: 'SKAW Role Access Manager',
        actorId: String(actorId),
        roleId: role.id,
        roleName: role.name,
        permission: pending.flagName,
        channelIds: pending.channelIds,
        nextValues: pending.nextValues || null,
        rollbackFailed,
        error: String(error?.message || 'Unknown Discord API error').slice(0, 500),
        backupId: backup.id,
      });
      pendingChanges.delete(token);
      throw new Error(
        'Discord rejected part of the bulk visibility update. ' +
        (rollbackFailed
          ? 'Rollback could not restore every channel; use backup ' + backup.id + ' and inspect the audit log immediately.'
          : 'The bot rolled back the changes it had already applied. No partial change should remain.') +
        ' Original error: ' + (error?.message || 'Unknown Discord API error'),
      );
    }

    const auditPersisted = await saveAuditRecord(client, guild.id, {
      action: 'channel_visibility_update',
      source: 'SKAW Role Access Manager',
      actorId: String(actorId),
      roleId: role.id,
      roleName: role.name,
      permission: pending.flagName,
      nextValues: pending.nextValues || null,
      previousValues: pending.previousValues,
      channelIds: pending.channelIds,
      backupId: backup.id,
    });
    pendingChanges.delete(token);
    return {
      scope: 'channel',
      role,
      permission: pending.flagName,
      nextValue: null,
      channelRecords: channelRecords.map(record => record.channel),
      nextValues: pending.nextValues || Object.fromEntries(channelRecords.map(record => [record.channel.id, record.nextValue])),
      previousValues: pending.previousValues,
      backupId: backup.id,
      auditPersisted,
    };
  }

  throw new Error('Unknown permission change type.');
}

export async function recordExternalRolePermissionChange(client, oldRole, newRole) {
  if (!oldRole || !newRole || oldRole.permissions.bitfield === newRole.permissions.bitfield) return false;
  if (consumeInternalRoleAccessEvent('role', newRole.id)) return false;
  return saveAuditRecord(client, newRole.guild.id, {
    action: 'external_role_permission_update',
    source: 'Discord roleUpdate event (actor not resolved)',
    actorId: null,
    roleId: newRole.id,
    roleName: newRole.name,
    previousPermissions: oldRole.permissions.bitfield.toString(),
    nextPermissions: newRole.permissions.bitfield.toString(),
  });
}

export async function recordExternalChannelPermissionChange(client, oldChannel, newChannel) {
  if (!oldChannel?.permissionOverwrites?.cache || !newChannel?.permissionOverwrites?.cache) return false;
  if (consumeInternalRoleAccessEvent('channel', newChannel.id)) return false;

  const ids = new Set([
    ...oldChannel.permissionOverwrites.cache.keys(),
    ...newChannel.permissionOverwrites.cache.keys(),
  ]);
  const changes = [];
  for (const id of ids) {
    const oldOverwrite = oldChannel.permissionOverwrites.cache.get(id);
    const nextOverwrite = newChannel.permissionOverwrites.cache.get(id);
    const oldAllow = oldOverwrite?.allow.bitfield ?? 0n;
    const oldDeny = oldOverwrite?.deny.bitfield ?? 0n;
    const nextAllow = nextOverwrite?.allow.bitfield ?? 0n;
    const nextDeny = nextOverwrite?.deny.bitfield ?? 0n;
    if (oldAllow !== nextAllow || oldDeny !== nextDeny) {
      changes.push({
        targetId: id,
        targetType: nextOverwrite?.type ?? oldOverwrite?.type ?? null,
        previousAllow: oldAllow.toString(),
        previousDeny: oldDeny.toString(),
        nextAllow: nextAllow.toString(),
        nextDeny: nextDeny.toString(),
      });
    }
  }
  if (!changes.length) return false;

  return saveAuditRecord(client, newChannel.guild.id, {
    action: 'external_channel_permission_update',
    source: 'Discord channelUpdate event (actor not resolved)',
    actorId: null,
    channelId: newChannel.id,
    channelName: newChannel.name,
    overwrites: changes.slice(0, 50),
  });
}

export const ROLE_ACCESS_PAGE_SIZE = PAGE_SIZE;
export const ROLE_ACCESS_HIGH_RISK_PERMISSIONS = HIGH_RISK_PERMISSIONS;
export const ROLE_ACCESS_PERMISSION_GROUPS = PERMISSION_GROUPS;


function permissionOverwriteOptionsFromSnapshot(overwrite) {
  const allow = BigInt(overwrite?.allow ?? '0');
  const deny = BigInt(overwrite?.deny ?? '0');
  const options = {};
  for (const entry of getPermissionEntries()) {
    if ((allow & entry.bit) === entry.bit) options[entry.name] = true;
    else if ((deny & entry.bit) === entry.bit) options[entry.name] = false;
    else options[entry.name] = null;
  }
  return options;
}

async function applyRoleSnapshotToGuild(guild, role, snapshot, botMember, reason) {
  if (String(snapshot.guildId) !== String(guild.id) || String(snapshot.roleId) !== String(role.id)) {
    throw new Error('The backup does not belong to this server and role.');
  }
  if (snapshot.version !== DATA_VERSION || !/^\d+$/.test(String(snapshot.rolePermissions))) {
    throw new Error('This backup version or permission bitfield is not supported.');
  }

  const desiredOverwrites = new Map(
    (Array.isArray(snapshot.channelOverwrites) ? snapshot.channelOverwrites : [])
      .filter(item => item && /^\d{17,20}$/.test(String(item.channelId)))
      .map(item => [String(item.channelId), item]),
  );

  // Restore the role's full server bitfield from the snapshot.
  markInternalChange('role', role.id);
  await role.setPermissions(BigInt(snapshot.rolePermissions), reason);

  let restoredOverwrites = 0;
  let removedOverwrites = 0;
  let skippedDeletedChannels = 0;
  const channels = [...guild.channels.cache.values()].filter(isInspectableGuildChannel);

  for (const channel of channels) {
    const desired = desiredOverwrites.get(channel.id);
    const current = channel.permissionOverwrites.cache.get(role.id);
    if (!desired && !current) continue;

    if (!channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error('The bot cannot manage the overwrite in #' + channel.name + '.');
    }

    markInternalChange('channel', channel.id);
    if (desired) {
      await channel.permissionOverwrites.edit(
        role.id,
        permissionOverwriteOptionsFromSnapshot(desired),
        { reason },
      );
      restoredOverwrites += 1;
    } else if (current) {
      await channel.permissionOverwrites.delete(role.id, reason);
      removedOverwrites += 1;
    }
  }

  for (const channelId of desiredOverwrites.keys()) {
    if (!guild.channels.cache.has(channelId)) skippedDeletedChannels += 1;
  }

  return { restoredOverwrites, removedOverwrites, skippedDeletedChannels };
}

export async function createRoleBackupRestorePreview(client, guild, actorId, backupId) {
  requirePersistentDatabase(client);
  const backups = await getRoleAccessBackups(client, guild.id, BACKUP_LIMIT);
  const backup = backups.find(item => item.id === String(backupId));
  if (!backup?.snapshot) throw new Error('Backup not found. Check /access backups for available backup IDs.');
  if (String(backup.snapshot.guildId) !== String(guild.id)) throw new Error('This backup belongs to another server.');

  const role = guild.roles.cache.get(String(backup.snapshot.roleId)) ||
    await guild.roles.fetch(String(backup.snapshot.roleId)).catch(() => null);
  if (!role) throw new Error('The role from this backup no longer exists. It cannot be restored.');
  const { actor, botMember } = await fetchActorAndBot(guild, actorId);
  assertCanManageRole(actor, botMember, guild, role);

  const pending = {
    token: randomUUID().replaceAll('-', '').slice(0, 16),
    scope: 'restore',
    guildId: String(guild.id),
    actorId: String(actorId),
    roleId: String(role.id),
    backupId: backup.id,
    snapshot: backup.snapshot,
    expiresAt: Date.now() + CHANGE_TTL_MS,
  };
  pendingChanges.set(pending.token, pending);
  return pending;
}

export async function applyRoleBackupRestorePreview(client, guild, actorId, token) {
  requirePersistentDatabase(client);
  const pending = getPendingRolePermissionChange(token, actorId, guild.id);
  if (!pending || pending.scope !== 'restore') {
    throw new Error('This restore preview has expired or is no longer available. Start again from /access backups.');
  }

  const role = guild.roles.cache.get(pending.roleId) ||
    await guild.roles.fetch(pending.roleId).catch(() => null);
  if (!role) throw new Error('The selected role no longer exists. Nothing was changed.');
  const { actor, botMember } = await fetchActorAndBot(guild, actorId);
  assertCanManageRole(actor, botMember, guild, role);

  // Snapshot the current state before restore. It becomes the rollback point if Discord rejects any step.
  const safetyBackup = await saveBackup(client, guild, role, 'Safety snapshot before restore ' + pending.backupId, actorId);
  try {
    const result = await applyRoleSnapshotToGuild(
      guild,
      role,
      pending.snapshot,
      botMember,
      'SKAW Role Access Manager: restore backup ' + pending.backupId + ' by ' + actorId,
    );
    const auditPersisted = await saveAuditRecord(client, guild.id, {
      action: 'role_permission_backup_restored',
      source: 'SKAW Role Access Manager',
      actorId: String(actorId),
      roleId: role.id,
      roleName: role.name,
      restoredBackupId: pending.backupId,
      safetyBackupId: safetyBackup.id,
      ...result,
    });
    pendingChanges.delete(token);
    return { role, restoredBackupId: pending.backupId, safetyBackupId: safetyBackup.id, auditPersisted, ...result };
  } catch (error) {
    let rollbackError = null;
    try {
      await applyRoleSnapshotToGuild(
        guild,
        role,
        safetyBackup.snapshot,
        botMember,
        'SKAW Role Access Manager: rollback failed restore operation',
      );
    } catch (rollbackFailure) {
      rollbackError = rollbackFailure;
    }
    await saveAuditRecord(client, guild.id, {
      action: 'role_permission_backup_restore_failed',
      source: 'SKAW Role Access Manager',
      actorId: String(actorId),
      roleId: role.id,
      roleName: role.name,
      restoredBackupId: pending.backupId,
      safetyBackupId: safetyBackup.id,
      rollbackSucceeded: !rollbackError,
      error: String(error?.message || 'Unknown Discord API error').slice(0, 500),
      rollbackError: rollbackError ? String(rollbackError.message || 'Unknown rollback error').slice(0, 500) : null,
    });
    pendingChanges.delete(token);
    throw new Error(
      'Restore did not complete. ' +
      (rollbackError
        ? 'Automatic rollback also failed; use safety backup ' + safetyBackup.id + ' and inspect the server immediately. '
        : 'The previous permissions were automatically restored from safety backup ' + safetyBackup.id + '. ') +
      'Discord error: ' + (error?.message || 'Unknown error'),
    );
  }
}
