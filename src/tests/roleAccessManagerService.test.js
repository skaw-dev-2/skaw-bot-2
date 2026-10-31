import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import accessCommand from '../commands/Utility/access.js';
import {
  buildBackupsPanel,
  buildMemberAccessPanel,
  buildPermissionChoicePanel,
  buildPermissionPreviewPanel,
  buildRestorePreviewPanel,
  buildRoleAccessDashboard,
  buildRoleAccessRoleDetail,
  buildRoleComparePickerPanel,
  buildRoleChannelPermissionPanel,
  buildRoleChannelPickerPanel,
  buildRoleChannelsPanel,
  buildRoleServerPermissionsPanel,
} from '../services/roleAccessManagerPanelService.js';
import { createChannelEditorSession } from '../services/roleAccessManagerService.js';
import {
  analyzeGuildPermissionHealth,
  applyPendingRolePermissionChange,
  cancelPendingRolePermissionChange,
  compareRoleAccess,
  createServerPermissionPreview,
  formatPermissionName,
  getMemberEffectiveAccessEntries,
  getPermissionEntries,
  getRoleChannelAccessEntries,
  getRolePermissionPage,
  getRolePermissionState,
} from '../services/roleAccessManagerService.js';

function permissionSet(...flags) {
  const values = new Set(flags.map(flag =>
    typeof flag === 'string' ? (PermissionFlagsBits[flag] ?? flag) : flag,
  ));
  return {
    has(flag) {
      if (Array.isArray(flag)) return flag.some(item => values.has(item));
      return values.has(flag);
    },
  };
}

function makeChannel({ id, name, type = ChannelType.GuildText, view = true, overwrite = null, synced = true }) {
  const cache = new Map();
  if (overwrite) cache.set(overwrite.roleId, {
    allow: { bitfield: overwrite.allow ?? 0n },
    deny: { bitfield: overwrite.deny ?? 0n },
  });
  return {
    id, name, type, rawPosition: 1, parentId: null, parent: null,
    guild: null, permissionsLocked: synced,
    permissionOverwrites: { cache },
    permissionsFor(target) {
      if (target?.id === 'member-1') {
        return { has(flag) { return flag === PermissionFlagsBits.ViewChannel ? view : false; } };
      }
      if (target?.id === 'role-1') {
        return { has(flag) { return flag === PermissionFlagsBits.ViewChannel ? view : false; } };
      }
      if (target?.id === 'role-2') {
        return { has(flag) { return flag === PermissionFlagsBits.ViewChannel ? !view : false; } };
      }
      return { has(flag) { return flag === PermissionFlagsBits.ViewChannel ? view : false; } };
    },
  };
}

function makeRole(id, name, bitfield = 0n, position = 1) {
  return {
    id, name, position, managed: false, editable: true,
    permissions: { bitfield },
    members: new Map(),
    roles: null,
    permissionsFor: undefined,
  };
}

function makeGuildAndActors({ initialPermissions = 0n, degraded = false } = {}) {
  const actorId = '11111111111111111';
  const botId = '22222222222222222';
  const roleId = '33333333333333333';
  const guildId = '44444444444444444';
  const actor = {
    id: actorId,
    permissions: permissionSet('ManageRoles'),
    roles: { highest: { comparePositionTo: () => 10 } },
  };
  const botMember = {
    id: botId,
    permissions: permissionSet('ManageRoles'),
    roles: { highest: { comparePositionTo: () => 10 } },
  };
  const role = makeRole(roleId, 'Test Role', initialPermissions);
  const roleCache = new Map([[role.id, role]]);
  const store = new Map();
  const client = {
    db: {
      async get(key, fallback = null) { return store.has(key) ? store.get(key) : fallback; },
      async set(key, value) { store.set(key, value); },
      isDegraded() { return degraded; },
      getStatus() { return { isDegraded: degraded }; },
    },
  };
  const guild = {
    id: guildId,
    ownerId: '99999999999999999',
    roles: {
      cache: roleCache,
      async fetch(id) { return roleCache.get(String(id)) || null; },
      everyone: { id: guildId, name: '@everyone', permissions: { bitfield: 0n } },
    },
    channels: { cache: new Map(), async fetch() { return this.cache; } },
    members: {
      me: botMember,
      async fetch(id) { return String(id) === actorId ? actor : null; },
      async fetchMe() { return botMember; },
    },
  };
  role.guild = guild;
  role.setPermissions = async next => { role.permissions = { bitfield: BigInt(next) }; return role; };
  return { actorId, botId, roleId, guild, actor, botMember, role, client, store };
}

test('permission catalog exposes unique BigInt permission flags', () => {
  const entries = getPermissionEntries();
  assert.ok(entries.length > 0);
  assert.ok(entries.some(entry => entry.name === 'Administrator'));
  assert.ok(entries.every(entry => typeof entry.bit === 'bigint'));
  assert.equal(new Set(entries.map(entry => entry.name)).size, entries.length);
});

test('permission labels and role bitfield inspection are stable', () => {
  assert.equal(formatPermissionName('ManageGuild'), 'Manage Guild');
  const role = makeRole('role-1', 'Operations', PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages);
  assert.equal(getRolePermissionState(role, 'ViewChannel'), true);
  assert.equal(getRolePermissionState(role, 'SendMessages'), true);
  assert.equal(getRolePermissionState(role, 'Administrator'), false);
});

test('server permission pages clamp requested page numbers', () => {
  const role = makeRole('role-1', 'Operations', PermissionFlagsBits.ViewChannel);
  const first = getRolePermissionPage(role, -5);
  const last = getRolePermissionPage(role, 999);
  assert.equal(first.page, 0);
  assert.equal(last.page, last.pages - 1);
  assert.ok(first.items.length <= 18);
});

test('role channel inspector reports effective visibility, direct overwrites, and sync status', () => {
  const role = makeRole('role-1', 'Operations');
  const channel = makeChannel({
    id: '55555555555555555',
    name: 'management',
    view: true,
    synced: false,
    overwrite: { roleId: role.id, allow: PermissionFlagsBits.ViewChannel },
  });
  const guild = { channels: { cache: new Map([[channel.id, channel]]) } };
  channel.guild = guild;
  const [entry] = getRoleChannelAccessEntries(guild, role);
  assert.equal(entry.canView, true);
  assert.equal(entry.hasDirectOverwrite, true);
  assert.equal(entry.overwriteState, true);
  assert.equal(entry.isSynced, false);
});

test('member access inspector uses the member permission resolver', () => {
  const member = {
    id: 'member-1',
    permissions: permissionSet(),
    roles: { cache: new Map() },
  };
  const channel = makeChannel({ id: '55555555555555555', name: 'general', view: true });
  const guild = { channels: { cache: new Map([[channel.id, channel]]) } };
  channel.guild = guild;
  const entries = getMemberEffectiveAccessEntries(guild, member);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].canView, true);
  assert.equal(entries[0].canSendMessages, false);
});

test('role comparison reports server permission and channel visibility differences', () => {
  const first = makeRole('role-1', 'First', PermissionFlagsBits.ManageMessages);
  const second = makeRole('role-2', 'Second', 0n);
  const channel = makeChannel({ id: '55555555555555555', name: 'general', view: true });
  const guild = { channels: { cache: new Map([[channel.id, channel]]) } };
  channel.guild = guild;
  const result = compareRoleAccess(guild, first, second);
  assert.ok(result.permissionDifferences.some(entry => entry.name === 'ManageMessages'));
  assert.equal(result.channelDifferences.length, 1);
});

test('permission health check flags Administrator, broad roles, public channels, and unsynced channels', () => {
  const everyone = makeRole('guild-1', '@everyone', 0n);
  const admin = makeRole('role-admin', 'Dangerous', PermissionFlagsBits.Administrator);
  const elevated = makeRole('role-elevated', 'Elevated',
    PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles | PermissionFlagsBits.ManageChannels);
  const channel = makeChannel({ id: '55555555555555555', name: 'public', view: true, synced: false });
  const guild = {
    id: everyone.id,
    roles: { cache: new Map([[everyone.id, everyone], [admin.id, admin], [elevated.id, elevated]]), everyone },
    channels: { cache: new Map([[channel.id, channel]]) },
  };
  channel.guild = guild;
  const report = analyzeGuildPermissionHealth(guild);
  assert.equal(report.criticalCount, 1);
  assert.equal(report.warningCount, 1);
  assert.ok(report.issues.some(item => item.type === 'everyone_visible'));
  assert.ok(report.issues.some(item => item.type === 'unsynced_channels'));
});

test('server permission change preserves unrelated bits and stores a durable pre-change backup', async () => {
  const original = PermissionFlagsBits.ManageMessages | PermissionFlagsBits.SendMessages;
  const fixture = makeGuildAndActors({ initialPermissions: original });
  const pending = await createServerPermissionPreview(
    fixture.client, fixture.guild, fixture.actorId, fixture.roleId, 'ManageMessages', false,
  );
  const result = await applyPendingRolePermissionChange(
    fixture.client, fixture.guild, fixture.actorId, pending.token,
  );
  assert.equal(getRolePermissionState(fixture.role, 'ManageMessages'), false);
  assert.equal(getRolePermissionState(fixture.role, 'SendMessages'), true);
  assert.ok(result.backupId);
  const backupRecords = await fixture.client.db.get('guild:' + fixture.guild.id + ':role_access:backups:v1', []);
  assert.equal(backupRecords.length, 1);
  assert.equal(BigInt(backupRecords[0].snapshot.rolePermissions), original);
  const audit = await fixture.client.db.get('guild:' + fixture.guild.id + ':role_access:audit:v1', []);
  assert.equal(audit[0].action, 'server_permission_update');
});

test('non-owner cannot revoke Administrator through the server permission editor', async () => {
  const fixture = makeGuildAndActors({
    initialPermissions: PermissionFlagsBits.Administrator,
  });
  await assert.rejects(
    createServerPermissionPreview(
      fixture.client,
      fixture.guild,
      fixture.actorId,
      fixture.roleId,
      'Administrator',
      false,
    ),
    /only the server owner can grant or revoke Administrator/i,
  );
  assert.equal(getRolePermissionState(fixture.role, 'Administrator'), true);
});

test('permission mutations fail closed when PostgreSQL is degraded', async () => {
  const fixture = makeGuildAndActors({
    initialPermissions: PermissionFlagsBits.ManageMessages,
    degraded: true,
  });
  const pending = await createServerPermissionPreview(
    fixture.client, fixture.guild, fixture.actorId, fixture.roleId, 'ManageMessages', false,
  );
  await assert.rejects(
    applyPendingRolePermissionChange(fixture.client, fixture.guild, fixture.actorId, pending.token),
    /memory fallback mode/,
  );
  assert.equal(getRolePermissionState(fixture.role, 'ManageMessages'), true);
  cancelPendingRolePermissionChange(pending.token, fixture.actorId);
});


test('slash command schema and panel builders serialize without invalid Discord components', () => {
  const command = accessCommand.data.toJSON();
  assert.equal(command.name, 'access');
  const optionNames = command.options.map(option => option.name);
  assert.deepEqual(optionNames, ['role', 'member']);
  assert.ok(command.options.every(option => option.required !== true));
  assert.ok(command.options.every(option => option.type !== 1), 'the command should not expose subcommands');

  const role = makeRole('role-1', 'Operations', PermissionFlagsBits.SendMessages);
  const channel = makeChannel({
    id: '55555555555555555',
    name: 'management',
    view: true,
    synced: true,
    overwrite: { roleId: role.id, allow: PermissionFlagsBits.ViewChannel },
  });
  const comparisonRole = makeRole('role-2', 'Operations Backup', 0n);
  const guild = {
    id: '44444444444444444',
    roles: { cache: new Map([[role.id, role], [comparisonRole.id, comparisonRole]]) },
    channels: { cache: new Map([[channel.id, channel]]) },
  };
  role.guild = guild;
  comparisonRole.guild = guild;
  channel.guild = guild;

  const member = {
    id: 'member-1',
    user: { tag: 'Member#0001' },
    permissions: permissionSet(),
    roles: { cache: new Map([[role.id, role]]) },
  };
  const backup = {
    id: 'backup-1',
    createdAt: new Date().toISOString(),
    reason: 'Test backup',
    snapshot: {
      roleId: role.id,
      capturedAt: new Date().toISOString(),
      channelOverwrites: [],
    },
  };
  const pending = {
    token: 'preview-token',
    scope: 'channel',
    roleId: role.id,
    flagName: 'ViewChannel',
    nextValue: true,
    previousValues: { [channel.id]: null },
    channelIds: [channel.id],
  };
  const sessionToken = createChannelEditorSession({
    guildId: guild.id, actorId: 'actor-1', roleId: role.id, channelIds: [channel.id],
  });

  const payloads = [
    buildRoleAccessDashboard(guild),
    buildRoleAccessRoleDetail(guild, role),
    buildRoleComparePickerPanel(guild, role),
    buildRoleServerPermissionsPanel(role, 0, false),
    buildRoleServerPermissionsPanel(role, 0, true),
    buildRoleChannelsPanel(guild, role),
    buildRoleChannelPickerPanel(guild, role),
    buildRoleChannelPermissionPanel(guild, role, sessionToken, 'actor-1', 0),
    buildPermissionChoicePanel(role, 'server', 'SendMessages'),
    buildPermissionChoicePanel(role, 'channel', 'ViewChannel', sessionToken),
    buildPermissionPreviewPanel(guild, role, pending),
    buildRestorePreviewPanel(role, { backupId: backup.id, snapshot: backup.snapshot, token: 'restore-token' }),
    buildMemberAccessPanel(guild, member),
    buildBackupsPanel(role, [backup]),
  ];

  for (const payload of payloads) {
    assert.ok(Array.isArray(payload.embeds));
    assert.ok(Array.isArray(payload.components));
    for (const item of payload.embeds) item.toJSON();
    for (const row of payload.components) row.toJSON();
  }
});
