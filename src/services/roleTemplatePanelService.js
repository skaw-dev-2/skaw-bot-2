// Role Template panel and prefix-command handlers for SKAW GROUP.

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
  ModalBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { getCommandPrefix } from '../config/bot.js';
import {
  canManageRoleTemplates, createRoleTemplate, deleteRoleTemplate, getRoleTemplateById,
  getRoleTemplateConfig, renameRoleTemplate, setRoleTemplateEnabled, setRoleTemplateRoles,
} from './roleTemplateService.js';

const BLUE = 0x2563EB;
const PAGE_SIZE = 20;
function button(id, label, style = ButtonStyle.Secondary, disabled = false) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(Boolean(disabled));
}
function inputRow(id, label, placeholder, required, value = '') {
  const input = new TextInputBuilder().setCustomId(id).setLabel(label.slice(0, 45))
    .setPlaceholder(placeholder.slice(0, 100)).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(80);
  if (value) input.setValue(value.slice(0, 80));
  return new ActionRowBuilder().addComponents(input);
}
function formValue(interaction, id) { try { return interaction.fields.getTextInputValue(id).trim(); } catch { return ''; } }
function pageCount(config) { return Math.max(1, Math.ceil(config.templates.length / PAGE_SIZE)); }
function detailParts(interaction) { return [interaction.channelId, interaction.message?.id || '0']; }
function parseId(customId, prefix) { return String(customId || '').slice(prefix.length).split(':'); }

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
      'Role assignment only adds missing roles. Existing member roles are never removed.',
      'Access: Administrator or Manage Server.',
    ].join('\\n')).setFooter({ text: 'SKAW GROUP • ROLE TEMPLATE SYSTEM V1' });
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
      '\\nKey: ' + t.slug + ' · Roles: ' + t.roleIds.length
    ).join('\\n\\n').slice(0, 3900) : 'No templates created yet.')
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
