import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { getGuildConfig } from './config/guildConfig.js';
import { getCommandPrefix } from '../config/bot.js';
import { resolveCommandAlias } from '../config/commands/commandAliases.js';
import {
    canManageAutoResponder,
    deleteAutoResponderTemplate,
    dispatchAutoResponderMessage,
    getAutoResponderConfig,
    getAutoResponderTemplate,
    isAutoResponderTemplateReady,
    setAutoResponderPrefix,
    setAutoResponderTemplateEnabled,
    upsertAutoResponderTemplate,
    buildAutoResponderPayload,
} from './autoResponderService.js';

const BRAND_BLUE = 0x2563EB;
const PAGE_SIZE = 20;

function inputRow(id, label, placeholder, required, style = TextInputStyle.Short, maxLength = 100, value = '') {
    const input = new TextInputBuilder()
        .setCustomId(id)
        .setLabel(label.slice(0, 45))
        .setPlaceholder(placeholder.slice(0, 100))
        .setStyle(style)
        .setRequired(Boolean(required))
        .setMaxLength(maxLength);
    if (typeof value === 'string' && value.length) input.setValue(value.slice(0, maxLength));
    return new ActionRowBuilder().addComponents(input);
}

function button(customId, label, style = ButtonStyle.Secondary, emoji = null, disabled = false) {
    const item = new ButtonBuilder().setCustomId(customId).setLabel(label.slice(0, 80)).setStyle(style).setDisabled(Boolean(disabled));
    if (emoji) item.setEmoji(emoji);
    return item;
}

function listPageCount(config) {
    return Math.max(1, Math.ceil((config.templates || []).length / PAGE_SIZE));
}

function getTemplateDetailUrlParts(interaction) {
    return [interaction.channelId, interaction.message?.id || '0'];
}

function buildDashboardPayload(config) {
    const total = config.templates.length;
    const enabled = config.templates.filter(item => item.enabled && isAutoResponderTemplateReady(item)).length;
    const drafts = config.templates.filter(item => !isAutoResponderTemplateReady(item)).length;
    const embed = new EmbedBuilder()
        .setColor(BRAND_BLUE)
        .setAuthor({ name: 'SKAW GROUP · AUTOMATION' })
        .setTitle('AUTO RESPONDER')
        .setDescription([
            '**AUTOMATED RESPONSE MANAGEMENT**',
            'Create and manage keyword responses and text-command templates across your server.',
            '',
            '**Templates:** ' + total,
            '**Enabled:** ' + enabled,
            '**Draft / needs response setup:** ' + drafts,
            '**Text-command prefix:** ' + config.prefix,
            '',
            'Responses are sent as new messages. Trigger messages are deleted after a response is successfully sent.',
            'The bot needs Manage Messages in channels where trigger messages should be deleted.',
        ].join('\n'))
        .setFooter({ text: 'SKAW GROUP • AUTO RESPONDER' });
    return {
        content: '',
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(
                button('skaw_ar_create', 'Create Template', ButtonStyle.Success, '➕'),
                button('skaw_ar_list:0', 'Template List', ButtonStyle.Primary, '📋'),
                button('skaw_ar_settings', 'Settings', ButtonStyle.Secondary, '⚙️'),
                button('skaw_ar_refresh', 'Refresh', ButtonStyle.Secondary, '🔄'),
            ),
        ],
        allowedMentions: { parse: [] },
    };
}

function buildSettingsPayload(config) {
    const embed = new EmbedBuilder()
        .setColor(BRAND_BLUE)
        .setTitle('AUTO RESPONDER · SETTINGS')
        .setDescription([
            '**Text-command prefix:** ' + config.prefix,
            '**Template count:** ' + config.templates.length,
            '',
            'The prefix applies to all command-type triggers. Keyword triggers do not use a prefix.',
            'Example: with prefix ' + config.prefix + ', a command trigger named pricelist responds to ' + config.prefix + 'pricelist.',
            '',
            'Excluded channels are configured separately for each template.',
        ].join('\n'));
    return {
        content: '',
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(
                button('skaw_ar_settings_prefix', 'Change Prefix', ButtonStyle.Primary, '⌨️'),
                button('skaw_ar_home', 'Dashboard', ButtonStyle.Secondary, '↩️'),
            ),
        ],
        allowedMentions: { parse: [] },
    };
}

function buildListPayload(config, page = 0) {
    const pages = listPageCount(config);
    const selectedPage = Math.max(0, Math.min(pages - 1, Number(page) || 0));
    const start = selectedPage * PAGE_SIZE;
    const items = config.templates.slice(start, start + PAGE_SIZE);
    const embed = new EmbedBuilder()
        .setColor(BRAND_BLUE)
        .setTitle('AUTO RESPONDER · TEMPLATE LIST')
        .setDescription(items.length ? items.map((item, index) => {
            const status = !isAutoResponderTemplateReady(item) ? 'DRAFT' : item.enabled ? 'ENABLED' : 'DISABLED';
            const triggerSummary = item.triggers.slice(0, 4).map(trigger =>
                (trigger.type === 'command' ? config.prefix : '') + trigger.value).join(', ');
            return '**' + (start + index + 1) + '. ' + item.name + '** · ' + status
                + '\nTriggers: ' + (triggerSummary || 'Not configured')
                + (item.triggers.length > 4 ? ' +' + (item.triggers.length - 4) + ' more' : '');
        }).join('\n\n').slice(0, 3900) : 'No templates yet. Select Create Template to add your first response.')
        .setFooter({ text: 'Page ' + (selectedPage + 1) + '/' + pages + ' • ' + config.templates.length + ' templates' });

    const components = [];
    if (items.length) {
        const menu = new StringSelectMenuBuilder()
            .setCustomId('skaw_ar_template_select:' + selectedPage)
            .setPlaceholder('Select a template to view or edit')
            .setMinValues(1).setMaxValues(1)
            .addOptions(items.map(item => ({
                label: item.name.slice(0, 100),
                description: ((item.triggers[0]?.value || 'No trigger') + ' · ' + (!isAutoResponderTemplateReady(item) ? 'Draft' : item.enabled ? 'Enabled' : 'Disabled')).slice(0, 100),
                value: item.id,
            })));
        components.push(new ActionRowBuilder().addComponents(menu));
    }
    components.push(new ActionRowBuilder().addComponents(
        button('skaw_ar_list:' + Math.max(0, selectedPage - 1), 'Previous', ButtonStyle.Secondary, '◀', selectedPage === 0),
        button('skaw_ar_list:' + Math.min(pages - 1, selectedPage + 1), 'Next', ButtonStyle.Secondary, '▶', selectedPage >= pages - 1),
        button('skaw_ar_create', 'Create', ButtonStyle.Success, '➕'),
        button('skaw_ar_home', 'Dashboard', ButtonStyle.Secondary, '↩️'),
    ));
    return { content: '', embeds: [embed], components, allowedMentions: { parse: [] } };
}

function buildTemplateDetailPayload(config, template) {
    if (!template) return buildListPayload(config, 0);
    const triggerLines = template.triggers.map(trigger => '- ' + (trigger.type === 'command' ? config.prefix : '') + trigger.value + ' (' + trigger.type + ')');
    const excluded = template.excludedChannels.length ? template.excludedChannels.map(id => '<#' + id + '>').join(', ') : 'None — all channels allowed';
    const status = !isAutoResponderTemplateReady(template) ? 'DRAFT · response content required' : template.enabled ? 'ENABLED' : 'DISABLED';
    const embed = new EmbedBuilder()
        .setColor(BRAND_BLUE)
        .setTitle('TEMPLATE · ' + template.name)
        .setDescription([
            '**Status:** ' + status,
            '**Matching:** ' + (template.matchMode === 'exact' ? 'Exact Match (case-insensitive)' : 'Contains Match (whole phrase)'),
            '**Response format:** ' + template.responseMode.toUpperCase(),
            '**Cooldown:** ' + (template.cooldownSeconds ? template.cooldownSeconds + ' seconds per member' : 'Off'),
            '',
            '**Triggers**',
            triggerLines.join('\n') || 'None',
            '',
            '**Excluded channels**',
            excluded.slice(0, 1000),
        ].join('\n').slice(0, 3900))
        .setFooter({ text: 'Template ID: ' + template.id });
    return {
        content: '',
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(
                button('skaw_ar_edit:' + template.id, 'Edit Template', ButtonStyle.Primary, '✏️'),
                button('skaw_ar_response:' + template.id, 'Edit Response', ButtonStyle.Primary, '📝'),
                button('skaw_ar_advanced:' + template.id, 'Embed Options', ButtonStyle.Secondary, '🎨'),
                button('skaw_ar_exclusions:' + template.id, 'Excluded Channels', ButtonStyle.Secondary, '🚫'),
                button('skaw_ar_cooldown:' + template.id, 'Cooldown', ButtonStyle.Secondary, '⏱️'),
            ),
            new ActionRowBuilder().addComponents(
                button('skaw_ar_toggle:' + template.id, template.enabled ? 'Disable' : 'Enable', template.enabled ? ButtonStyle.Danger : ButtonStyle.Success, template.enabled ? '⏸️' : '▶️', !template.enabled && !isAutoResponderTemplateReady(template)),
                button('skaw_ar_test:' + template.id, 'Test Response', ButtonStyle.Secondary, '🧪', !isAutoResponderTemplateReady(template)),
                button('skaw_ar_delete:' + template.id, 'Delete', ButtonStyle.Danger, '🗑️'),
                button('skaw_ar_back_list:0', 'Template List', ButtonStyle.Secondary, '↩️'),
                button('skaw_ar_home', 'Dashboard', ButtonStyle.Secondary, '🏠'),
            ),
        ],
        allowedMentions: { parse: [] },
    };
}

function buildCreateModal(channelId, messageId) {
    return new ModalBuilder()
        .setCustomId('skaw_ar_modal_create:' + channelId + ':' + messageId)
        .setTitle('Create Auto Response')
        .addComponents(
            inputRow('name', 'Template Name', 'e.g. Partnership Information', true, TextInputStyle.Short, 80),
            inputRow('keywords', 'Keyword Triggers (comma or new line)', 'partnership, kerjasama', false, TextInputStyle.Paragraph, 800),
            inputRow('commands', 'Text Commands (without prefix)', 'pricelist, homestay', false, TextInputStyle.Paragraph, 800),
            inputRow('matchMode', 'Matching Mode: exact or contains', 'exact', true, TextInputStyle.Short, 10, 'exact'),
            inputRow('responseMode', 'Response Format: text, embed, or both', 'text', true, TextInputStyle.Short, 10, 'text'),
        );
}

function buildEditTemplateModal(template, channelId, messageId) {
    const keywords = template.triggers.filter(item => item.type === 'keyword').map(item => item.value).join('\n');
    const commands = template.triggers.filter(item => item.type === 'command').map(item => item.value).join('\n');
    return new ModalBuilder()
        .setCustomId('skaw_ar_modal_edit:' + template.id + ':' + channelId + ':' + messageId)
        .setTitle('Edit Auto Response')
        .addComponents(
            inputRow('name', 'Template Name', 'Template display name', true, TextInputStyle.Short, 80, template.name),
            inputRow('keywords', 'Keyword Triggers (comma or new line)', 'Keywords without a prefix', false, TextInputStyle.Paragraph, 800, keywords),
            inputRow('commands', 'Text Commands (without prefix)', 'Command names without a prefix', false, TextInputStyle.Paragraph, 800, commands),
            inputRow('matchMode', 'Matching Mode: exact or contains', 'exact', true, TextInputStyle.Short, 10, template.matchMode),
            inputRow('responseMode', 'Response Format: text, embed, or both', 'text', true, TextInputStyle.Short, 10, template.responseMode),
        );
}

function buildResponseModal(template, channelId, messageId) {
    const modal = new ModalBuilder()
        .setCustomId('skaw_ar_modal_response:' + template.id + ':' + channelId + ':' + messageId)
        .setTitle('Edit Response Content');
    if (template.responseMode === 'text' || template.responseMode === 'both') {
        modal.addComponents(inputRow('textResponse', 'Text Response', 'Use {user}, {mention}, {server}, {channel}', true, TextInputStyle.Paragraph, 1800, template.textResponse || ''));
    }
    if (template.responseMode === 'embed' || template.responseMode === 'both') {
        modal.addComponents(
            inputRow('embedTitle', 'Embed Title', 'Optional title', false, TextInputStyle.Short, 256, template.embed?.title || ''),
            inputRow('embedDescription', 'Embed Description', 'Main embed message', true, TextInputStyle.Paragraph, 4000, template.embed?.description || ''),
            inputRow('embedColor', 'Embed Color (hex)', '#2563EB', true, TextInputStyle.Short, 7, template.embed?.color || '#2563EB'),
            inputRow('embedImageUrl', 'Image URL (HTTPS)', 'https://...', false, TextInputStyle.Short, 500, template.embed?.imageUrl || ''),
        );
    }
    return modal;
}

function buildAdvancedEmbedModal(template, channelId, messageId) {
    return new ModalBuilder()
        .setCustomId('skaw_ar_modal_advanced:' + template.id + ':' + channelId + ':' + messageId)
        .setTitle('Advanced Embed Options')
        .addComponents(
            inputRow('thumbnailUrl', 'Thumbnail URL (HTTPS)', 'https://...', false, TextInputStyle.Short, 500, template.embed?.thumbnailUrl || ''),
            inputRow('footer', 'Embed Footer (optional)', 'SKAW GROUP • ...', false, TextInputStyle.Short, 200, template.embed?.footer || ''),
        );
}

function buildPrefixModal(channelId, messageId, prefix) {
    return new ModalBuilder()
        .setCustomId('skaw_ar_modal_prefix:' + channelId + ':' + messageId)
        .setTitle('Change Text Command Prefix')
        .addComponents(inputRow('prefix', 'New Prefix (1–3 characters)', '!', true, TextInputStyle.Short, 3, prefix));
}

function commaOrNewlineList(value) {
    return String(value ?? '').split(/[,\n;]/).map(item => item.trim()).filter(Boolean).slice(0, 50);
}

function getFormValue(interaction, field) {
    try { return interaction.fields.getTextInputValue(field).trim(); } catch { return ''; }
}

async function updatePanelMessage(client, guildId, channelId, messageId, payload) {
    if (!channelId || !messageId || messageId === '0') return false;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || String(channel.guildId) !== String(guildId) || !channel.isTextBased?.()) return false;
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message || String(message.author?.id || '') !== String(client.user?.id || '')) return false;
    await message.edit(payload);
    return true;
}

function parseIdParts(customId, prefix) {
    return String(customId || '').slice(prefix.length).split(':');
}

async function authorized(interaction) {
    if (canManageAutoResponder(interaction.memberPermissions)) return true;
    if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
            content: '❌ Kamu membutuhkan izin **Manage Server** atau **Administrator** untuk mengelola Auto Responder.',
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        }).catch(() => {});
    }
    return false;
}

export async function openAutoResponderPanel(message, client) {
    const config = await getAutoResponderConfig(client, message.guild.id);
    return message.channel.send(buildDashboardPayload(config));
}

export async function handleAutoResponderMessage(message, client) {
    if (!message || message.author?.bot || !message.guild) return false;

    const guildConfig = await getGuildConfig(client, message.guild.id).catch(() => null);
    const managementPrefix = guildConfig?.prefix || getCommandPrefix();
    const trimmed = String(message.content || '').trim();

    if (trimmed.toLocaleLowerCase() === (managementPrefix + 'autoresponder').toLocaleLowerCase()) {
        if (!canManageAutoResponder(message.member?.permissions)) {
            await message.reply({
                content: '❌ Kamu membutuhkan izin **Manage Server** atau **Administrator** untuk membuka Auto Responder Panel.',
                allowedMentions: { repliedUser: false, parse: [] },
            }).catch(() => {});
            return true;
        }
        await openAutoResponderPanel(message, client);
        return true;
    }

    // Existing built-in text commands keep precedence over Auto Responder command triggers.
    if (trimmed.startsWith(managementPrefix)) {
        const rest = trimmed.slice(managementPrefix.length).trim();
        const commandName = rest.split(/\s+/)[0]?.toLowerCase();
        if (commandName && client.commands?.has?.(resolveCommandAlias(commandName))) return false;
    }

    return dispatchAutoResponderMessage(message, client);
}

async function handleButton(interaction) {
    const id = interaction.customId;
    const [templateId = '', channelId = '', messageId = '0', arg = ''] = id.split(':').slice(1);
    if (id === 'skaw_ar_home' || id === 'skaw_ar_refresh') {
        const config = await getAutoResponderConfig(interaction.client, interaction.guildId);
        return interaction.update(buildDashboardPayload(config));
    }
    if (id === 'skaw_ar_create') {
        const [channel, message] = getTemplateDetailUrlParts(interaction);
        return interaction.showModal(buildCreateModal(channel, message));
    }
    if (id.startsWith('skaw_ar_list:')) {
        const page = Number(id.split(':')[1] || 0);
        const config = await getAutoResponderConfig(interaction.client, interaction.guildId);
        return interaction.update(buildListPayload(config, page));
    }
    if (id === 'skaw_ar_settings') {
        const config = await getAutoResponderConfig(interaction.client, interaction.guildId);
        return interaction.update(buildSettingsPayload(config));
    }
    if (id === 'skaw_ar_settings_prefix') {
        const config = await getAutoResponderConfig(interaction.client, interaction.guildId);
        const [channel, message] = getTemplateDetailUrlParts(interaction);
        return interaction.showModal(buildPrefixModal(channel, message, config.prefix));
    }
    if (id.startsWith('skaw_ar_edit:')) {
        const pieces = parseIdParts(id, 'skaw_ar_edit:');
        const template = getAutoResponderTemplate(await getAutoResponderConfig(interaction.client, interaction.guildId), pieces[0]);
        if (!template) return interaction.reply({ content: 'Template tidak ditemukan.', flags: MessageFlags.Ephemeral });
        const [channel, message] = getTemplateDetailUrlParts(interaction);
        return interaction.showModal(buildEditTemplateModal(template, channel, message));
    }
    if (id.startsWith('skaw_ar_response:')) {
        const template = getAutoResponderTemplate(await getAutoResponderConfig(interaction.client, interaction.guildId), templateId);
        if (!template) return interaction.reply({ content: 'Template tidak ditemukan.', flags: MessageFlags.Ephemeral });
        const [channel, message] = getTemplateDetailUrlParts(interaction);
        return interaction.showModal(buildResponseModal(template, channel, message));
    }
    if (id.startsWith('skaw_ar_advanced:')) {
        const template = getAutoResponderTemplate(await getAutoResponderConfig(interaction.client, interaction.guildId), templateId);
        if (!template) return interaction.reply({ content: 'Template tidak ditemukan.', flags: MessageFlags.Ephemeral });
        const [channel, message] = getTemplateDetailUrlParts(interaction);
        return interaction.showModal(buildAdvancedEmbedModal(template, channel, message));
    }
    if (id.startsWith('skaw_ar_exclusions:')) {
        const config = await getAutoResponderConfig(interaction.client, interaction.guildId);
        const template = getAutoResponderTemplate(config, templateId);
        if (!template) return interaction.reply({ content: 'Template tidak ditemukan.', flags: MessageFlags.Ephemeral });
        const channels = new ChannelSelectMenuBuilder()
            .setCustomId('skaw_ar_excluded_pick:' + template.id)
            .setPlaceholder('Select channel(s) to exclude')
            .setMinValues(1).setMaxValues(25)
            .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
        return interaction.update({
            content: 'Select all channels where this template must NOT respond. This selection replaces the current exclusion list.\n\nCurrent exclusions: ' + (template.excludedChannels.map(channel => '<#' + channel + '>').join(', ') || 'None'),
            embeds: [],
            components: [
                new ActionRowBuilder().addComponents(channels),
                new ActionRowBuilder().addComponents(
                    button('skaw_ar_exclusions_clear:' + template.id, 'Clear Exclusions', ButtonStyle.Danger, '🧹'),
                    button('skaw_ar_back_template:' + template.id, 'Back to Template', ButtonStyle.Secondary, '↩️'),
                ),
            ],
            allowedMentions: { parse: [] },
        });
    }
    if (id.startsWith('skaw_ar_exclusions_clear:')) {
        const config = await getAutoResponderConfig(interaction.client, interaction.guildId);
        const template = getAutoResponderTemplate(config, templateId);
        if (!template) return interaction.reply({ content: 'Template tidak ditemukan.', flags: MessageFlags.Ephemeral });
        const result = await upsertAutoResponderTemplate(interaction.client, interaction.guildId, { ...template, excludedChannels: [] }, interaction.user.id);
        return interaction.update(buildTemplateDetailPayload(result.config, result.template));
    }
    if (id.startsWith('skaw_ar_cooldown:')) {
        const template = getAutoResponderTemplate(await getAutoResponderConfig(interaction.client, interaction.guildId), templateId);
        if (!template) return interaction.reply({ content: 'Template tidak ditemukan.', flags: MessageFlags.Ephemeral });
        const menu = new StringSelectMenuBuilder()
            .setCustomId('skaw_ar_cooldown_pick:' + template.id)
            .setPlaceholder('Choose cooldown per member')
            .setMinValues(1).setMaxValues(1)
            .addOptions([
                { label: 'Off', value: '0', default: template.cooldownSeconds === 0 },
                { label: '3 seconds', value: '3', default: template.cooldownSeconds === 3 },
                { label: '5 seconds', value: '5', default: template.cooldownSeconds === 5 },
                { label: '10 seconds', value: '10', default: template.cooldownSeconds === 10 },
                { label: '30 seconds', value: '30', default: template.cooldownSeconds === 30 },
                { label: '60 seconds', value: '60', default: template.cooldownSeconds === 60 },
            ]);
        return interaction.update({
            content: 'Cooldown hanya berlaku untuk anggota yang memicu template ini. Anggota lain tetap dapat memicu respons.',
            embeds: [],
            components: [
                new ActionRowBuilder().addComponents(menu),
                new ActionRowBuilder().addComponents(button('skaw_ar_back_template:' + template.id, 'Back to Template', ButtonStyle.Secondary, '↩️')),
            ],
            allowedMentions: { parse: [] },
        });
    }
    if (id.startsWith('skaw_ar_toggle:')) {
        const config = await getAutoResponderConfig(interaction.client, interaction.guildId);
        const template = getAutoResponderTemplate(config, templateId);
        if (!template) return interaction.reply({ content: 'Template tidak ditemukan.', flags: MessageFlags.Ephemeral });
        const result = await setAutoResponderTemplateEnabled(interaction.client, interaction.guildId, template.id, !template.enabled, interaction.user.id);
        return interaction.update(buildTemplateDetailPayload(result.config, result.template));
    }
    if (id.startsWith('skaw_ar_test:')) {
        const template = getAutoResponderTemplate(await getAutoResponderConfig(interaction.client, interaction.guildId), templateId);
        if (!template || !isAutoResponderTemplateReady(template)) return interaction.reply({ content: 'Lengkapi Response terlebih dahulu sebelum melakukan test.', flags: MessageFlags.Ephemeral });
        return interaction.reply({
            content: '**TEST PREVIEW · ' + template.name + '**',
            ...buildAutoResponderPayload(template, null),
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
    }
    if (id.startsWith('skaw_ar_delete:')) {
        const template = getAutoResponderTemplate(await getAutoResponderConfig(interaction.client, interaction.guildId), templateId);
        if (!template) return interaction.reply({ content: 'Template tidak ditemukan.', flags: MessageFlags.Ephemeral });
        return interaction.update({
            content: 'Are you sure you want to permanently delete **' + template.name + '**? This cannot be undone.',
            embeds: [],
            components: [
                new ActionRowBuilder().addComponents(
                    button('skaw_ar_delete_yes:' + template.id, 'Yes, Delete', ButtonStyle.Danger, '🗑️'),
                    button('skaw_ar_delete_no:' + template.id, 'Cancel', ButtonStyle.Secondary, '↩️'),
                ),
            ],
            allowedMentions: { parse: [] },
        });
    }
    if (id.startsWith('skaw_ar_delete_yes:')) {
        await deleteAutoResponderTemplate(interaction.client, interaction.guildId, templateId, interaction.user.id);
        const config = await getAutoResponderConfig(interaction.client, interaction.guildId);
        return interaction.update(buildListPayload(config, 0));
    }
    if (id.startsWith('skaw_ar_delete_no:') || id.startsWith('skaw_ar_back_template:')) {
        const config = await getAutoResponderConfig(interaction.client, interaction.guildId);
        const template = getAutoResponderTemplate(config, templateId);
        return interaction.update(buildTemplateDetailPayload(config, template));
    }
    if (id.startsWith('skaw_ar_back_list:')) {
        const config = await getAutoResponderConfig(interaction.client, interaction.guildId);
        return interaction.update(buildListPayload(config, Number(arg || 0)));
    }
    return false;
}

async function handleSelectMenu(interaction) {
    const id = interaction.customId;
    if (id.startsWith('skaw_ar_template_select:')) {
        const config = await getAutoResponderConfig(interaction.client, interaction.guildId);
        const template = getAutoResponderTemplate(config, interaction.values[0]);
        return interaction.update(buildTemplateDetailPayload(config, template));
    }
    if (id.startsWith('skaw_ar_excluded_pick:')) {
        const templateId = id.slice('skaw_ar_excluded_pick:'.length);
        const config = await getAutoResponderConfig(interaction.client, interaction.guildId);
        const template = getAutoResponderTemplate(config, templateId);
        if (!template) return interaction.reply({ content: 'Template tidak ditemukan.', flags: MessageFlags.Ephemeral });
        const result = await upsertAutoResponderTemplate(interaction.client, interaction.guildId, {
            ...template,
            excludedChannels: interaction.values,
        }, interaction.user.id);
        return interaction.update(buildTemplateDetailPayload(result.config, result.template));
    }
    if (id.startsWith('skaw_ar_cooldown_pick:')) {
        const templateId = id.slice('skaw_ar_cooldown_pick:'.length);
        const config = await getAutoResponderConfig(interaction.client, interaction.guildId);
        const template = getAutoResponderTemplate(config, templateId);
        if (!template) return interaction.reply({ content: 'Template tidak ditemukan.', flags: MessageFlags.Ephemeral });
        const result = await upsertAutoResponderTemplate(interaction.client, interaction.guildId, {
            ...template,
            cooldownSeconds: Number(interaction.values[0]),
        }, interaction.user.id);
        return interaction.update(buildTemplateDetailPayload(result.config, result.template));
    }
    return false;
}

async function handleModal(interaction) {
    const id = interaction.customId;
    if (id.startsWith('skaw_ar_modal_create:')) {
        const [, channelId, messageId] = parseIdParts(id, 'skaw_ar_modal_create:');
        const name = getFormValue(interaction, 'name');
        const keywords = commaOrNewlineList(getFormValue(interaction, 'keywords'));
        const commands = commaOrNewlineList(getFormValue(interaction, 'commands'));
        const matchMode = getFormValue(interaction, 'matchMode').toLowerCase();
        const responseMode = getFormValue(interaction, 'responseMode').toLowerCase();
        if (!['exact', 'contains'].includes(matchMode)) return interaction.reply({ content: 'Matching Mode harus exact atau contains.', flags: MessageFlags.Ephemeral });
        if (!['text', 'embed', 'both'].includes(responseMode)) return interaction.reply({ content: 'Response Format harus text, embed, atau both.', flags: MessageFlags.Ephemeral });
        const triggers = [
            ...keywords.map(value => ({ type: 'keyword', value })),
            ...commands.map(value => ({ type: 'command', value })),
        ];
        if (!triggers.length) return interaction.reply({ content: 'Tambahkan minimal satu keyword atau text command.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const saved = await upsertAutoResponderTemplate(interaction.client, interaction.guildId, {
            name,
            triggers,
            matchMode,
            responseMode,
            enabled: false,
            cooldownSeconds: 5,
        }, interaction.user.id);
        const config = await getAutoResponderConfig(interaction.client, interaction.guildId);
        await updatePanelMessage(interaction.client, interaction.guildId, channelId, messageId, buildListPayload(config, 0)).catch(() => {});
        return interaction.editReply({
            content: '✅ Template **' + saved.template.name + '** dibuat sebagai draft. Isi response terlebih dahulu, lalu aktifkan template.',
            components: [
                new ActionRowBuilder().addComponents(
                    button('skaw_ar_response:' + saved.template.id, 'Configure Response', ButtonStyle.Primary, '📝'),
                    button('skaw_ar_home', 'Dashboard', ButtonStyle.Secondary, '↩️'),
                ),
            ],
            allowedMentions: { parse: [] },
        });
    }
    if (id.startsWith('skaw_ar_modal_edit:')) {
        const [, templateId, channelId, messageId] = parseIdParts(id, 'skaw_ar_modal_edit:');
        const config = await getAutoResponderConfig(interaction.client, interaction.guildId);
        const existing = getAutoResponderTemplate(config, templateId);
        if (!existing) return interaction.reply({ content: 'Template tidak ditemukan.', flags: MessageFlags.Ephemeral });
        const keywords = commaOrNewlineList(getFormValue(interaction, 'keywords')).map(value => ({ type: 'keyword', value }));
        const commands = commaOrNewlineList(getFormValue(interaction, 'commands')).map(value => ({ type: 'command', value }));
        const matchMode = getFormValue(interaction, 'matchMode').toLowerCase();
        const responseMode = getFormValue(interaction, 'responseMode').toLowerCase();
        if (!['exact', 'contains'].includes(matchMode) || !['text', 'embed', 'both'].includes(responseMode)) {
            return interaction.reply({ content: 'Matching Mode harus exact/contains dan Response Format harus text/embed/both.', flags: MessageFlags.Ephemeral });
        }
        const changes = {
            ...existing,
            name: getFormValue(interaction, 'name'),
            triggers: [...keywords, ...commands],
            matchMode,
            responseMode,
        };
        if (!isAutoResponderTemplateReady({ ...changes, triggers: changes.triggers })) changes.enabled = false;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await upsertAutoResponderTemplate(interaction.client, interaction.guildId, changes, interaction.user.id);
        await updatePanelMessage(interaction.client, interaction.guildId, channelId, messageId, buildTemplateDetailPayload(result.config, result.template)).catch(() => {});
        return interaction.editReply({ content: '✅ Template updated: **' + result.template.name + '**.', allowedMentions: { parse: [] } });
    }
    if (id.startsWith('skaw_ar_modal_response:')) {
        const [, templateId, channelId, messageId] = parseIdParts(id, 'skaw_ar_modal_response:');
        const config = await getAutoResponderConfig(interaction.client, interaction.guildId);
        const existing = getAutoResponderTemplate(config, templateId);
        if (!existing) return interaction.reply({ content: 'Template tidak ditemukan.', flags: MessageFlags.Ephemeral });
        const updated = { ...existing, embed: { ...existing.embed } };
        if (existing.responseMode === 'text' || existing.responseMode === 'both') updated.textResponse = getFormValue(interaction, 'textResponse');
        if (existing.responseMode === 'embed' || existing.responseMode === 'both') {
            updated.embed.title = getFormValue(interaction, 'embedTitle');
            updated.embed.description = getFormValue(interaction, 'embedDescription');
            updated.embed.color = getFormValue(interaction, 'embedColor') || '#2563EB';
            updated.embed.imageUrl = getFormValue(interaction, 'embedImageUrl');
            if (updated.embed.imageUrl && !/^https:\/\//i.test(updated.embed.imageUrl)) return interaction.reply({ content: 'Image URL harus menggunakan HTTPS.', flags: MessageFlags.Ephemeral });
            if (!/^#?[0-9a-f]{6}$/i.test(updated.embed.color)) return interaction.reply({ content: 'Warna Embed harus berupa hex 6 karakter, misalnya #2563EB.', flags: MessageFlags.Ephemeral });
        }
        updated.enabled = false;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await upsertAutoResponderTemplate(interaction.client, interaction.guildId, updated, interaction.user.id);
        await updatePanelMessage(interaction.client, interaction.guildId, channelId, messageId, buildTemplateDetailPayload(result.config, result.template)).catch(() => {});
        return interaction.editReply({
            content: '✅ Response content saved. Review with Test Response, then enable the template when ready.',
            components: [
                new ActionRowBuilder().addComponents(
                    button('skaw_ar_test:' + result.template.id, 'Test Response', ButtonStyle.Primary, '🧪'),
                    button('skaw_ar_toggle:' + result.template.id, 'Enable Template', ButtonStyle.Success, '▶️', !isAutoResponderTemplateReady(result.template)),
                ),
            ],
            allowedMentions: { parse: [] },
        });
    }
    if (id.startsWith('skaw_ar_modal_advanced:')) {
        const [, templateId, channelId, messageId] = parseIdParts(id, 'skaw_ar_modal_advanced:');
        const config = await getAutoResponderConfig(interaction.client, interaction.guildId);
        const existing = getAutoResponderTemplate(config, templateId);
        if (!existing) return interaction.reply({ content: 'Template tidak ditemukan.', flags: MessageFlags.Ephemeral });
        const thumbnailUrl = getFormValue(interaction, 'thumbnailUrl');
        if (thumbnailUrl && !/^https:\/\//i.test(thumbnailUrl)) return interaction.reply({ content: 'Thumbnail URL harus menggunakan HTTPS.', flags: MessageFlags.Ephemeral });
        const updated = {
            ...existing,
            embed: {
                ...existing.embed,
                thumbnailUrl,
                footer: getFormValue(interaction, 'footer'),
            },
        };
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await upsertAutoResponderTemplate(interaction.client, interaction.guildId, updated, interaction.user.id);
        await updatePanelMessage(interaction.client, interaction.guildId, channelId, messageId, buildTemplateDetailPayload(result.config, result.template)).catch(() => {});
        return interaction.editReply({ content: '✅ Advanced Embed options saved.', allowedMentions: { parse: [] } });
    }
    if (id.startsWith('skaw_ar_modal_prefix:')) {
        const [, channelId, messageId] = parseIdParts(id, 'skaw_ar_modal_prefix:');
        const prefix = getFormValue(interaction, 'prefix');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const config = await setAutoResponderPrefix(interaction.client, interaction.guildId, prefix, interaction.user.id);
        await updatePanelMessage(interaction.client, interaction.guildId, channelId, messageId, buildSettingsPayload(config)).catch(() => {});
        return interaction.editReply({ content: '✅ Text-command prefix updated to **' + config.prefix + '**.', allowedMentions: { parse: [] } });
    }
    return false;
}

export async function handleAutoResponderInteraction(interaction) {
    if (!interaction.inGuild?.() || !String(interaction.customId || '').startsWith('skaw_ar_')) return false;
    if (!await authorized(interaction)) return true;
    try {
        if (interaction.isButton?.()) {
            await handleButton(interaction);
            return true;
        }
        if (interaction.isStringSelectMenu?.() || interaction.isChannelSelectMenu?.()) {
            await handleSelectMenu(interaction);
            return true;
        }
        if (interaction.isModalSubmit?.()) {
            await handleModal(interaction);
            return true;
        }
        return false;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[Auto Responder] Interaction failed:', error?.stack || error);
        const payload = { content: '❌ Auto Responder: ' + message.slice(0, 1500), embeds: [], components: [], allowedMentions: { parse: [] } };
        if (interaction.deferred && !interaction.replied) await interaction.editReply(payload).catch(() => {});
        else if (interaction.replied) await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
        else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
        return true;
    }
}
