import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType,
  EmbedBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits, RoleSelectMenuBuilder, TextInputBuilder,
  TextInputStyle, UserSelectMenuBuilder,
} from 'discord.js';
import {
  buildVerificationLogsEmbed, buildVerificationPanelPayload, getConfiguredVerifiedRoleIds,
  getSkawVerificationConfig, getSkawVerificationLogs, publishSkawVerificationPanel,
  registerSkawMember, resetSkawVerification, syncSkawVerificationMemberRoles,
  updateSkawVerificationConfig, validateSkawVerificationSetup,
} from './skawVerificationService.js';

const BLUE = 0x1A9EF3;
const ADMIN_PREFIX = 'skaw_vf_admin';

function componentId(ownerId, action) {
  return ADMIN_PREFIX + ':' + String(ownerId) + ':' + action;
}

function button(ownerId, action, label, style = ButtonStyle.Secondary, disabled = false) {
  return new ButtonBuilder().setCustomId(componentId(ownerId, action))
    .setLabel(label).setStyle(style).setDisabled(disabled);
}

function navigationRows(ownerId, activePage) {
  const pages = [
    ['overview', 'Overview'], ['general', 'General'], ['roles', 'Roles'],
    ['appearance', 'Appearance'], ['guide', 'Guide'], ['members', 'Members'], ['activity', 'Activity'],
  ];
  const make = ([page, label]) => button(ownerId, 'page_' + page,
    (activePage === page ? '• ' : '') + label,
    activePage === page ? ButtonStyle.Primary : ButtonStyle.Secondary);
  return [
    new ActionRowBuilder().addComponents(...pages.slice(0, 5).map(make)),
    new ActionRowBuilder().addComponents(
      ...pages.slice(5).map(make),
      button(ownerId, 'page_preview', 'Preview'),
      button(ownerId, 'publish', 'Publish', ButtonStyle.Success),
    ),
  ];
}

function roleNames(guild, ids) {
  return ids.map(id => guild.roles.cache.get(String(id))?.name || 'Missing role').join(', ') || 'Belum diatur';
}

function buildOverviewEmbed(guild, config) {
  return new EmbedBuilder().setColor(config.enabled ? 0x22C55E : 0xD97706)
    .setAuthor({ name: 'SKAW GROUP · ADMINISTRATION' }).setTitle('Verification Manager')
    .setDescription('Manage the member registration system from this private control center.')
    .addFields(
      { name: 'System Status', value: config.enabled ? '🟢 Enabled' : '🟠 Disabled', inline: true },
      { name: 'Panel Status', value: config.panelMessageId ? 'Published' : 'Not published', inline: true },
      { name: 'Verification Channel', value: config.verificationChannelId ? '<#' + config.verificationChannelId + '>' : 'Belum diatur', inline: true },
      { name: 'Unverified Role', value: config.unverifiedRoleId ? roleNames(guild, [config.unverifiedRoleId]) : 'Belum diatur', inline: true },
      { name: 'Reward Roles', value: roleNames(guild, getConfiguredVerifiedRoleIds(config)), inline: true },
      { name: 'Member Log Channel', value: config.logChannelId ? '<#' + config.logChannelId + '>' : 'Tidak diatur', inline: true },
    ).setFooter({ text: 'SKAW VERIFICATION · Configuration stored in PostgreSQL' });
}

function buildPageEmbed(guild, config, page, selectedMemberId = null) {
  if (page === 'overview') return buildOverviewEmbed(guild, config);
  if (page === 'general') return new EmbedBuilder().setColor(BLUE).setTitle('General Settings')
    .setDescription('Atur channel registrasi, channel log member (opsional), dan status sistem.')
    .addFields(
      { name: 'Verification Channel', value: config.verificationChannelId ? '<#' + config.verificationChannelId + '>' : 'Belum dipilih', inline: true },
      { name: 'Member Log Channel', value: config.logChannelId ? '<#' + config.logChannelId + '>' : 'Tidak diatur', inline: true },
      { name: 'System', value: config.enabled ? 'Enabled' : 'Disabled', inline: true },
    ).setFooter({ text: 'Channel baru menjadi tujuan publish panel berikutnya.' });
  if (page === 'roles') return new EmbedBuilder().setColor(BLUE).setTitle('Role Management')
    .setDescription('Pilih satu role Unverified dan hingga 25 reward roles. Semua reward roles diberikan setelah registrasi berhasil.')
    .addFields(
      { name: 'Unverified Role', value: config.unverifiedRoleId ? roleNames(guild, [config.unverifiedRoleId]) : 'Belum dipilih' },
      { name: 'Reward Roles', value: roleNames(guild, getConfiguredVerifiedRoleIds(config)) },
    ).setFooter({ text: 'Perubahan reward roles tidak otomatis mengubah member yang sudah terverifikasi.' });
  if (page === 'appearance') return new EmbedBuilder().setColor(BLUE).setTitle('Panel Designer')
    .setDescription('Atur konten embed, banner, footer, ikon footer, dan warna panel registrasi.')
    .addFields(
      { name: 'Panel Title', value: config.panelTitle || '—' },
      { name: 'Description', value: String(config.panelDescription || '—').slice(0, 900) },
      { name: 'Banner', value: config.imageUrl ? 'Configured' : 'Belum diatur', inline: true },
      { name: 'Footer', value: config.footerText || '—', inline: true },
      { name: 'Embed Color', value: config.embedColor || '#1A9EF3', inline: true },
    );
  if (page === 'guide') return new EmbedBuilder().setColor(BLUE).setTitle('Registration Guide')
    .setDescription(String(config.guideText || 'Panduan belum diatur.').slice(0, 3900))
    .setFooter({ text: 'Gunakan Edit Guide untuk memperbarui petunjuk member.' });
  if (page === 'members') return new EmbedBuilder().setColor(BLUE).setTitle('Member Management')
    .setDescription(selectedMemberId
      ? 'Target member: <@' + selectedMemberId + '>\nPilih tindakan untuk member ini di bawah.'
      : 'Pilih member Discord untuk registrasi manual, reset verifikasi, atau menyelaraskan reward roles dengan konfigurasi terbaru.')
    .setFooter({ text: 'Role sync tidak meminta member mengisi ulang formulir.' });
  if (page === 'activity') return new EmbedBuilder().setColor(BLUE).setTitle('Verification Activity')
    .setDescription('Riwayat registrasi, perubahan nama IC, dan reset verifikasi member.');
  if (page === 'preview') {
    const preview = buildVerificationPanelPayload(config).embeds[0];
    preview.setAuthor({ name: 'PREVIEW · SKAW GROUP COMMUNITY' });
    return preview;
  }
  return buildOverviewEmbed(guild, config);
}

export function buildVerificationDashboardPayload({ guild, ownerId, config, page = 'overview', selectedMemberId = null, content = null }) {
  const payload = {
    content: content || undefined,
    embeds: [buildPageEmbed(guild, config, page, selectedMemberId)],
    components: navigationRows(ownerId, page),
    allowedMentions: { parse: [] },
  };
  if (page === 'general') {
    const channel = new ChannelSelectMenuBuilder().setCustomId(componentId(ownerId, 'select_verification_channel'))
      .setPlaceholder('Pilih channel registrasi').setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1);
    if (config.verificationChannelId) channel.setDefaultChannels(config.verificationChannelId);
    payload.components.push(new ActionRowBuilder().addComponents(channel));
    const logChannel = new ChannelSelectMenuBuilder().setCustomId(componentId(ownerId, 'select_log_channel'))
      .setPlaceholder('Pilih channel log member (opsional)').setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1);
    if (config.logChannelId) logChannel.setDefaultChannels(config.logChannelId);
    payload.components.push(new ActionRowBuilder().addComponents(
      logChannel, button(ownerId, 'clear_log_channel', 'Clear Log', ButtonStyle.Danger)));
    payload.components.push(new ActionRowBuilder().addComponents(
      button(ownerId, 'toggle_system', config.enabled ? 'Disable Verification' : 'Enable Verification',
        config.enabled ? ButtonStyle.Danger : ButtonStyle.Success)));
  }
  if (page === 'roles') {
    const unverified = new RoleSelectMenuBuilder().setCustomId(componentId(ownerId, 'select_unverified_role'))
      .setPlaceholder('Pilih role Unverified').setMinValues(1).setMaxValues(1);
    if (config.unverifiedRoleId) unverified.setDefaultRoles(config.unverifiedRoleId);
    payload.components.push(new ActionRowBuilder().addComponents(unverified));
    const rewards = new RoleSelectMenuBuilder().setCustomId(componentId(ownerId, 'select_reward_roles'))
      .setPlaceholder('Pilih reward roles (multi-select)').setMinValues(1).setMaxValues(25);
    if (getConfiguredVerifiedRoleIds(config).length) rewards.setDefaultRoles(...getConfiguredVerifiedRoleIds(config));
    payload.components.push(new ActionRowBuilder().addComponents(rewards));
  }
  if (page === 'appearance') payload.components.push(new ActionRowBuilder().addComponents(
    button(ownerId, 'edit_panel', 'Edit Title, Description & Banner', ButtonStyle.Primary),
    button(ownerId, 'edit_footer', 'Edit Footer & Color')));
  if (page === 'guide') payload.components.push(new ActionRowBuilder().addComponents(
    button(ownerId, 'edit_guide', 'Edit Registration Guide', ButtonStyle.Primary)));
  if (page === 'members') {
    const users = new UserSelectMenuBuilder().setCustomId(componentId(ownerId, 'select_member'))
      .setPlaceholder('Pilih member Discord').setMinValues(1).setMaxValues(1);
    payload.components.push(new ActionRowBuilder().addComponents(users));
    if (selectedMemberId) payload.components.push(new ActionRowBuilder().addComponents(
      button(ownerId, 'manual_' + selectedMemberId, 'Manual Registration', ButtonStyle.Primary),
      button(ownerId, 'reset_' + selectedMemberId, 'Reset Verification', ButtonStyle.Danger),
      button(ownerId, 'sync_' + selectedMemberId, 'Update Roles', ButtonStyle.Success)));
  }
  return payload;
}

function buildPanelModal(ownerId, config) {
  const title = new TextInputBuilder().setCustomId('panel_title').setLabel('Panel Title')
    .setStyle(TextInputStyle.Short).setMaxLength(256).setRequired(true)
    .setValue(String(config.panelTitle || 'SKAW Group — Member Verification').slice(0, 256));
  const description = new TextInputBuilder().setCustomId('panel_description').setLabel('Panel Description')
    .setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)
    .setValue(String(config.panelDescription || '').slice(0, 1000));
  const banner = new TextInputBuilder().setCustomId('banner_url').setLabel('Banner HTTPS URL (empty removes)')
    .setStyle(TextInputStyle.Short).setMaxLength(400).setRequired(false).setPlaceholder('https://example.com/skaw-banner.png');
  return new ModalBuilder().setCustomId(componentId(ownerId, 'modal_panel')).setTitle('Panel Designer')
    .addComponents(new ActionRowBuilder().addComponents(title),
      new ActionRowBuilder().addComponents(description), new ActionRowBuilder().addComponents(banner));
}

function buildFooterModal(ownerId, config) {
  const footer = new TextInputBuilder().setCustomId('footer_text').setLabel('Footer Text')
    .setStyle(TextInputStyle.Short).setMaxLength(2048).setRequired(true)
    .setValue(String(config.footerText || 'RIGHT SOLUTION, GREAT QUALITY · SKAW VERIFICATION').slice(0, 2048));
  const icon = new TextInputBuilder().setCustomId('footer_icon_url').setLabel('Footer Icon HTTPS URL (empty removes)')
    .setStyle(TextInputStyle.Short).setMaxLength(400).setRequired(false).setPlaceholder('https://example.com/skaw-icon.png');
  const color = new TextInputBuilder().setCustomId('embed_color').setLabel('Embed Color HEX')
    .setStyle(TextInputStyle.Short).setMaxLength(7).setRequired(true)
    .setValue(String(config.embedColor || '#1A9EF3').slice(0, 7));
  return new ModalBuilder().setCustomId(componentId(ownerId, 'modal_footer')).setTitle('Footer & Embed Color')
    .addComponents(new ActionRowBuilder().addComponents(footer),
      new ActionRowBuilder().addComponents(icon), new ActionRowBuilder().addComponents(color));
}

function buildGuideModal(ownerId, config) {
  const guide = new TextInputBuilder().setCustomId('guide_text').setLabel('Registration Guide')
    .setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(true)
    .setValue(String(config.guideText || '').slice(0, 4000));
  return new ModalBuilder().setCustomId(componentId(ownerId, 'modal_guide')).setTitle('Registration Guide')
    .addComponents(new ActionRowBuilder().addComponents(guide));
}

function buildManualRegistrationModal(ownerId, memberId) {
  const first = new TextInputBuilder().setCustomId('first_name').setLabel('IC First Name')
    .setStyle(TextInputStyle.Short).setMaxLength(32).setRequired(true);
  const last = new TextInputBuilder().setCustomId('last_name').setLabel('IC Last Name')
    .setStyle(TextInputStyle.Short).setMaxLength(32).setRequired(true);
  return new ModalBuilder().setCustomId(componentId(ownerId, 'modal_manual_' + memberId))
    .setTitle('Manual Member Registration')
    .addComponents(new ActionRowBuilder().addComponents(first), new ActionRowBuilder().addComponents(last));
}

function validateHttpsUrl(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  let parsed;
  try { parsed = new URL(normalized); } catch { throw new Error(label + ' harus berupa URL HTTPS yang valid.'); }
  if (parsed.protocol !== 'https:') throw new Error(label + ' harus menggunakan HTTPS.');
  return normalized;
}

async function renderPage(interaction, client, page, selectedMemberId = null, content = null) {
  const config = await getSkawVerificationConfig(client, interaction.guildId);
  const payload = buildVerificationDashboardPayload({
    guild: interaction.guild, ownerId: interaction.user.id, config, page, selectedMemberId, content,
  });
  if (page === 'activity') {
    const logs = await getSkawVerificationLogs(client, interaction.guildId, 10);
    payload.embeds.push(buildVerificationLogsEmbed(logs));
  }
  return payload;
}

export async function openVerificationDashboard(interaction, client) {
  if (!interaction.inGuild?.() || !interaction.guild) {
    return interaction.reply({ content: 'Dashboard Verification hanya dapat digunakan di dalam server.', flags: MessageFlags.Ephemeral });
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: 'Akses ditolak. Permission Manage Server diperlukan.', flags: MessageFlags.Ephemeral });
  }
  const config = await getSkawVerificationConfig(client, interaction.guildId);
  return interaction.reply({
    ...buildVerificationDashboardPayload({ guild: interaction.guild, ownerId: interaction.user.id, config }),
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleSkawVerificationDashboardInteraction(interaction, client) {
  const [, ownerId, action] = String(interaction.customId || '').split(':');
  if (!ownerId || ownerId !== String(interaction.user.id)) {
    return interaction.reply({ content: 'Dashboard ini hanya dapat digunakan oleh administrator yang membukanya.', flags: MessageFlags.Ephemeral });
  }
  if (!interaction.guild || !interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: 'Akses dashboard ditolak. Permission Manage Server diperlukan.', flags: MessageFlags.Ephemeral });
  }
  try {
    if (action.startsWith('page_')) return interaction.update(await renderPage(interaction, client, action.slice(5)));
    if (action === 'select_verification_channel') {
      await updateSkawVerificationConfig(client, interaction.guildId, { verificationChannelId: interaction.values[0] });
      return interaction.update(await renderPage(interaction, client, 'general', null, '✅ Verification channel updated.'));
    }
    if (action === 'select_log_channel') {
      await updateSkawVerificationConfig(client, interaction.guildId, { logChannelId: interaction.values[0] });
      return interaction.update(await renderPage(interaction, client, 'general', null, '✅ Member log channel updated.'));
    }
    if (action === 'clear_log_channel') {
      await updateSkawVerificationConfig(client, interaction.guildId, { logChannelId: null });
      return interaction.update(await renderPage(interaction, client, 'general', null, '✅ Member log channel cleared.'));
    }
    if (action === 'select_unverified_role') {
      const selected = String(interaction.values[0]);
      const config = await getSkawVerificationConfig(client, interaction.guildId);
      if (getConfiguredVerifiedRoleIds(config).includes(selected)) throw new Error('Role Unverified tidak boleh sama dengan reward role.');
      await updateSkawVerificationConfig(client, interaction.guildId, { unverifiedRoleId: selected });
      return interaction.update(await renderPage(interaction, client, 'roles', null, '✅ Unverified role updated.'));
    }
    if (action === 'select_reward_roles') {
      const selected = [...new Set(interaction.values.map(String))];
      const config = await getSkawVerificationConfig(client, interaction.guildId);
      if (selected.includes(String(config.unverifiedRoleId || ''))) throw new Error('Role Unverified tidak boleh menjadi reward role.');
      if (!selected.length || selected.length > 25) throw new Error('Pilih antara 1 hingga 25 reward roles.');
      await updateSkawVerificationConfig(client, interaction.guildId, { verifiedRoleIds: selected });
      return interaction.update(await renderPage(interaction, client, 'roles', null, '✅ Reward roles updated.'));
    }
    if (action === 'select_member') return interaction.update(await renderPage(interaction, client, 'members', interaction.values[0]));
    if (action === 'toggle_system') {
      const config = await getSkawVerificationConfig(client, interaction.guildId);
      const enabled = !config.enabled;
      if (enabled) await validateSkawVerificationSetup(interaction.guild, config);
      await updateSkawVerificationConfig(client, interaction.guildId, { enabled });
      return interaction.update(await renderPage(interaction, client, 'general', null, enabled ? '✅ Verification system enabled.' : '⚠️ Verification system disabled.'));
    }
    if (action === 'edit_panel' || action === 'edit_footer' || action === 'edit_guide') {
      const config = await getSkawVerificationConfig(client, interaction.guildId);
      if (action === 'edit_panel') return interaction.showModal(buildPanelModal(ownerId, config));
      if (action === 'edit_footer') return interaction.showModal(buildFooterModal(ownerId, config));
      return interaction.showModal(buildGuideModal(ownerId, config));
    }
    if (action === 'page_preview' || action === 'preview') return interaction.update(await renderPage(interaction, client, 'preview'));
    if (action === 'publish') {
      const result = await publishSkawVerificationPanel(client, interaction.guild);
      return interaction.update(await renderPage(interaction, client, 'overview', null,
        '✅ Verification panel published or updated in ' + result.channel.toString() + '.'));
    }
    if (action.startsWith('manual_')) return interaction.showModal(buildManualRegistrationModal(ownerId, action.slice(7)));
    if (action.startsWith('reset_')) {
      const memberId = action.slice(6);
      const member = await interaction.guild.members.fetch(memberId);
      await resetSkawVerification(client, interaction.guild, member, interaction.user.id);
      return interaction.update(await renderPage(interaction, client, 'members', memberId, '✅ Member verification reset.'));
    }
    if (action.startsWith('sync_')) {
      const memberId = action.slice(5);
      const member = await interaction.guild.members.fetch(memberId);
      const result = await syncSkawVerificationMemberRoles(client, interaction.guild, member);
      const details = result.addedRoleIds.length || result.removedRoleIds.length
        ? 'Added: ' + result.addedRoleIds.length + ' · Removed: ' + result.removedRoleIds.length
        : 'Tidak ada perubahan role yang diperlukan.';
      return interaction.update(await renderPage(interaction, client, 'members', memberId, '✅ Roles synchronized. ' + details));
    }
    return interaction.reply({ content: 'Aksi dashboard tidak dikenal. Jalankan kembali /verification panel.', flags: MessageFlags.Ephemeral });
  } catch (error) {
    const message = '❌ SKAW Verification: ' + String(error?.message || 'Permintaan tidak dapat diproses.').slice(0, 1500);
    if (interaction.isModalSubmit?.()) return interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => null);
    return interaction.update(await renderPage(interaction, client, 'overview', null, message)).catch(() => null);
  }
}

export async function handleSkawVerificationDashboardModal(interaction, client) {
  const [, ownerId, action] = String(interaction.customId || '').split(':');
  if (!ownerId || ownerId !== String(interaction.user.id) || !interaction.guild ||
      !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: 'Akses modal ditolak.', flags: MessageFlags.Ephemeral });
  }
  try {
    if (action === 'modal_panel') {
      const bannerUrl = validateHttpsUrl(interaction.fields.getTextInputValue('banner_url'), 'Banner URL');
      await updateSkawVerificationConfig(client, interaction.guildId, {
        panelTitle: interaction.fields.getTextInputValue('panel_title').trim().slice(0, 256),
        panelDescription: interaction.fields.getTextInputValue('panel_description').trim().slice(0, 1000),
        imageUrl: bannerUrl,
      });
      return interaction.reply({ content: '✅ Panel content and banner saved. Reopen /verification panel to refresh the dashboard.', flags: MessageFlags.Ephemeral });
    }
    if (action === 'modal_footer') {
      const footerIconUrl = validateHttpsUrl(interaction.fields.getTextInputValue('footer_icon_url'), 'Footer icon URL');
      const embedColor = interaction.fields.getTextInputValue('embed_color').trim();
      if (!/^#?[0-9a-f]{6}$/i.test(embedColor)) throw new Error('Embed color harus berupa HEX 6 digit, contoh #1A9EF3.');
      await updateSkawVerificationConfig(client, interaction.guildId, {
        footerText: interaction.fields.getTextInputValue('footer_text').trim().slice(0, 2048),
        footerIconUrl,
        embedColor: embedColor.startsWith('#') ? embedColor.toUpperCase() : '#' + embedColor.toUpperCase(),
      });
      return interaction.reply({ content: '✅ Footer and embed color saved. Reopen /verification panel to refresh the dashboard.', flags: MessageFlags.Ephemeral });
    }
    if (action === 'modal_guide') {
      await updateSkawVerificationConfig(client, interaction.guildId, {
        guideText: interaction.fields.getTextInputValue('guide_text').trim().slice(0, 4000),
      });
      return interaction.reply({ content: '✅ Registration guide saved. Reopen /verification panel to refresh the dashboard.', flags: MessageFlags.Ephemeral });
    }
    if (action.startsWith('modal_manual_')) {
      const memberId = action.slice('modal_manual_'.length);
      const member = await interaction.guild.members.fetch(memberId);
      const result = await registerSkawMember(client, interaction.guild, member, {
        firstName: interaction.fields.getTextInputValue('first_name'),
        lastName: interaction.fields.getTextInputValue('last_name'),
      }, { source: 'manual', actorId: interaction.user.id });
      return interaction.reply({
        content: '✅ Manual registration completed for <@' + memberId + '>. IC Name: **' + result.record.icName + '**.',
        flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
      });
    }
    return interaction.reply({ content: 'Modal tidak dikenali.', flags: MessageFlags.Ephemeral });
  } catch (error) {
    return interaction.reply({
      content: '❌ SKAW Verification: ' + String(error?.message || 'Permintaan tidak dapat diproses.').slice(0, 1500),
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
    }).catch(() => null);
  }
}

export function isSkawVerificationDashboardInteraction(interaction) {
  const id = String(interaction?.customId || '');
  return id.startsWith(ADMIN_PREFIX + ':') && (
    interaction.isButton?.() || interaction.isChannelSelectMenu?.() ||
    interaction.isRoleSelectMenu?.() || interaction.isUserSelectMenu?.() || interaction.isModalSubmit?.()
  );
}

export async function handleSkawVerificationDashboardRoute(interaction, client) {
  if (interaction.isModalSubmit?.()) return handleSkawVerificationDashboardModal(interaction, client);
  return handleSkawVerificationDashboardInteraction(interaction, client);
}
