// Role Template panel and prefix-command handlers for SKAW GROUP.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
  ModalBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { getCommandPrefix } from '../config/bot.js';
import {
  canManageRoleTemplates, createRoleTemplate, deleteRoleTemplate, getRoleTemplateById,
  getRoleTemplateConfig, getRoleHierarchyViolations, renameRoleTemplate,
  setRoleTemplateEnabled, setRoleTemplateRoles,
} from './roleTemplateService.js';

const BLUE = 0x2563EB;
const PAGE_SIZE = 20;
const PREFIX = 'skaw_rt_';

function button(id, label, style = ButtonStyle.Secondary, disabled = false) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(Boolean(disabled));
}
function formValue(interaction, id) {
  try { return interaction.fields.getTextInputValue(id).trim(); } catch { return ''; }
}
function pageCount(config) { return Math.max(1, Math.ceil(config.templates.length / PAGE_SIZE)); }
function parseId(customId) { return String(customId || '').split(':'); }
function isAllowed(interaction) { return canManageRoleTemplates(interaction.memberPermissions); }
async function replyDenied(interaction) {
  const payload = { content: 'Access denied. Administrator or Manage Server permission is required.', flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload).catch(() => {});
  return interaction.reply(payload).catch(() => {});
}
async function getActorMember(interaction) {
  if (!interaction.guild) return null;
  return interaction.guild.members.fetch(interaction.user.id).catch(() => null);
}
async function prepareRoleHierarchy(guild) {
  await guild.members.fetchMe().catch(() => null);
  await guild.roles.fetch().catch(() => null);
}
async function editPanelMessage(client, channelId, messageId, payload) {
  if (!channelId || !messageId || messageId === '0') return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.() || !channel.messages?.fetch) return;
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (message?.author?.id === client.user?.id) await message.edit(payload).catch(() => {});
}
function dashboard(config) {
  const enabled = config.templates.filter(t => t.enabled && t.roleIds.length).length;
  const drafts = config.templates.filter(t => !t.roleIds.length).length;
  const embed = new EmbedBuilder().setColor(BLUE).setAuthor({ name: 'SKAW GROUP · MANAGEMENT' })
    .setTitle('ROLE TEMPLATE SYSTEM').setDescription([
      '**ROLE TEMPLATE MANAGEMENT**',
      'Create reusable role presets and assign them in one action.',
      '',
      '**Templates:** ' + config.templates.length,
      '**Enabled:** ' + enabled,
      '**Draft / empty:** ' + drafts,
      '',
      'Assignment only adds missing roles. Existing member roles are never removed.',
      'Access: Administrator or Manage Server.',
      'Rank protection: you must outrank every role in a template.',
    ].join('\n')).setFooter({ text: 'SKAW GROUP • ROLE TEMPLATE SYSTEM V1' });
  return { content: '', embeds: [embed], components: [new ActionRowBuilder().addComponents(
    button('skaw_rt_create', 'Create Template', ButtonStyle.Success),
    button('skaw_rt_list:0', 'Template List', ButtonStyle.Primary),
    button('skaw_rt_refresh', 'Refresh'),
  )], allowedMentions: { parse: [] } };
}
function listPayload(config, page = 0) {
  const pages = pageCount(config);
  const current = Math.max(0, Math.min(pages - 1, Number(page) || 0));
  const items = config.templates.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);
  const embed = new EmbedBuilder().setColor(BLUE).setTitle('ROLE TEMPLATE · LIST')
    .setDescription(items.length ? items.map((t, i) =>
      '**' + (current * PAGE_SIZE + i + 1) + '. ' + t.name + '** · ' +
      (t.roleIds.length ? (t.enabled ? 'ENABLED' : 'DISABLED') : 'DRAFT') +
      '\nKey: `' + t.slug + '` · Roles: ' + t.roleIds.length
    ).join('\n\n').slice(0, 3900) : 'No templates created yet.')
    .setFooter({ text: 'Page ' + (current + 1) + '/' + pages + ' • ' + config.templates.length + ' templates' });
  const components = [];
  if (items.length) components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId('skaw_rt_template_select:' + current).setPlaceholder('Select a template to manage')
    .setMinValues(1).setMaxValues(1).addOptions(items.map(t => ({
      label: t.name.slice(0, 100), description: (t.slug + ' · ' + t.roleIds.length + ' roles').slice(0, 100), value: t.id,
    })))));
  components.push(new ActionRowBuilder().addComponents(
    button('skaw_rt_list:' + Math.max(0, current - 1) + ':prev', 'Previous', ButtonStyle.Secondary, current === 0),
    button('skaw_rt_list:' + Math.min(pages - 1, current + 1) + ':next', 'Next', ButtonStyle.Secondary, current >= pages - 1),
    button('skaw_rt_create', 'Create', ButtonStyle.Success),
    button('skaw_rt_home', 'Dashboard'),
  ));
  return { content: '', embeds: [embed], components, allowedMentions: { parse: [] } };
}
function detailPayload(template, guild) {
  const roleLines = template.roleIds.length
    ? template.roleIds.map(id => guild?.roles?.cache?.get(id) ? '<@&' + id + '>' : '`Missing role: ' + id + '`').join('\n')
    : 'No roles configured yet.';
  const status = !template.roleIds.length ? 'DRAFT' : template.enabled ? 'ENABLED' : 'DISABLED';
  const embed = new EmbedBuilder().setColor(BLUE).setTitle('ROLE TEMPLATE · ' + template.name)
    .setDescription([
      '**Status:** ' + status,
      '**Command key:** `' + template.slug + '`',
      '**Configured roles (' + template.roleIds.length + '/' + 25 + '):**',
      roleLines,
      '',
      'Selecting roles below replaces this template role list.',
      'Rank protection: your highest role must be above every selected role. The bot role must also be higher.',
      'Enabling requires at least one role.',
    ].join('\n')).setFooter({ text: 'SKAW GROUP • ROLE TEMPLATE SYSTEM V1' });
  const row1 = new ActionRowBuilder().addComponents(
    button('skaw_rt_rename:' + template.id, 'Rename'),
    button('skaw_rt_enabled:' + template.id, template.enabled ? 'Disable' : 'Enable', template.enabled ? ButtonStyle.Secondary : ButtonStyle.Success, !template.roleIds.length),
    button('skaw_rt_delete:' + template.id, 'Delete', ButtonStyle.Danger),
    button('skaw_rt_back', 'Back to List'),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId('skaw_rt_roles:' + template.id)
      .setPlaceholder('Select roles to replace this template').setMinValues(1).setMaxValues(25),
  );
  const row3 = new ActionRowBuilder().addComponents(button('skaw_rt_clear:' + template.id, 'Clear Roles', ButtonStyle.Danger, !template.roleIds.length));
  return { content: '', embeds: [embed], components: [row1, row2, row3], allowedMentions: { parse: [] } };
}
function createModal(channelId, messageId) {
  return new ModalBuilder().setCustomId('skaw_rt_modal_create:' + channelId + ':' + messageId)
    .setTitle('Create Role Template').addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('name').setLabel('Template name').setPlaceholder('e.g. Mechanic')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80),
    ));
}
function renameModal(template, channelId, messageId) {
  return new ModalBuilder().setCustomId('skaw_rt_modal_rename:' + template.id + ':' + channelId + ':' + messageId)
    .setTitle('Rename Role Template').addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('name').setLabel('New template name')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80).setValue(template.name.slice(0, 80)),
    ));
}
async function getConfig(client, interaction) {
  return getRoleTemplateConfig(client, interaction.guildId);
}
async function respondError(interaction, error) {
  const message = error?.message || 'The request could not be completed.';
  const payload = { content: '❌ ' + message.slice(0, 1800), flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload).catch(() => {});
  return interaction.reply(payload).catch(() => {});
}

export async function openRoleTemplatePanel(message, client, guildConfig = null) {
  if (!canManageRoleTemplates(message.member?.permissions)) {
    await message.reply({
      content: 'Access denied. Administrator or Manage Server permission is required.',
      allowedMentions: { users: [message.author.id], parse: [] },
    }).catch(() => {});
    return false;
  }
  const config = await getRoleTemplateConfig(client, message.guild.id);
  await message.channel.send({ ...dashboard(config), allowedMentions: { parse: [] } });
  return true;
}

export async function handleRoleTemplateMessage(message, client, guildConfig = null) {
  const prefix = guildConfig?.prefix || getCommandPrefix();
  if (message.content.trim().toLowerCase() !== (String(prefix) + 'rolepanel').toLowerCase()) return false;
  await openRoleTemplatePanel(message, client, guildConfig);
  return true;
}

export async function handleRoleTemplateInteraction(interaction) {
  if (!String(interaction.customId || '').startsWith(PREFIX)) return false;
  if (!interaction.guild || !interaction.guildId || !isAllowed(interaction)) {
    await replyDenied(interaction);
    return true;
  }

  const parts = parseId(interaction.customId);
  const action = parts[0];
  const client = interaction.client;
  const actor = await getActorMember(interaction);
  if (!actor) {
    await respondError(interaction, new Error('Could not verify your server member profile.'));
    return true;
  }

  try {
    const config = await getConfig(client, interaction);
    if (interaction.isButton?.()) {
      if (action === 'skaw_rt_create') {
        return await interaction.showModal(createModal(interaction.channelId, interaction.message?.id || '0')).then(() => true);
      }
      if (action === 'skaw_rt_refresh' || action === 'skaw_rt_home') {
        await interaction.update(dashboard(config));
        return true;
      }
      if (action === 'skaw_rt_list') {
        await interaction.update(listPayload(config, parts[1]));
        return true;
      }
      if (action === 'skaw_rt_back') {
        await interaction.update(listPayload(config, 0));
        return true;
      }
      if (action === 'skaw_rt_rename') {
        const template = getRoleTemplateById(config, parts[1]);
        if (!template) throw new Error('Template not found.');
        await interaction.showModal(renameModal(template, interaction.channelId, interaction.message?.id || '0'));
        return true;
      }
      if (action === 'skaw_rt_enabled') {
        const template = getRoleTemplateById(config, parts[1]);
        if (!template) throw new Error('Template not found.');
        const result = await setRoleTemplateEnabled(client, interaction.guildId, template.id, !template.enabled, interaction.user.id);
        await interaction.update(detailPayload(result.template, interaction.guild));
        return true;
      }
      if (action === 'skaw_rt_clear') {
        const template = getRoleTemplateById(config, parts[1]);
        if (!template) throw new Error('Template not found.');
        const result = await setRoleTemplateRoles(client, interaction.guildId, template.id, [], interaction.user.id);
        await interaction.update(detailPayload(result.template, interaction.guild));
        return true;
      }
      if (action === 'skaw_rt_delete') {
        const template = getRoleTemplateById(config, parts[1]);
        if (!template) throw new Error('Template not found.');
        const confirmId = 'skaw_rt_confirm_delete:' + template.id + ':' + interaction.channelId + ':' + (interaction.message?.id || '0');
        await interaction.reply({ content: 'Delete template **' + template.name + '**? This cannot be undone.', flags: MessageFlags.Ephemeral,
          components: [new ActionRowBuilder().addComponents(
            button(confirmId, 'Confirm Delete', ButtonStyle.Danger),
            button('skaw_rt_cancel_delete', 'Cancel'),
          )] });
        return true;
      }
      if (action === 'skaw_rt_confirm_delete') {
        const template = getRoleTemplateById(config, parts[1]);
        if (!template) throw new Error('Template not found.');
        await deleteRoleTemplate(client, interaction.guildId, template.id);
        await interaction.update({ content: 'Template deleted.', embeds: [], components: [] });
        await editPanelMessage(client, parts[2], parts[3], listPayload(await getRoleTemplateConfig(client, interaction.guildId), 0));
        return true;
      }
      if (action === 'skaw_rt_cancel_delete') {
        await interaction.update({ content: 'Delete cancelled.', embeds: [], components: [] });
        return true;
      }
    }

    if (interaction.isStringSelectMenu?.() && action === 'skaw_rt_template_select') {
      const template = getRoleTemplateById(config, interaction.values?.[0]);
      if (!template) throw new Error('Template not found.');
      await interaction.update(detailPayload(template, interaction.guild));
      return true;
    }

    if (interaction.isRoleSelectMenu?.() && action === 'skaw_rt_roles') {
      const template = getRoleTemplateById(config, parts[1]);
      if (!template) throw new Error('Template not found.');
      await prepareRoleHierarchy(interaction.guild);
      const roleIds = [...new Set((interaction.values || []).map(String))];
      const selectedRoles = roleIds.map(id => interaction.guild.roles.cache.get(id)).filter(Boolean);
      if (selectedRoles.length !== roleIds.length) throw new Error('One or more selected roles no longer exist.');
      const violations = getRoleHierarchyViolations(actor, selectedRoles, interaction.guild.ownerId);
      if (violations.length) throw new Error('Rank protection blocked these roles because they are equal to or above your highest role: ' +
        violations.map(role => role.name).join(', ') + '.');
      const notAssignable = selectedRoles.filter(role => role.id === interaction.guild.id || role.managed || role.editable === false);
      if (notAssignable.length) throw new Error('The bot cannot assign these roles. Check managed roles and ensure the bot role is higher: ' +
        notAssignable.map(role => role.name).join(', ') + '.');
      const result = await setRoleTemplateRoles(client, interaction.guildId, template.id, roleIds, interaction.user.id);
      await interaction.update(detailPayload(result.template, interaction.guild));
      return true;
    }
    
    if (interaction.isModalSubmit?.()) {
      if (action === 'skaw_rt_modal_create') {
        const name = formValue(interaction, 'name');
        const created = await createRoleTemplate(client, interaction.guildId, name, interaction.user.id);
        await interaction.reply({ content: 'Draft created: **' + created.template.name + '**. Configure roles, then enable it.', flags: MessageFlags.Ephemeral });
        await editPanelMessage(client, parts[1], parts[2], listPayload(created.config, 0));
        return true;
      }
      if (action === 'skaw_rt_modal_rename') {
        const template = getRoleTemplateById(config, parts[1]);
        if (!template) throw new Error('Template not found.');
        const updated = await renameRoleTemplate(client, interaction.guildId, template.id, formValue(interaction, 'name'), interaction.user.id);
        await interaction.reply({ content: 'Template renamed to **' + updated.template.name + '**.', flags: MessageFlags.Ephemeral });
        await editPanelMessage(client, parts[2], parts[3], detailPayload(updated.template, interaction.guild));
        return true;
      }
    }
  } catch (error) {
    await respondError(interaction, error);
    return true;
  }

  await respondError(interaction, new Error('This panel action is no longer available. Refresh the panel and try again.'));
  return true;
}
