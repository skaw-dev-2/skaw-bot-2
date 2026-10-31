import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, MessageFlags,
  PermissionFlagsBits, StringSelectMenuBuilder, escapeMarkdown,
} from 'discord.js';
import {
  analyzeGuildPermissionHealth, applyPendingRolePermissionChange,
  applyRoleBackupRestorePreview, cancelPendingRolePermissionChange,
  compareRoleAccess, createChannelEditorSession, createChannelPermissionPreview,
  createRoleBackupRestorePreview, createServerPermissionPreview,
  formatPermissionName, getChannelEditorSession, getMemberEffectiveAccessEntries,
  getPermissionEntries, getPendingRolePermissionChange, getRoleAccessBackups,
  getRoleAccessAudit, getRoleChannelAccessEntries, getRoleChannelAccessSession,
  getRolePermissionPage, getRolePermissionState, createRoleChannelAccessSession,
  stageRoleChannelAccessStates, updateRoleChannelAccessSession,
  deleteRoleChannelAccessSession, createRoleChannelVisibilityPreview,
} from './roleAccessManagerService.js';

const BLUE = 0x0878FF;
const PAGE_SIZE = 18;
const CHANNEL_PERMISSION_EXCLUSIONS = new Set([
  'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels',
  'ViewAuditLog', 'ManageWebhooks', 'ManageEvents', 'ViewGuildInsights',
  'KickMembers', 'BanMembers', 'ModerateMembers', 'ChangeNickname',
  'ManageNicknames', 'ManageGuildExpressions', 'CreateGuildExpressions',
]);
const CHANNEL_PERMISSION_ENTRIES = getPermissionEntries()
  .filter(entry => !CHANNEL_PERMISSION_EXCLUSIONS.has(entry.name));

function button(action, label, style = ButtonStyle.Secondary, disabled = false) {
  return new ButtonBuilder().setCustomId('skaw_ra:' + action)
    .setLabel(label).setStyle(style).setDisabled(Boolean(disabled));
}
function safeName(value, max = 90) {
  return escapeMarkdown(String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)) || 'Unknown';
}
function allowState(value) {
  return value === true ? 'ALLOW' : value === false ? 'DENY' : 'INHERIT';
}
function fieldEmbed(title, description) {
  return new EmbedBuilder().setColor(BLUE)
    .setAuthor({ name: 'SKAW GROUP · MANAGEMENT' })
    .setTitle(title).setDescription(description)
    .setFooter({ text: 'SKAW ROLE ACCESS MANAGER' });
}
function pageButtons(action, id, page, pages, backAction = 'role:' + id) {
  // Discord requires every component custom_id in a message to be unique.
  // Add direction/action suffixes so one-page views and explicit Back buttons
  // elsewhere in the same message never collide.
  return new ActionRowBuilder().addComponents(
    button(action + ':' + id + ':' + Math.max(0, page - 1) + ':prev', 'Previous', ButtonStyle.Secondary, page <= 0),
    button(action + ':' + id + ':' + Math.min(pages - 1, page + 1) + ':next', 'Next', ButtonStyle.Secondary, page >= pages - 1),
    button(backAction + ':pageback:' + action, 'Back', ButtonStyle.Primary),
  );
}
function getManageableRoles(guild) {
  return [...guild.roles.cache.values()]
    .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name));
}
function roleLabel(role) {
  return (role.name + (role.id === role.guild.id ? ' · @everyone' : '')).slice(0, 100);
}
async function fetchRole(guild, roleId) {
  return guild.roles.cache.get(String(roleId)) ||
    await guild.roles.fetch(String(roleId)).catch(() => null);
}
async function prepareGuild(guild) {
  await guild.members.fetchMe().catch(() => null);
  await guild.roles.fetch().catch(() => null);
  await guild.channels.fetch().catch(() => null);
}
function requirePanelAccess(interaction) {
  if (!interaction.guild || !interaction.guildId) throw new Error('This panel can only be used inside a server.');
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error('Access denied. Manage Roles permission is required.');
  }
}
async function updateWithError(interaction, error) {
  const payload = {
    content: '❌ ' + String(error?.message || 'Could not complete this action.').slice(0, 1800),
    embeds: [], components: [], allowedMentions: { parse: [] },
  };
  if (interaction.deferred || interaction.replied) {
    return interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
}

export function buildRoleAccessDashboard(guild, page = 0) {
  const roles = getManageableRoles(guild)
    .filter(role => role.id !== guild.id && !role.managed);
  const pages = Math.max(1, Math.ceil(roles.length / 25));
  const current = Math.min(pages - 1, Math.max(0, Number(page) || 0));
  const items = roles.slice(current * 25, current * 25 + 25);
  const select = new StringSelectMenuBuilder()
    .setCustomId('skaw_ra_select:rolepick:' + current)
    .setPlaceholder('Pilih role yang ingin diatur')
    .setMinValues(1).setMaxValues(1)
    .setDisabled(items.length === 0)
    .addOptions(items.map(role => ({
      label: roleLabel(role),
      description: ('Posisi ' + role.position + ' · anggota ' + (role.members?.size ?? '—')).slice(0, 100),
      value: role.id,
    })));
  const embed = fieldEmbed('SKAW ACCESS MANAGER', [
    '**Pengaturan akses channel berdasarkan role**',
    'Pilih satu role untuk mengatur channel mana saja yang boleh dilihat.',
    '',
    '**Ringkasan server**',
    'Role tersedia: **' + roles.length + '**',
    'Total channel: **' + [...guild.channels.cache.values()].filter(channel =>
      channel.type !== ChannelType.GuildCategory && !channel.isThread?.()
    ).length + '**',
    '',
    'Pilih role dari menu di bawah. Akses dapat diatur per kategori maupun per channel.',
    'Perubahan baru diterapkan setelah menekan **Simpan Perubahan** dan mengonfirmasi.',
  ].join('\n'));
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(
        button('dashboard:' + Math.max(0, current - 1) + ':prev', 'Sebelumnya', ButtonStyle.Secondary, current === 0),
        button('dashboard:' + Math.min(pages - 1, current + 1) + ':next', 'Berikutnya', ButtonStyle.Secondary, current >= pages - 1),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

function collectRoleChannelGroups(guild, role, session) {
  const groups = new Map();
  const channels = [...(guild?.channels?.cache?.values?.() || [])]
    .filter(channel =>
      channel?.guild &&
      channel.permissionOverwrites?.cache &&
      channel.type !== ChannelType.GuildCategory &&
      !channel.isThread?.()
    );

  for (const channel of channels) {
    const categoryId = channel.parentId ? String(channel.parentId) : 'uncategorized';
    const category = channel.parent || guild.channels.cache.get(categoryId) || null;
    if (!groups.has(categoryId)) {
      groups.set(categoryId, {
        id: categoryId,
        name: categoryId === 'uncategorized' ? 'Tanpa Kategori' : (category?.name || 'Kategori'),
        position: category?.rawPosition ?? Number.MAX_SAFE_INTEGER,
        channels: [],
      });
    }
    const currentVisible = Boolean(channel.permissionsFor(role)?.has(PermissionFlagsBits.ViewChannel));
    const visible = Object.hasOwn(session?.desiredStates || {}, channel.id)
      ? Boolean(session.desiredStates[channel.id])
      : currentVisible;
    groups.get(categoryId).channels.push({
      channel,
      currentVisible,
      visible,
    });
  }

  return [...groups.values()]
    .map(group => ({
      ...group,
      channels: group.channels.sort((a, b) =>
        (a.channel.rawPosition ?? 0) - (b.channel.rawPosition ?? 0) ||
        a.channel.name.localeCompare(b.channel.name)
      ),
      visibleCount: group.channels.filter(item => item.visible).length,
    }))
    .sort((a, b) =>
      (a.id === 'uncategorized' ? 1 : 0) - (b.id === 'uncategorized' ? 1 : 0) ||
      a.position - b.position ||
      a.name.localeCompare(b.name)
    );
}

function getRoleChannelAccessPanelState(guild, role, session) {
  const groups = collectRoleChannelGroups(guild, role, session);
  const categoryPages = Math.max(1, Math.ceil(groups.length / 25));
  const categoryPage = Math.min(categoryPages - 1, Math.max(0, Number(session.categoryPage) || 0));
  const visibleCategories = groups.slice(categoryPage * 25, categoryPage * 25 + 25);
  let selected = groups.find(group => group.id === session.selectedCategoryId) || visibleCategories[0] || groups[0] || null;
  if (selected && !visibleCategories.some(group => group.id === selected.id)) {
    selected = visibleCategories[0] || selected;
  }
  const selectedCategoryId = selected?.id || 'uncategorized';
  const channels = selected?.channels || [];
  const channelPages = Math.max(1, Math.ceil(channels.length / 25));
  const channelPage = Math.min(channelPages - 1, Math.max(0, Number(session.channelPage) || 0));
  const pageChannels = channels.slice(channelPage * 25, channelPage * 25 + 25);
  const allChannels = groups.flatMap(group => group.channels);
  const stagedCount = allChannels.filter(item => item.visible !== item.currentVisible).length;

  return {
    groups,
    categoryPages,
    categoryPage,
    visibleCategories,
    selected,
    selectedCategoryId,
    channelPages,
    channelPage,
    pageChannels,
    allChannels,
    stagedCount,
    visibleCount: allChannels.filter(item => item.visible).length,
  };
}

export function buildRoleChannelVisibilityPanel(guild, role, session, notice = null) {
  if (!session || session.kind !== 'role-channel-visibility' || session.roleId !== role.id) {
    throw new Error('This access panel expired. Reopen /access panel.');
  }

  const state = getRoleChannelAccessPanelState(guild, role, session);
  if (session.categoryPage !== state.categoryPage || session.selectedCategoryId !== state.selectedCategoryId ||
      session.channelPage !== state.channelPage) {
    updateRoleChannelAccessSession(session.token, session.actorId, guild.id, {
      categoryPage: state.categoryPage,
      selectedCategoryId: state.selectedCategoryId,
      channelPage: state.channelPage,
    });
  }

  const isAdministrator = getRolePermissionState(role, 'Administrator');
  const total = state.allChannels.length;
  const hidden = total - state.visibleCount;
  const group = state.selected;
  const categoryOptions = state.visibleCategories.map(item => ({
    label: item.name.slice(0, 100),
    description: (item.visibleCount + '/' + item.channels.length + ' channel dapat dilihat').slice(0, 100),
    value: item.id,
    default: item.id === state.selectedCategoryId,
  }));
  const channelOptions = state.pageChannels.map(item => ({
    label: ('#' + item.channel.name).slice(0, 100),
    description: item.visible ? '✅ Boleh Melihat' : '⛔ Akses Dicabut',
    value: item.channel.id,
    default: item.visible,
  }));

  const categorySelect = new StringSelectMenuBuilder()
    .setCustomId('skaw_ra_select:accesscategory:' + session.token)
    .setPlaceholder('Pilih kategori channel')
    .setMinValues(1).setMaxValues(1)
    .setDisabled(isAdministrator || categoryOptions.length === 0)
    .addOptions(categoryOptions);

  const rows = [];
  if (categoryOptions.length) rows.push(new ActionRowBuilder().addComponents(categorySelect));

  if (channelOptions.length) {
    const channelSelect = new StringSelectMenuBuilder()
      .setCustomId('skaw_ra_select:accesschannels:' + session.token)
      .setPlaceholder('Centang channel yang boleh dilihat')
      .setMinValues(0).setMaxValues(Math.max(1, channelOptions.length))
      .setDisabled(isAdministrator)
      .addOptions(channelOptions);
    rows.push(new ActionRowBuilder().addComponents(channelSelect));
  }

  if (state.groups.length) {
    rows.push(new ActionRowBuilder().addComponents(
      button(
        'accesscatpage:' + session.token + ':' + Math.max(0, state.categoryPage - 1),
        'Kategori Sebelumnya',
        ButtonStyle.Secondary,
        state.categoryPage === 0 || isAdministrator,
      ),
      button(
        'accesscatpage:' + session.token + ':' + Math.min(state.categoryPages - 1, state.categoryPage + 1),
        'Kategori Berikutnya',
        ButtonStyle.Secondary,
        state.categoryPage >= state.categoryPages - 1 || isAdministrator,
      ),
      button(
        'accesschannelpage:' + session.token + ':' + Math.max(0, state.channelPage - 1),
        'Channel Sebelumnya',
        ButtonStyle.Secondary,
        !group || state.channelPage === 0 || isAdministrator,
      ),
      button(
        'accesschannelpage:' + session.token + ':' + Math.min(state.channelPages - 1, state.channelPage + 1),
        'Channel Berikutnya',
        ButtonStyle.Secondary,
        !group || state.channelPage >= state.channelPages - 1 || isAdministrator,
      ),
    ));
    rows.push(new ActionRowBuilder().addComponents(
      button('accessbulk:' + session.token + ':true', 'Izinkan Semua', ButtonStyle.Success, !group || isAdministrator),
      button('accessbulk:' + session.token + ':false', 'Cabut Semua', ButtonStyle.Danger, !group || isAdministrator),
    ));
  }

  rows.push(new ActionRowBuilder().addComponents(
    button('accesssave:' + session.token, 'Simpan Perubahan', ButtonStyle.Success, state.stagedCount === 0 || isAdministrator),
    button('accessdiscard:' + session.token, 'Batalkan', ButtonStyle.Secondary),
  ));

  const description = [
    '**Role:** ' + safeName(role.name, 100),
    '**Channel boleh dilihat:** ' + state.visibleCount + '/' + total,
    '**Akses dicabut:** ' + hidden,
    '**Perubahan belum disimpan:** ' + state.stagedCount,
    '',
    group
      ? '**Kategori:** ' + safeName(group.name, 100) + ' · ' + group.visibleCount + '/' + group.channels.length + ' terlihat'
      : 'Belum ada channel di server ini.',
    group
      ? '**Halaman channel:** ' + (state.channelPage + 1) + '/' + state.channelPages
      : '',
    '',
    'Pilih kategori, lalu centang channel yang boleh dilihat. Pilihan kategori akan mengatur semua channel di dalamnya, termasuk yang permission-nya tidak tersinkron.',
    'Perubahan belum diterapkan sampai kamu menekan **Simpan Perubahan**.',
    '',
    'Catatan: anggota masih bisa melihat channel melalui role lain atau Administrator.',
  ];
  if (isAdministrator) {
    description.splice(4, 0, '⚠️ **Role ini memiliki Administrator.** Administrator melewati pembatasan channel, jadi akses channel role ini tidak dapat diubah.');
  }
  if (notice) description.unshift('✅ ' + notice, '');

  const embed = fieldEmbed('CHANNEL VISIBILITY · ' + safeName(role.name, 100), description.filter(Boolean).join('\n'));
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

export function buildRoleChannelVisibilityPreviewPanel(guild, role, pending) {
  const entries = (pending.channelIds || []).map(id => {
    const channel = guild.channels.cache.get(id);
    return {
      channel,
      id,
      next: pending.nextValues?.[id] ?? pending.nextValue,
    };
  });
  const grantCount = entries.filter(item => item.next === true).length;
  const revokeCount = entries.filter(item => item.next === false).length;
  const lines = entries.slice(0, 14).map(item =>
    (item.next ? '✅ Boleh Melihat — ' : '⛔ Cabut Akses — ') +
    (item.channel?.type === ChannelType.GuildCategory
      ? 'Kategori **' + safeName(item.channel.name, 70) + '**'
      : '<#' + item.id + '>')
  );
  return {
    embeds: [fieldEmbed('KONFIRMASI PERUBAHAN AKSES', [
      '**Role:** ' + safeName(role.name, 100),
      '**Channel/kategori diizinkan:** ' + grantCount,
      '**Channel/kategori dicabut:** ' + revokeCount,
      '**Total target berubah:** ' + entries.length,
      '',
      lines.join('\n') || 'Tidak ada target.',
      entries.length > 14 ? '…dan ' + (entries.length - 14) + ' target lainnya.' : '',
      '',
      'Satu backup role akan disimpan sebelum perubahan diterapkan. Jika Discord menolak sebagian perubahan, bot akan mencoba mengembalikan kondisi sebelumnya.',
      'Perubahan ini hanya mengatur izin role yang dipilih. Anggota yang memiliki role lain masih mungkin dapat melihat channel.',
    ].filter(Boolean).join('\n'))],
    components: [new ActionRowBuilder().addComponents(
      button('accessconfirm:' + pending.token, 'Konfirmasi & Simpan', ButtonStyle.Success),
      button('accesscancel:' + pending.token + ':' + (pending.sessionToken || ''), 'Kembali ke Editor', ButtonStyle.Secondary),
    )],
    allowedMentions: { parse: [] },
  };
}
export function buildRoleAccessRoleDetail(guild, role) {
  const granted = getPermissionEntries().filter(entry => getRolePermissionState(role, entry.name));
  const channels = getRoleChannelAccessEntries(guild, role);
  const visible = channels.filter(item => item.canView).length;
  const direct = channels.filter(item => item.hasDirectOverwrite).length;
  const administrator = getRolePermissionState(role, 'Administrator');
  const elevated = ['ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageWebhooks', 'BanMembers', 'KickMembers', 'ModerateMembers']
    .filter(flag => getRolePermissionState(role, flag));
  const lines = [
    '**Role:** ' + safeName(role.name, 100),
    '**Position:** ' + role.position,
    '**Members (cached):** ' + (role.members?.size ?? 'Not loaded'),
    '**Server permissions granted:** ' + granted.length + '/' + getPermissionEntries().length,
    '**Channels visible to this role:** ' + visible + '/' + channels.length,
    '**Direct channel overwrites:** ' + direct,
    '',
  ];
  if (administrator) lines.push('🚨 **CRITICAL: This role has Administrator. Channel restrictions cannot limit members with this role.**');
  else if (elevated.length) lines.push('⚠️ Elevated permissions: ' + elevated.map(formatPermissionName).join(', '));
  else lines.push('No high-risk server permission was detected by the basic role scan.');
  lines.push('', '**Quick actions**', 'Inspect or edit permissions and channel access using the buttons below.');
  const isEveryone = role.id === guild.id;
  const row1 = new ActionRowBuilder().addComponents(
    button('server:' + role.id + ':0', 'Server Permissions', ButtonStyle.Primary),
    button('serveredit:' + role.id + ':0', 'Edit Server Permissions', ButtonStyle.Success, isEveryone || role.managed),
    button('channels:' + role.id + ':0', 'Channel Access'),
  );
  const row2 = new ActionRowBuilder().addComponents(
    button('channelpick:' + role.id + ':0', 'Bulk Channel Editor', ButtonStyle.Success, role.managed),
    button('comparepick:' + role.id, 'Compare Role'),
    button('backups:' + role.id, 'Backups & Restore'),
    button('dashboard:0', 'All Roles'),
  );
  return {
    embeds: [fieldEmbed('ROLE PROFILE · ' + safeName(role.name, 150), lines.join('\n'))],
    components: [row1, row2], allowedMentions: { parse: [] },
  };
}

export function buildRoleServerPermissionsPanel(role, page = 0, editing = false) {
  const data = getRolePermissionPage(role, page);
  const lines = data.items.map((entry, index) =>
    String(data.page * PAGE_SIZE + index + 1).padStart(2, '0') + '. **' + entry.label +
    '** — ' + (entry.enabled ? '✅ Granted' : '— Not granted'),
  );
  const embed = fieldEmbed(
    (editing ? 'EDIT SERVER PERMISSIONS' : 'SERVER PERMISSION INSPECTOR') + ' · ' + safeName(role.name, 100),
    [
      'Page **' + (data.page + 1) + '/' + data.pages + '** · ' + data.total + ' permission flags',
      '',
      lines.join('\n'),
      '',
      editing ? 'Select one permission to preview a grant or removal.' : 'These are permissions assigned directly to this role at server level.',
      getRolePermissionState(role, 'Administrator') ? '\n🚨 Administrator bypasses channel-specific permission restrictions.' : '',
    ].join('\n'),
  );
  const rows = [];
  if (editing) {
    const select = new StringSelectMenuBuilder()
      .setCustomId('skaw_ra_select:serverflag:' + role.id + ':' + data.page)
      .setPlaceholder('Choose a server permission to edit')
      .setMinValues(1).setMaxValues(1)
      .addOptions(data.items.map(entry => ({
        label: entry.label.slice(0, 100),
        description: (entry.enabled ? 'Currently granted' : 'Currently not granted') + ' · ' + entry.name,
        value: entry.name,
      })));
    rows.push(new ActionRowBuilder().addComponents(select));
  }
  rows.push(pageButtons(editing ? 'serveredit' : 'server', role.id, data.page, data.pages));
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

export function buildRoleChannelsPanel(guild, role, page = 0) {
  const entries = getRoleChannelAccessEntries(guild, role);
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const current = Math.min(pages - 1, Math.max(0, Number(page) || 0));
  const visible = entries.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);
  const lines = visible.map(entry => {
    const icon = entry.canView ? '✅' : '⛔';
    const direct = entry.overwriteState === true ? 'Direct ALLOW'
      : entry.overwriteState === false ? 'Direct DENY'
        : entry.hasDirectOverwrite ? 'Direct overwrite'
          : 'Inherited / no direct overwrite';
    const sync = entry.isSynced === false ? ' · ⚠️ Unsynced' : '';
    const category = entry.isCategory ? ' · CATEGORY' : '';
    return icon + ' <#' + entry.channelId + '> · ' + direct + sync + category;
  });
  const embed = fieldEmbed('CHANNEL ACCESS · ' + safeName(role.name, 100), [
    'Visible: **' + entries.filter(item => item.canView).length + '/' + entries.length + '**',
    'Direct overwrites: **' + entries.filter(item => item.hasDirectOverwrite).length + '**',
    'Page **' + (current + 1) + '/' + pages + '**',
    '',
    lines.join('\n') || 'No channels found.',
    '',
    'This view evaluates this role with @everyone and channel overwrites. It does not combine the member’s other roles.',
    'Unsynced channels may have independent access settings.',
  ].join('\n'));
  return {
    embeds: [embed],
    components: [
      pageButtons('channels', role.id, current, pages),
      new ActionRowBuilder().addComponents(
        button('channelpick:' + role.id + ':0', 'Open Bulk Channel Editor', ButtonStyle.Success, role.managed),
        button('role:' + role.id, 'Role Profile', ButtonStyle.Primary),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

export function buildRoleChannelPickerPanel(guild, role, page = 0) {
  const entries = getRoleChannelAccessEntries(guild, role);
  const pages = Math.max(1, Math.ceil(entries.length / 25));
  const current = Math.min(pages - 1, Math.max(0, Number(page) || 0));
  const items = entries.slice(current * 25, current * 25 + 25);
  const select = new StringSelectMenuBuilder()
    .setCustomId('skaw_ra_select:channelpick:' + role.id + ':' + current)
    .setPlaceholder('Select up to 25 categories/channels for bulk editing')
    .setMinValues(1).setMaxValues(Math.max(1, items.length))
    .addOptions(items.map(entry => ({
      label: (entry.isCategory ? 'CATEGORY · ' : '#') + entry.name.slice(0, 85),
      description: (entry.canView ? 'Visible' : 'Hidden') + ' · ' + entry.type + ' · ' + (entry.isSynced === false ? 'Unsynced' : 'Synced/inherited'),
      value: entry.channelId,
    })));
  const embed = fieldEmbed('BULK CHANNEL ACCESS EDITOR · ' + safeName(role.name, 100), [
    'Select multiple categories or channels in one action (up to 25 per batch).',
    'Page **' + (current + 1) + '/' + pages + '** · ' + entries.length + ' objects',
    '',
    'Editing a category permission may affect child channels that remain synchronized with that category. Unsynced channels retain their own overwrites.',
    'The next step lets you choose a permission and ALLOW, DENY, or INHERIT it.',
  ].join('\n'));
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(select),
      pageButtons('channelpick', role.id, current, pages),
      new ActionRowBuilder().addComponents(button('role:' + role.id, 'Cancel')),
    ],
    allowedMentions: { parse: [] },
  };
}

export function buildRoleChannelPermissionPanel(guild, role, sessionToken, actorId, page = 0) {
  const session = getChannelEditorSession(sessionToken, actorId, guild.id);
  if (!session) throw new Error('This channel selection expired. Reopen the editor.');
  const pages = Math.max(1, Math.ceil(CHANNEL_PERMISSION_ENTRIES.length / PAGE_SIZE));
  const current = Math.min(pages - 1, Math.max(0, Number(page) || 0));
  const items = CHANNEL_PERMISSION_ENTRIES.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);
  const select = new StringSelectMenuBuilder()
    .setCustomId('skaw_ra_select:channelflag:' + role.id + ':' + sessionToken + ':' + current)
    .setPlaceholder('Choose a channel permission to edit')
    .setMinValues(1).setMaxValues(1)
    .addOptions(items.map(entry => ({
      label: entry.label.slice(0, 100),
      description: entry.group.toUpperCase() + ' · channel overwrite permission',
      value: entry.name,
    })));
  const names = session.channelIds.map(id => guild.channels.cache.get(id)).filter(Boolean)
    .map(channel => channel.type === 4 ? 'CATEGORY · ' + channel.name : '#' + channel.name);
  const embed = fieldEmbed('SELECT CHANNEL PERMISSION · ' + safeName(role.name, 100), [
    '**Selected targets (' + session.channelIds.length + '):**',
    names.slice(0, 12).map(name => '• ' + safeName(name, 90)).join('\n') || 'Targets selected',
    names.length > 12 ? '…and ' + (names.length - 12) + ' more.' : '',
    '',
    'Page **' + (current + 1) + '/' + pages + '** · ' + CHANNEL_PERMISSION_ENTRIES.length + ' available flags',
    '',
    'Choose one permission. The next panel lets you ALLOW, DENY, or INHERIT it for every selected target.',
  ].filter(Boolean).join('\n'));
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(select),
      pageButtons('channelperms', role.id + ':' + sessionToken, current, pages, 'role:' + role.id),
    ],
    allowedMentions: { parse: [] },
  };
}

export function buildPermissionChoicePanel(role, scope, flagName, sessionToken = null) {
  const enabled = getRolePermissionState(role, flagName);
  const embed = fieldEmbed('PERMISSION EDITOR · ' + safeName(role.name, 100), [
    '**Permission:** ' + formatPermissionName(flagName),
    scope === 'server'
      ? '**Current server role state:** ' + (enabled ? 'Granted' : 'Not granted')
      : '**Current channel overwrite state:** May differ between selected targets; the confirmation preview shows each target’s current state.',
    scope === 'channel'
      ? 'This changes only the selected channel overwrite for this role. Other overwrite flags are preserved.'
      : 'This changes only this server permission bit. Every other role permission is preserved.',
    '',
    'Choose the intended state. A confirmation preview appears before anything is changed.',
  ].join('\n'));
  const row = scope === 'server'
    ? new ActionRowBuilder().addComponents(
        button('serverchange:' + role.id + ':' + flagName + ':true', 'Grant permission', ButtonStyle.Success, enabled),
        button('serverchange:' + role.id + ':' + flagName + ':false', 'Revoke permission', ButtonStyle.Danger, !enabled),
        button('serveredit:' + role.id + ':0', 'Back'),
      )
    : new ActionRowBuilder().addComponents(
        button('channelchange:' + role.id + ':' + sessionToken + ':' + flagName + ':true', 'ALLOW', ButtonStyle.Success),
        button('channelchange:' + role.id + ':' + sessionToken + ':' + flagName + ':false', 'DENY', ButtonStyle.Danger),
        button('channelchange:' + role.id + ':' + sessionToken + ':' + flagName + ':null', 'INHERIT', ButtonStyle.Secondary),
      );
  const rows = [row];
  if (scope === 'channel') rows.push(new ActionRowBuilder().addComponents(
    button('channelperms:' + role.id + ':' + sessionToken + ':0', 'Back to permissions'),
    button('role:' + role.id, 'Role Profile'),
  ));
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

export function buildPermissionPreviewPanel(guild, role, pending) {
  const valueLabel = pending.nextValue === null ? 'INHERIT (remove direct override)'
    : pending.nextValue ? 'ALLOW' : 'DENY';
  const before = pending.scope === 'server'
    ? (pending.previousValue ? 'Granted' : 'Not granted')
    : Object.entries(pending.previousValues || {}).map(([id, value]) =>
        '<#' + id + '> = ' + allowState(value)).slice(0, 8).join(', ');
  const affected = pending.scope === 'channel'
    ? (pending.channelIds || []).map(id => {
        const channel = guild.channels.cache.get(id);
        return channel ? (channel.type === 4 ? 'CATEGORY · ' + safeName(channel.name) : '<#' + id + '>') : 'Deleted channel';
      })
    : [];
  const embed = fieldEmbed('CONFIRM PERMISSION CHANGE', [
    '**Target role:** ' + safeName(role.name, 100),
    '**Scope:** ' + (pending.scope === 'server' ? 'Server-wide role permission' : 'Channel overwrite'),
    '**Permission:** ' + formatPermissionName(pending.flagName),
    '**Previous:** ' + before,
    '**New state:** **' + valueLabel + '**',
    pending.scope === 'channel' ? '\n**Targets (' + affected.length + '):**\n' + affected.join('\n') : '',
    '',
    'Preview expires in 10 minutes. The bot re-checks hierarchy and current permission state before applying.',
    'A durable snapshot is stored before mutation. The operation stops if a target changed after this preview.',
  ].filter(Boolean).join('\n'));
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      button('confirm:' + pending.token, 'Confirm & Apply', ButtonStyle.Success),
      button('cancel:' + pending.token, 'Cancel', ButtonStyle.Danger),
    )],
    allowedMentions: { parse: [] },
  };
}

export function buildRestorePreviewPanel(role, pending) {
  const snapshot = pending.snapshot;
  const captured = new Date(snapshot.capturedAt).getTime();
  const embed = fieldEmbed('CONFIRM BACKUP RESTORE', [
    '**Target role:** ' + safeName(role.name, 100),
    '**Backup ID:** ' + pending.backupId,
    '**Captured:** ' + (Number.isFinite(captured) ? '<t:' + Math.floor(captured / 1000) + ':F>' : 'Unknown'),
    '**Server permissions:** Full role permission bitfield will be restored.',
    '**Channel overwrites:** ' + (snapshot.channelOverwrites?.length || 0) + ' saved role overwrite(s).',
    '',
    'This restores all server permissions and all channel overwrites for this role to the selected snapshot. Other roles and member-specific overwrites are not targeted.',
    'A safety snapshot of the current state is saved first. If Discord rejects a step, the bot attempts an automatic rollback.',
  ].join('\n'));
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      button('restoreconfirm:' + pending.token, 'Confirm Restore', ButtonStyle.Danger),
      button('cancel:' + pending.token, 'Cancel', ButtonStyle.Secondary),
    )],
    allowedMentions: { parse: [] },
  };
}

export function buildMemberAccessPanel(guild, member, page = 0) {
  const entries = getMemberEffectiveAccessEntries(guild, member);
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const current = Math.min(pages - 1, Math.max(0, Number(page) || 0));
  const visible = entries.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);
  const lines = visible.map(entry => [
    entry.canView ? '✅' : '⛔',
    '<#' + entry.channelId + '>',
    entry.canView
      ? 'View' + (entry.canSendMessages ? ' · Send' : '') +
        (entry.canManageMessages ? ' · Manage' : '') +
        (entry.canConnect ? ' · Connect' : '')
      : 'No View Channel',
  ].join(' — '));
  const admin = member.permissions.has(PermissionFlagsBits.Administrator);
  const embed = fieldEmbed('MEMBER EFFECTIVE ACCESS · ' + safeName(member.user.tag, 100), [
    '**Member:** <@' + member.id + '>',
    '**Roles:** ' + member.roles.cache.size,
    '**Visible channels:** ' + entries.filter(item => item.canView).length + '/' + entries.length,
    admin ? '\n🚨 This member has Administrator and bypasses channel overwrites.' : '',
    '',
    'Page **' + (current + 1) + '/' + pages + '**',
    '',
    lines.join('\n') || 'No channel access entries found.',
    '',
    'This is effective access calculated for this member, including all held roles and member-specific channel overwrites.',
  ].join('\n'));
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      button('memberpage:' + member.id + ':' + Math.max(0, current - 1) + ':prev', 'Previous', ButtonStyle.Secondary, current === 0),
      button('memberpage:' + member.id + ':' + Math.min(pages - 1, current + 1) + ':next', 'Next', ButtonStyle.Secondary, current >= pages - 1),
      button('dashboard:0', 'All Roles', ButtonStyle.Primary),
    )],
    allowedMentions: { parse: [] },
  };
}

export function buildRoleComparePickerPanel(guild, role) {
  const roles = getManageableRoles(guild)
    .filter(item => item.id !== role.id)
    .slice(0, 25);
  const embed = fieldEmbed('COMPARE ROLE ACCESS', [
    'Compare **' + safeName(role.name, 80) + '** with another role.',
    'The comparison checks server permission flags and channel visibility.',
    '',
    'Select the role to compare below.',
  ].join('\n'));
  if (!roles.length) {
    return {
      embeds: [embed.setDescription('There are no other roles available to compare.')],
      components: [new ActionRowBuilder().addComponents(button('role:' + role.id, 'Back to Role Profile'))],
      allowedMentions: { parse: [] },
    };
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId('skaw_ra_select:compare:' + role.id)
    .setPlaceholder('Select a role to compare')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(roles.map(item => ({
      label: roleLabel(item),
      description: ('Position ' + item.position + ' · members ' + (item.members?.size ?? '—')).slice(0, 100),
      value: item.id,
    })));
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(button('role:' + role.id, 'Back to Role Profile')),
    ],
    allowedMentions: { parse: [] },
  };
}

export function buildBackupsPanel(role, backups) {
  const items = backups
    .filter(item => String(item.snapshot?.roleId) === String(role.id))
    .slice(0, 18);
  const lines = items.map(item => {
    const created = new Date(item.createdAt).getTime();
    return '• Backup ' + item.id + ' · ' +
      (Number.isFinite(created) ? '<t:' + Math.floor(created / 1000) + ':R>' : 'Unknown date') +
      ' · ' + safeName(item.reason, 100) + ' · ' +
      (item.snapshot?.channelOverwrites?.length || 0) + ' overwrite(s)';
  });
  const rows = [];
  if (items.length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId('skaw_ra_select:restore:' + role.id)
      .setPlaceholder('Select a backup to preview and restore')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(items.map(item => ({
        label: ('Backup ' + item.id).slice(0, 100),
        description: (safeName(item.reason, 70) + ' · ' + (item.snapshot?.channelOverwrites?.length || 0) + ' overwrite(s)').slice(0, 100),
        value: String(item.id),
      })));
    rows.push(new ActionRowBuilder().addComponents(select));
  }
  rows.push(new ActionRowBuilder().addComponents(button('role:' + role.id, 'Back to Role Profile')));
  return {
    embeds: [fieldEmbed('ROLE BACKUPS · ' + safeName(role.name, 100), [
      'Available snapshots: **' + items.length + '**',
      '',
      lines.join('\n') || 'No backups stored for this role yet.',
      '',
      items.length
        ? 'Choose a backup from the menu to review its contents. Nothing is restored until you confirm the preview.'
        : 'A backup is created automatically before the first permission change.',
    ].join('\n'))],
    components: rows,
    allowedMentions: { parse: [] },
  };
}

export async function handleRoleAccessButton(interaction, client, args = []) {
  try {
    requirePanelAccess(interaction);
    await prepareGuild(interaction.guild);
    const [action, ...values] = args;

    if (action === 'accesscatpage') {
      const [token, page] = values;
      const session = getRoleChannelAccessSession(token, interaction.user.id, interaction.guildId);
      if (!session) throw new Error('This access panel expired. Reopen /access panel.');
      const role = await fetchRole(interaction.guild, session.roleId);
      if (!role) throw new Error('Selected role no longer exists.');
      updateRoleChannelAccessSession(token, interaction.user.id, interaction.guildId, {
        categoryPage: page,
        channelPage: 0,
      });
      const refreshed = getRoleChannelAccessSession(token, interaction.user.id, interaction.guildId);
      return interaction.update(buildRoleChannelVisibilityPanel(interaction.guild, role, refreshed));
    }
    if (action === 'accesschannelpage') {
      const [token, page] = values;
      const session = getRoleChannelAccessSession(token, interaction.user.id, interaction.guildId);
      if (!session) throw new Error('This access panel expired. Reopen /access panel.');
      const role = await fetchRole(interaction.guild, session.roleId);
      if (!role) throw new Error('Selected role no longer exists.');
      updateRoleChannelAccessSession(token, interaction.user.id, interaction.guildId, { channelPage: page });
      const refreshed = getRoleChannelAccessSession(token, interaction.user.id, interaction.guildId);
      return interaction.update(buildRoleChannelVisibilityPanel(interaction.guild, role, refreshed));
    }
    if (action === 'accessbulk') {
      const [token, rawValue] = values;
      const session = getRoleChannelAccessSession(token, interaction.user.id, interaction.guildId);
      if (!session) throw new Error('This access panel expired. Reopen /access panel.');
      const role = await fetchRole(interaction.guild, session.roleId);
      if (!role) throw new Error('Selected role no longer exists.');
      const group = collectRoleChannelGroups(interaction.guild, role, session)
        .find(item => item.id === session.selectedCategoryId);
      if (!group) throw new Error('Kategori ini sudah tidak tersedia. Pilih kategori lain.');
      const nextValue = rawValue === 'true';
      const desired = Object.fromEntries(group.channels.map(item => [item.channel.id, nextValue]));
      if (group.id !== 'uncategorized') desired[group.id] = nextValue;
      stageRoleChannelAccessStates(token, interaction.user.id, interaction.guildId, desired);
      const refreshed = getRoleChannelAccessSession(token, interaction.user.id, interaction.guildId);
      return interaction.update(buildRoleChannelVisibilityPanel(interaction.guild, role, refreshed));
    }
    if (action === 'accesssave') {
      const session = getRoleChannelAccessSession(values[0], interaction.user.id, interaction.guildId);
      if (!session) throw new Error('This access panel expired. Reopen /access panel.');
      const role = await fetchRole(interaction.guild, session.roleId);
      if (!role) throw new Error('Selected role no longer exists.');
      const pending = await createRoleChannelVisibilityPreview(
        client, interaction.guild, interaction.user.id, session.token,
      );
      pending.sessionToken = session.token;
      return interaction.update(buildRoleChannelVisibilityPreviewPanel(interaction.guild, role, pending));
    }
    if (action === 'accessconfirm') {
      await interaction.deferUpdate();
      const result = await applyPendingRolePermissionChange(client, interaction.guild, interaction.user.id, values[0]);
      const grants = Object.values(result.nextValues || {}).filter(value => value === true).length;
      const revokes = Object.values(result.nextValues || {}).filter(value => value === false).length;
      const oldSession = getRoleChannelAccessSession(
        getRoleChannelAccessSession(values[0], interaction.user.id, interaction.guildId)?.token,
        interaction.user.id,
        interaction.guildId,
      );
      const freshSession = createRoleChannelAccessSession({
        guildId: interaction.guildId,
        actorId: interaction.user.id,
        roleId: result.role.id,
        selectedCategoryId: oldSession?.selectedCategoryId || null,
      });
      const notice = grants + ' target diizinkan, ' + revokes + ' target dicabut. Backup: ' +
        result.backupId + '. Audit: ' + (result.auditPersisted ? 'tersimpan' : 'gagal disimpan—periksa database');
      return interaction.editReply(buildRoleChannelVisibilityPanel(
        interaction.guild, result.role, freshSession, notice,
      ));
    }
    if (action === 'accesscancel') {
      cancelPendingRolePermissionChange(values[0], interaction.user.id);
      const session = getRoleChannelAccessSession(values[1], interaction.user.id, interaction.guildId);
      if (!session) throw new Error('This access panel expired. Reopen /access panel.');
      const role = await fetchRole(interaction.guild, session.roleId);
      if (!role) throw new Error('Selected role no longer exists.');
      return interaction.update(buildRoleChannelVisibilityPanel(interaction.guild, role, session));
    }
    if (action === 'accessdiscard') {
      deleteRoleChannelAccessSession(values[0], interaction.user.id, interaction.guildId);
      return interaction.update(buildRoleAccessDashboard(interaction.guild, 0));
    }
    if (action === 'dashboard') return interaction.update(buildRoleAccessDashboard(interaction.guild, values[0]));
    if (action === 'role') {
      const role = await fetchRole(interaction.guild, values[0]);
      if (!role) throw new Error('Selected role no longer exists.');
      return interaction.update(buildRoleAccessRoleDetail(interaction.guild, role));
    }
    if (action === 'server' || action === 'serveredit') {
      const role = await fetchRole(interaction.guild, values[0]);
      if (!role) throw new Error('Selected role no longer exists.');
      return interaction.update(buildRoleServerPermissionsPanel(role, values[1], action === 'serveredit'));
    }
    if (action === 'channels') {
      const role = await fetchRole(interaction.guild, values[0]);
      if (!role) throw new Error('Selected role no longer exists.');
      return interaction.update(buildRoleChannelsPanel(interaction.guild, role, values[1]));
    }
    if (action === 'channelpick') {
      const role = await fetchRole(interaction.guild, values[0]);
      if (!role) throw new Error('Selected role no longer exists.');
      return interaction.update(buildRoleChannelPickerPanel(interaction.guild, role, values[1]));
    }
    if (action === 'comparepick') {
      const role = await fetchRole(interaction.guild, values[0]);
      if (!role) throw new Error('Selected role no longer exists.');
      return interaction.update(buildRoleComparePickerPanel(interaction.guild, role));
    }
    if (action === 'channelperms') {
      const [roleId, sessionToken, page] = values;
      const role = await fetchRole(interaction.guild, roleId);
      if (!role) throw new Error('Selected role no longer exists.');
      return interaction.update(buildRoleChannelPermissionPanel(interaction.guild, role, sessionToken, interaction.user.id, page));
    }
    if (action === 'serverchange') {
      const [roleId, flagName, rawValue] = values;
      const role = await fetchRole(interaction.guild, roleId);
      if (!role) throw new Error('Selected role no longer exists.');
      const pending = await createServerPermissionPreview(client, interaction.guild, interaction.user.id, roleId, flagName, rawValue === 'true');
      return interaction.update(buildPermissionPreviewPanel(interaction.guild, role, pending));
    }
    if (action === 'channelchange') {
      const [roleId, sessionToken, flagName, rawValue] = values;
      const role = await fetchRole(interaction.guild, roleId);
      if (!role) throw new Error('Selected role no longer exists.');
      const nextValue = rawValue === 'null' ? null : rawValue === 'true';
      const pending = await createChannelPermissionPreview(client, interaction.guild, interaction.user.id, sessionToken, flagName, nextValue);
      return interaction.update(buildPermissionPreviewPanel(interaction.guild, role, pending));
    }
    if (action === 'confirm') {
      await interaction.deferUpdate();
      const result = await applyPendingRolePermissionChange(client, interaction.guild, interaction.user.id, values[0]);
      const detail = result.scope === 'server'
        ? '**' + formatPermissionName(result.permission) + '** ' + (result.nextValue ? 'granted' : 'revoked') + ' for **' + safeName(result.role.name) + '**.'
        : '**' + formatPermissionName(result.permission) + '** set to **' + allowState(result.nextValue) + '** for ' + result.channelRecords.length + ' selected target(s) on **' + safeName(result.role.name) + '**.';
      return interaction.editReply({
        embeds: [fieldEmbed('PERMISSION CHANGE APPLIED', [
          '✅ ' + detail,
          '**Backup:** ' + result.backupId,
          '**Audit persisted:** ' + (result.auditPersisted ? 'Yes' : 'No — check database health'),
        ].join('\n'))],
        components: [new ActionRowBuilder().addComponents(button('role:' + result.role.id, 'Back to Role Profile'))],
        allowedMentions: { parse: [] },
      });
    }
    if (action === 'restoreconfirm') {
      await interaction.deferUpdate();
      const result = await applyRoleBackupRestorePreview(client, interaction.guild, interaction.user.id, values[0]);
      return interaction.editReply({
        embeds: [fieldEmbed('BACKUP RESTORED', [
          '✅ Restored permissions for **' + safeName(result.role.name) + '**.',
          '**Restored role overwrites:** ' + result.restoredOverwrites,
          '**Removed overwrites absent from snapshot:** ' + result.removedOverwrites,
          '**Deleted channels skipped:** ' + result.skippedDeletedChannels,
          '**Safety backup:** ' + result.safetyBackupId,
          '**Audit persisted:** ' + (result.auditPersisted ? 'Yes' : 'No — check database health'),
        ].join('\n'))],
        components: [new ActionRowBuilder().addComponents(button('role:' + result.role.id, 'Back to Role Profile'))],
        allowedMentions: { parse: [] },
      });
    }
    if (action === 'cancel') {
      cancelPendingRolePermissionChange(values[0], interaction.user.id);
      return interaction.update({
        embeds: [fieldEmbed('CHANGE CANCELLED', 'No permission changes were made.')],
        components: [new ActionRowBuilder().addComponents(button('dashboard:0', 'Return to Role Access Manager'))],
        allowedMentions: { parse: [] },
      });
    }
    if (action === 'health') {
      const report = analyzeGuildPermissionHealth(interaction.guild);
      const lines = report.issues.slice(0, 20).map(item =>
        (item.severity === 'critical' ? '🚨' : item.severity === 'warning' ? '⚠️' : 'ℹ️') + ' ' + item.message,
      );
      return interaction.update({
        embeds: [fieldEmbed('PERMISSION HEALTH CHECK', [
          'Roles scanned: **' + report.roleCount + '**',
          'Channels scanned: **' + report.channelCount + '**',
          'Critical: **' + report.criticalCount + '** · Warnings: **' + report.warningCount + '** · Info: **' + report.infoCount + '**',
          '',
          lines.join('\n') || 'No basic permission health issues were detected.',
          '',
          'This is a rules-based review. Findings are prompts for management review, not proof of misconfiguration.',
        ].join('\n'))],
        components: [new ActionRowBuilder().addComponents(button('dashboard:0', 'Back to Dashboard'))],
        allowedMentions: { parse: [] },
      });
    }
    if (action === 'audit') {
      const audit = await getRoleAccessAudit(client, interaction.guildId, 15);
      const lines = audit.map(item => {
        const time = new Date(item.timestamp).getTime();
        return '• ' + (Number.isFinite(time) ? '<t:' + Math.floor(time / 1000) + ':R>' : 'Unknown time') +
          ' · ' + item.action + ' · ' + (item.roleName ? safeName(item.roleName, 60) : 'Role update') +
          ' · ' + (item.actorId ? '<@' + item.actorId + '>' : 'Actor not resolved');
      });
      return interaction.update({
        embeds: [fieldEmbed('ROLE ACCESS · AUDIT HISTORY', lines.join('\n') || 'No Role Access Manager audit records yet.')],
        components: [new ActionRowBuilder().addComponents(button('dashboard:0', 'Back to Dashboard'))],
        allowedMentions: { parse: [] },
      });
    }
    if (action === 'backups') {
      const role = await fetchRole(interaction.guild, values[0]);
      if (!role) throw new Error('Selected role no longer exists.');
      const backups = await getRoleAccessBackups(client, interaction.guildId, 40);
      return interaction.update(buildBackupsPanel(role, backups));
    }
    if (action === 'memberpage') {
      const member = await interaction.guild.members.fetch(values[0]).catch(() => null);
      if (!member) throw new Error('Member is no longer in this server.');
      return interaction.update(buildMemberAccessPanel(interaction.guild, member, values[1]));
    }
    if (action === 'compare') {
      const first = await fetchRole(interaction.guild, values[0]);
      const second = await fetchRole(interaction.guild, values[1]);
      if (!first || !second) throw new Error('Both roles must still exist.');
      const result = compareRoleAccess(interaction.guild, first, second);
      const permissions = result.permissionDifferences.slice(0, 12).map(item =>
        '• **' + item.label + '** — ' + (item.first ? '✅' : '⛔') + ' ' + safeName(first.name, 45) +
        ' / ' + (item.second ? '✅' : '⛔') + ' ' + safeName(second.name, 45),
      );
      const channels = result.channelDifferences.slice(0, 12).map(item =>
        '• <#' + item.channelId + '> — ' + (item.first ? 'Visible' : 'Hidden') + ' / ' + (item.second ? 'Visible' : 'Hidden'),
      );
      return interaction.update({
        embeds: [fieldEmbed('ROLE PERMISSION COMPARISON', [
          '**' + safeName(first.name) + '** vs **' + safeName(second.name) + '**',
          'Different server permission flags: **' + result.permissionDifferences.length + '**',
          'Different channel visibility results: **' + result.channelDifferences.length + '**',
          '',
          '**Server permission differences**',
          permissions.join('\n') || 'No differences.',
          '',
          '**Channel visibility differences**',
          channels.join('\n') || 'No differences.',
          '',
          'Role comparison evaluates each role with @everyone, not a combined member role set.',
        ].join('\n'))],
        components: [new ActionRowBuilder().addComponents(button('dashboard:0', 'Back to Dashboard'))],
        allowedMentions: { parse: [] },
      });
    }
    throw new Error('This panel action is not recognized. Reopen /access panel.');
  } catch (error) {
    return updateWithError(interaction, error);
  }
}

export async function handleRoleAccessSelect(interaction, client, args = []) {
  try {
    requirePanelAccess(interaction);
    await prepareGuild(interaction.guild);
    const [action, ...values] = args;

    if (action === 'rolepick') {
      const role = await fetchRole(interaction.guild, interaction.values?.[0]);
      if (!role || role.id === interaction.guild.id || role.managed) {
        throw new Error('Pilih role server biasa yang bukan @everyone atau role integrasi.');
      }
      const groups = collectRoleChannelGroups(interaction.guild, role, null);
      const session = createRoleChannelAccessSession({
        guildId: interaction.guildId,
        actorId: interaction.user.id,
        roleId: role.id,
        selectedCategoryId: groups[0]?.id || 'uncategorized',
      });
      return interaction.update(buildRoleChannelVisibilityPanel(interaction.guild, role, session));
    }
    if (action === 'role') {
      const role = await fetchRole(interaction.guild, interaction.values?.[0]);
      if (!role) throw new Error('Selected role no longer exists.');
      return interaction.update(buildRoleAccessRoleDetail(interaction.guild, role));
    }
    if (action === 'accesscategory') {
      const token = values[0];
      const session = getRoleChannelAccessSession(token, interaction.user.id, interaction.guildId);
      if (!session) throw new Error('This access panel expired. Reopen /access panel.');
      const role = await fetchRole(interaction.guild, session.roleId);
      if (!role) throw new Error('Selected role no longer exists.');
      const selectedCategoryId = String(interaction.values?.[0] || 'uncategorized');
      updateRoleChannelAccessSession(token, interaction.user.id, interaction.guildId, {
        selectedCategoryId,
        channelPage: 0,
      });
      const refreshed = getRoleChannelAccessSession(token, interaction.user.id, interaction.guildId);
      return interaction.update(buildRoleChannelVisibilityPanel(interaction.guild, role, refreshed));
    }
    if (action === 'accesschannels') {
      const token = values[0];
      const session = getRoleChannelAccessSession(token, interaction.user.id, interaction.guildId);
      if (!session) throw new Error('This access panel expired. Reopen /access panel.');
      const role = await fetchRole(interaction.guild, session.roleId);
      if (!role) throw new Error('Selected role no longer exists.');
      const state = getRoleChannelAccessPanelState(interaction.guild, role, session);
      const selected = new Set((interaction.values || []).map(String));
      const desired = Object.fromEntries(state.pageChannels.map(item => [
        item.channel.id,
        selected.has(item.channel.id),
      ]));
      stageRoleChannelAccessStates(token, interaction.user.id, interaction.guildId, desired);
      const refreshed = getRoleChannelAccessSession(token, interaction.user.id, interaction.guildId);
      return interaction.update(buildRoleChannelVisibilityPanel(interaction.guild, role, refreshed));
    }
    if (action === 'restore') {
      const backupId = interaction.values?.[0];
      if (!backupId) throw new Error('Select a backup first.');
      const pending = await createRoleBackupRestorePreview(
        client, interaction.guild, interaction.user.id, String(backupId),
      );
      const role = await fetchRole(interaction.guild, pending.roleId);
      if (!role) throw new Error('The role from this backup no longer exists.');
      return interaction.update(buildRestorePreviewPanel(role, pending));
    }
    if (action === 'compare') {
      const first = await fetchRole(interaction.guild, values[0]);
      const second = await fetchRole(interaction.guild, interaction.values?.[0]);
      if (!first || !second) throw new Error('Both roles must still exist.');
      const result = compareRoleAccess(interaction.guild, first, second);
      const permissions = result.permissionDifferences.slice(0, 12).map(item =>
        '• **' + item.label + '** — ' + (item.first ? '✅' : '⛔') + ' ' + safeName(first.name, 45) +
        ' / ' + (item.second ? '✅' : '⛔') + ' ' + safeName(second.name, 45),
      );
      const channels = result.channelDifferences.slice(0, 12).map(item =>
        '• <#' + item.channelId + '> — ' + (item.first ? 'Visible' : 'Hidden') + ' / ' + (item.second ? 'Visible' : 'Hidden'),
      );
      return interaction.update({
        embeds: [fieldEmbed('ROLE PERMISSION COMPARISON', [
          '**' + safeName(first.name) + '** vs **' + safeName(second.name) + '**',
          'Different server permission flags: **' + result.permissionDifferences.length + '**',
          'Different channel visibility results: **' + result.channelDifferences.length + '**',
          '',
          '**Server permission differences**',
          permissions.join('\n') || 'No differences.',
          '',
          '**Channel visibility differences**',
          channels.join('\n') || 'No differences.',
          '',
          'Role comparison evaluates each role with @everyone, not a combined member role set.',
        ].join('\n'))],
        components: [new ActionRowBuilder().addComponents(button('role:' + first.id, 'Back to Role Profile'))],
        allowedMentions: { parse: [] },
      });
    }
    if (action === 'serverflag') {
      const role = await fetchRole(interaction.guild, values[0]);
      if (!role) throw new Error('Selected role no longer exists.');
      const flagName = interaction.values?.[0];
      if (!getPermissionEntries().some(entry => entry.name === flagName)) throw new Error('Unknown permission flag.');
      return interaction.update(buildPermissionChoicePanel(role, 'server', flagName));
    }
    if (action === 'channelpick') {
      const role = await fetchRole(interaction.guild, values[0]);
      if (!role) throw new Error('Selected role no longer exists.');
      const selected = [...new Set((interaction.values || []).map(String))].slice(0, 25);
      if (!selected.length) throw new Error('Select at least one channel or category.');
      const sessionToken = createChannelEditorSession({
        guildId: interaction.guildId, actorId: interaction.user.id,
        roleId: role.id, channelIds: selected,
      });
      return interaction.update(buildRoleChannelPermissionPanel(interaction.guild, role, sessionToken, interaction.user.id, 0));
    }
    if (action === 'channelflag') {
      const role = await fetchRole(interaction.guild, values[0]);
      if (!role) throw new Error('Selected role no longer exists.');
      const session = getChannelEditorSession(values[1], interaction.user.id, interaction.guildId);
      if (!session || session.roleId !== role.id) throw new Error('This channel selection expired. Reopen the editor.');
      const flagName = interaction.values?.[0];
      if (!CHANNEL_PERMISSION_ENTRIES.some(entry => entry.name === flagName)) throw new Error('This permission cannot be edited at channel level.');
      return interaction.update(buildPermissionChoicePanel(role, 'channel', flagName, values[1]));
    }
    throw new Error('This selection is no longer available. Reopen the Access Manager.');
  } catch (error) {
    return updateWithError(interaction, error);
  }
}
