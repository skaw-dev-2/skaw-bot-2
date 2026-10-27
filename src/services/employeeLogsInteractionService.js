import { randomUUID } from 'node:crypto';
import {
    ActionRowBuilder,
    ChannelType,
    ChannelSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    PermissionFlagsBits,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
    UserSelectMenuBuilder,
} from 'discord.js';
import {
    EMPLOYEE_LOG_TYPES,
    EMPLOYEE_LOG_BANNER_EVENTS,
    buildEmployeeLogEmbed,
    getEmployeeLogsConfig,
    resolveEmployeeLogsBanner,
    sendEmployeeLog,
    createEmployeeLogRecordId,
    getEmployeeLogRecord,
    updateEmployeeLogRecord,
    setEmployeeLogsChannel,
    setEmployeeLogsBanner,
    clearEmployeeLogsBanner,
    setEmployeeLogsEventBanner,
    clearEmployeeLogsEventBanner,
    getEmployeeAutoRoleConfig,
    setEmployeeAutoRoleEnabled,
    getEmployeeLogAudit,
} from './employeeLogsService.js';
import {
    BASE_EMPLOYEE_ROLE,
    getEmployeeRoleRegistry,
    registerEmployeeRole,
    disableEmployeeRole,
    getEmployeeExitReview,
    listEmployeeExitReviews,
    claimEmployeeExitReview,
    releaseEmployeeExitReview,
    completeEmployeeExitReview,
} from './employeeRoleRegistryService.js';
import { SKAW_EMPLOYEE_ROLE_CATALOG } from './employeeLogsAutoRoleService.js';
import { formatDirectoryTimestamp, searchEmployeeDirectory, getEmployeeDirectoryIndex } from './employeeDirectoryService.js';

const SESSION_TTL_MS = 15 * 60 * 1000;
const sessions = new Map();
async function acknowledgeComponentUpdate(interaction) {
    await interaction.deferUpdate();
}

function hasManageGuild(interaction) {
    return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
        || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}
function canCreate(interaction) {
    return Boolean(interaction.inGuild?.() && hasManageGuild(interaction));
}
function sessionKey(guildId, userId) { return `${guildId}:${userId}`; }
function createSession(interaction, type) {
    const id = randomUUID().replaceAll('-', '').slice(0, 14);
    const session = { id, guildId: interaction.guildId, userId: interaction.user.id, type, stepIndex: 0, data: {}, updatedAt: Date.now() };
    sessions.set(sessionKey(session.guildId, session.userId), session);
    if (sessions.size > 1500) {
        for (const [key, item] of sessions) if (Date.now() - item.updatedAt > SESSION_TTL_MS) sessions.delete(key);
    }
    return session;
}
function getSession(interaction, id) {
    const key = sessionKey(interaction.guildId, interaction.user.id);
    const session = sessions.get(key);
    if (!session || session.id !== id || Date.now() - session.updatedAt > SESSION_TTL_MS) {
        if (session) sessions.delete(key);
        return null;
    }
    session.updatedAt = Date.now();
    return session;
}
function roleFieldLabel(field) {
    return ({ position: 'Position / jabatan', previousRank: 'Previous Rank', newRank: 'New Rank', fromRole: 'Previous Position', toRole: 'New Position' })[field] || 'Position';
}
function userSelectRow(session) {
    return new ActionRowBuilder().addComponents(new UserSelectMenuBuilder()
        .setCustomId(`skaw_el_user:${session.id}`)
        .setPlaceholder('Select employee / pilih anggota')
        .setMinValues(1).setMaxValues(1));
}
function roleSelectRow(session) {
    const field = EMPLOYEE_LOG_TYPES[session.type].roleFields[session.stepIndex];
    return new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder()
        .setCustomId(`skaw_el_role:${session.id}`)
        .setPlaceholder(`Select ${roleFieldLabel(field)}`.slice(0, 150))
        .setMinValues(1).setMaxValues(1));
}
function backToPanelRow(sessionId) {
    return new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(`skaw_el_back:${sessionId}`)
        .setLabel('Cancel / Back to Activities')
        .setEmoji('↩️')
        .setStyle(ButtonStyle.Secondary));
}
function textInput(id, label, placeholder, required, style = TextInputStyle.Short, maxLength = 900, value = null) {
    const input = new TextInputBuilder()
        .setCustomId(id).setLabel(label.slice(0, 45)).setPlaceholder(placeholder.slice(0, 100))
        .setStyle(style).setRequired(required).setMaxLength(maxLength);
    if (typeof value === 'string' && value.length) input.setValue(value.slice(0, maxLength));
    return new ActionRowBuilder().addComponents(input);
}
function buildModal(session) {
    const template = EMPLOYEE_LOG_TYPES[session.type];
    const modal = new ModalBuilder().setCustomId(`skaw_el_form:${session.id}`).setTitle(`${template.shortLabel} • Record Details`.slice(0, 45));
    if (session.type === 'dismissal' || session.type === 'blacklist' || session.type === 'resignation' || session.type === 'demote') {
        const reasonLabel = session.type === 'resignation' ? 'Resignation Reason (required)' : session.type === 'demote' ? 'Demotion Reason (required)' : session.type === 'dismissal' ? 'Dismissal Reason (required)' : 'Blacklist Reason (required)';
        modal.addComponents(
            textInput('reason', reasonLabel, 'Explain the reason for this record.', true, TextInputStyle.Paragraph, 850, session.data.reason),
            textInput('notes', 'Additional Notes (optional)', 'Optional supporting details.', false, TextInputStyle.Paragraph, 850, session.data.notes),
        );
    } else if (session.type === 'warning') {
        modal.addComponents(
            textInput('warn', 'Warning Level (e.g. 1/2)', '1/2', true, TextInputStyle.Short, 10, session.data.warn || '1/2'),
            textInput('reason', 'Reason / Observation', 'Explain the warning clearly.', true, TextInputStyle.Paragraph, 750, session.data.reason),
            textInput('notes', 'Additional Notes (optional)', 'Optional supporting details.', false, TextInputStyle.Paragraph, 600, session.data.notes),
        );
    } else if (session.type === 'others') {
        modal.addComponents(
            textInput('activityTitle', 'Activity Title', 'Name this new log type.', true, TextInputStyle.Short, 80, session.data.activityTitle),
            textInput('activityDescription', 'Activity Details', 'Describe the activity.', true, TextInputStyle.Paragraph, 700, session.data.activityDescription),
            textInput('notes', 'Additional Notes (optional)', 'Optional supporting details.', false, TextInputStyle.Paragraph, 600, session.data.notes),
        );
    } else {
        modal.addComponents(textInput('notes', 'Additional Notes (optional)', 'Optional supporting details.', false, TextInputStyle.Paragraph, 900, session.data.notes));
    }
    return modal;
}
function previewButtons(sessionId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`skaw_el_edit:${sessionId}`).setLabel('Edit Details').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`skaw_el_confirm:${sessionId}`).setLabel('Confirm & Send').setEmoji('✅').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`skaw_el_cancel:${sessionId}`).setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Secondary),
    );
}

function buildPublishedRecordEditModal(record) {
    return new ModalBuilder()
        .setCustomId(`skaw_el_edit_record_modal:${record.recordId}`)
        .setTitle('Edit Employee Log')
        .addComponents(
            textInput('editReason', 'Reason (optional)', 'Add or update the reason.', false, TextInputStyle.Paragraph, 900, record.data?.reason || ''),
            textInput('editNotes', 'Additional Notes (optional)', 'Add or update additional notes.', false, TextInputStyle.Paragraph, 900, record.data?.notes || ''),
        );
}

async function handlePublishedRecordEditButton(interaction) {
    const recordId = interaction.customId.slice('skaw_el_edit_record:'.length);
    const record = await getEmployeeLogRecord(interaction.client, interaction.guildId, recordId);
    if (!record) return sendPrivate(interaction, 'This record is no longer available to edit.');
    if (String(record.guildId) !== String(interaction.guildId)) return sendPrivate(interaction, 'This record is not available in this server.');
    if (String(interaction.message?.id || '') !== String(record.messageId)
        || String(interaction.message?.author?.id || '') !== String(interaction.client.user?.id || '')) {
        return sendPrivate(interaction, 'This Edit button is not linked to the original Employee Log message.');
    }
    return interaction.showModal(buildPublishedRecordEditModal(record));
}

async function handlePublishedRecordEditModal(interaction) {
    const recordId = interaction.customId.slice('skaw_el_edit_record_modal:'.length);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reason = interaction.fields.getTextInputValue('editReason').trim();
    const notes = interaction.fields.getTextInputValue('editNotes').trim();
    await updateEmployeeLogRecord(interaction.client, interaction.guildId, recordId, { reason, notes }, interaction.user.id);
    return interaction.editReply({ content: 'Employee log updated.', allowedMentions: { parse: [] } });
}
async function sendPrivate(interaction, content) {
    const payload = { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
    if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
    return interaction.reply(payload);
}
async function validateSessionConfig(interaction, type, config) {
    const channelId = config.channels[type];
    if (!channelId) throw new Error(`Channel for **${EMPLOYEE_LOG_TYPES[type].shortLabel}** is not configured. Ask an administrator to run /epl set-channel.`);
    const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased?.() || channel.isDMBased?.() || channel.guildId !== interaction.guildId) {
        throw new Error(`The configured destination for **${EMPLOYEE_LOG_TYPES[type].shortLabel}** is unavailable. Set its channel again with /epl set-channel.`);
    }
    const botMember = interaction.guild?.members?.me || await interaction.guild?.members?.fetchMe?.().catch(() => null);
    const channelPermissions = channel.permissionsFor(botMember || interaction.client.user);
    const required = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks | PermissionFlagsBits.ReadMessageHistory;
    if (!channelPermissions?.has(required)) {
        throw new Error(`The bot needs View Channel, Send Messages, Embed Links, and Read Message History in ${channel}.`);
    }
}
async function showPreview(interaction, session) {
    const config = await getEmployeeLogsConfig(interaction.client, interaction.guildId);
    await validateSessionConfig(interaction, session.type, config);
    session.data.recordedBy = interaction.user.id;
    if (!session.data.recordId) session.data.recordId = createEmployeeLogRecordId(new Date());
    if (!session.data.recordedAt) session.data.recordedAt = new Date().toISOString();
    const embed = buildEmployeeLogEmbed(session.type, session.data, resolveEmployeeLogsBanner(config, session.type));
    return interaction.editReply({
        content: `**PRIVATE PREVIEW · ${EMPLOYEE_LOG_TYPES[session.type].shortLabel}**\nDestination: <#${config.channels[session.type]}>\nReview carefully before publishing.`,
        embeds: [embed],
        components: [previewButtons(session.id)],
        allowedMentions: { parse: [] },
    });
}
async function handleStart(interaction) {
    if (!interaction.inGuild?.()) return sendPrivate(interaction, 'Employee Logs can only be used in a server.');
    // Replace the current private panel instead of creating a trail of ephemeral messages.
    await acknowledgeComponentUpdate(interaction);
    const config = await getEmployeeLogsConfig(interaction.client, interaction.guildId);
    if (!canCreate(interaction)) return interaction.editReply({ content: '❌ You need the **Manage Server** permission to use Employee Logs.', embeds: [], components: [], allowedMentions: { parse: [] } });
    const type = interaction.customId.slice('skaw_el_start:'.length);
    if (!Object.hasOwn(EMPLOYEE_LOG_TYPES, type)) return interaction.editReply({ content: '❌ Unknown activity type.', embeds: [], components: [], allowedMentions: { parse: [] } });
    await validateSessionConfig(interaction, type, config);
    const session = createSession(interaction, type);
    return interaction.editReply({
        content: `**${EMPLOYEE_LOG_TYPES[type].emoji} ${EMPLOYEE_LOG_TYPES[type].shortLabel}**\nStep 1: select the employee. This private session expires in 15 minutes.`,
        embeds: [], components: [userSelectRow(session), backToPanelRow(session.id)], allowedMentions: { parse: [] },
    });
}

async function handleUserSelect(interaction) {
    await acknowledgeComponentUpdate(interaction);
    const sessionId = interaction.customId.slice('skaw_el_user:'.length);
    const session = getSession(interaction, sessionId);
    if (!session) return interaction.editReply({ content: '⌛ Form expired. Open `/epl panel` and start again.', embeds: [], components: [], allowedMentions: { parse: [] } });
    const memberId = interaction.values[0];
    const member = await interaction.guild.members.fetch(memberId).catch(() => null);
    if (!member) return interaction.editReply({ content: '❌ Employee could not be found in this server.', embeds: [], components: [], allowedMentions: { parse: [] } });
    session.data.userId = member.id;
    session.data.displayName = member.displayName;
    session.stepIndex = 0;
    const roleFields = EMPLOYEE_LOG_TYPES[session.type].roleFields;
    return interaction.editReply({
        content: `**${EMPLOYEE_LOG_TYPES[session.type].shortLabel}**\nEmployee: ${member.displayName} (<@${member.id}>)\nStep 2 of ${roleFields.length + 2}: select **${roleFieldLabel(roleFields[0])}**.`,
        embeds: [], components: [roleSelectRow(session), backToPanelRow(session.id)], allowedMentions: { parse: [] },
    });
}

async function handleRoleSelect(interaction) {
    const sessionId = interaction.customId.slice('skaw_el_role:'.length);
    const session = getSession(interaction, sessionId);
    if (!session) return sendPrivate(interaction, '⌛ Form expired. Open `/epl panel` and start again.');
    const fields = EMPLOYEE_LOG_TYPES[session.type].roleFields;
    const field = fields[session.stepIndex];
    const roleId = interaction.values[0];
    if (!roleId || roleId === interaction.guildId) return sendPrivate(interaction, '❌ Choose a valid position role.');
    session.data[field] = roleId;
    session.stepIndex += 1;
    if (session.stepIndex < fields.length) {
        const nextField = fields[session.stepIndex];
        return interaction.update({
            content: `**${EMPLOYEE_LOG_TYPES[session.type].shortLabel}**\nEmployee: ${session.data.displayName || 'Unknown member'} (<@${session.data.userId}>)\nSelected: ${session.stepIndex}/${fields.length} roles\nNext: choose **${roleFieldLabel(nextField)}**.`,
            components: [roleSelectRow(session), backToPanelRow(session.id)], allowedMentions: { parse: [] },
        });
    }
    return interaction.showModal(buildModal(session));
}

async function handleModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sessionId = interaction.customId.slice('skaw_el_form:'.length);
    const session = getSession(interaction, sessionId);
    if (!session) return interaction.editReply({ content: '⌛ Form expired. Open `/epl panel` and start again.', allowedMentions: { parse: [] } });
    const get = id => interaction.fields.getTextInputValue(id).trim();
    if (session.type === 'dismissal' || session.type === 'blacklist' || session.type === 'resignation' || session.type === 'demote') session.data.reason = get('reason');
    if (session.type === 'warning') { session.data.warn = get('warn'); session.data.reason = get('reason'); }
    if (session.type === 'others') { session.data.activityTitle = get('activityTitle'); session.data.activityDescription = get('activityDescription'); }
    session.data.notes = get('notes');
    session.data.recordedBy = interaction.user.id;
    return showPreview(interaction, session);
}

async function handleEdit(interaction) {
    const sessionId = interaction.customId.slice('skaw_el_edit:'.length);
    const session = getSession(interaction, sessionId);
    if (!session) return sendPrivate(interaction, '⌛ Form expired. Open `/epl panel` and start again.');
    if (session.status === 'submitting') return sendPrivate(interaction, '⏳ This record is already being processed. Please wait.');
    return interaction.showModal(buildModal(session));
}

async function handleConfirm(interaction) {
    const sessionId = interaction.customId.slice('skaw_el_confirm:'.length);
    const session = getSession(interaction, sessionId);
    if (session?.status === 'submitting') {
        await acknowledgeComponentUpdate(interaction);
        return sendPrivate(interaction, '⏳ This record is already being processed. Please wait.');
    }
    if (session) session.status = 'submitting';
    await acknowledgeComponentUpdate(interaction);
    if (!session) return interaction.editReply({ content: '⌛ Form expired. Open `/epl panel` and start again.', embeds: [], components: [], allowedMentions: { parse: [] } });
    try {
        const config = await getEmployeeLogsConfig(interaction.client, interaction.guildId);
        await validateSessionConfig(interaction, session.type, config);
        session.data.recordedBy = interaction.user.id;
        const result = await sendEmployeeLog(interaction.client, interaction.guild, session.type, session.data);
        sessions.delete(sessionKey(session.guildId, session.userId));
        const stickerNote = result.stickerWarning ? `\n⚠️ ${result.stickerWarning}` : (result.stickerSent ? '\n✨ Sticker successfully sent.' : '');
        return interaction.editReply({ content: `✅ **${result.template.shortLabel} published successfully** to ${result.channel}.\nRecord ID: \`${result.recordId}\`${stickerNote}`, embeds: [], components: [], allowedMentions: { parse: [] } });
    } catch (error) {
        session.status = 'ready';
        throw error;
    }
}

async function handleBackToPanel(interaction) {
    const sessionId = interaction.customId.slice('skaw_el_back:'.length);
    const session = getSession(interaction, sessionId);
    if (session?.status === 'submitting') {
        await acknowledgeComponentUpdate(interaction);
        return sendPrivate(interaction, '⏳ This record is already being processed. Please wait.');
    }
    await acknowledgeComponentUpdate(interaction);
    if (session) sessions.delete(sessionKey(session.guildId, session.userId));
    const config = await getEmployeeLogsConfig(interaction.client, interaction.guildId);
    return interaction.editReply({ content: 'Session cancelled. Choose another activity or close this private panel.', ...buildEmployeeLogsActivitiesPanel(config), allowedMentions: { parse: [] } });
}

async function handleCancel(interaction) {
    const sessionId = interaction.customId.slice('skaw_el_cancel:'.length);
    const session = getSession(interaction, sessionId);
    if (session?.status === 'submitting') {
        await acknowledgeComponentUpdate(interaction);
        return sendPrivate(interaction, '⏳ This record is already being processed and cannot be cancelled now.');
    }
    await acknowledgeComponentUpdate(interaction);
    if (session) sessions.delete(sessionKey(session.guildId, session.userId));
    return interaction.editReply({ content: '🗑️ Record cancelled. Nothing was published.', embeds: [], components: [], allowedMentions: { parse: [] } });
}


const registrySessions = new Map();

function buildSettingsPanel(config, autoConfig) {
    const configuredCount = Object.keys(EMPLOYEE_LOG_TYPES).filter(type => config.channels?.[type]).length;
    const autoTypes = ['sign_in', 'sign_out', 'promotion', 'demote', 'mutation', 'warning', 'blacklist'];
    const missing = autoTypes.filter(type => !config.channels?.[type]).map(type => EMPLOYEE_LOG_TYPES[type].shortLabel);
    const embed = new EmbedBuilder()
        .setColor(0x2563eb)
        .setTitle('EMPLOYEE LOGS · SYSTEM SETTINGS')
        .setDescription([
            'Channel routing: ' + configuredCount + '/' + Object.keys(EMPLOYEE_LOG_TYPES).length + ' activity channels configured.',
            'Automatic Employee Logs: ' + (autoConfig.enabled ? 'Enabled' : 'Disabled'),
            'Default banner: ' + (config.bannerUrl ? 'Configured' : 'Not configured'),
            '',
            missing.length ? 'Auto Logs still needs channels: ' + missing.join(', ') : 'Auto Logs channels: Ready',
            '',
            'Use the controls below to update routing, banners, and automation. Changes are saved per server.',
        ].join('\\n'))
        .setFooter({ text: 'Settings changes are saved immediately' });
    const autoButton = new ButtonBuilder()
        .setCustomId('skaw_el_autorole:' + (autoConfig.enabled ? 'disable' : 'enable'))
        .setLabel(autoConfig.enabled ? 'Disable Auto Logs' : 'Enable Auto Logs')
        .setEmoji(autoConfig.enabled ? '⏸️' : '▶️')
        .setStyle(autoConfig.enabled ? ButtonStyle.Danger : ButtonStyle.Success);
    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('skaw_el_settings:channels').setLabel('Channel Routing').setEmoji('📣').setStyle(ButtonStyle.Primary),
                autoButton,
                new ButtonBuilder().setCustomId('skaw_el_settings:banner').setLabel('Set Default Banner').setEmoji('🖼️').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('skaw_el_settings:clear-banner').setLabel('Clear Banner').setStyle(ButtonStyle.Secondary),
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('skaw_el_settings:event-banner').setLabel('Set Event Banner').setEmoji('🎨').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('skaw_el_settings:clear-event-banner').setLabel('Clear Event Banner').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('skaw_el_dashboard:home').setLabel('Dashboard').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
            ),
        ],
        allowedMentions: { parse: [] },
    };
}

function buildChannelTypePicker() {
    const menu = new StringSelectMenuBuilder()
        .setCustomId('skaw_el_channel_type')
        .setPlaceholder('Choose which activity channel to configure')
        .setMinValues(1).setMaxValues(1)
        .addOptions(Object.entries(EMPLOYEE_LOG_TYPES).map(([type, entry]) => ({
            label: entry.shortLabel,
            description: 'Destination for ' + entry.label,
            value: type,
            emoji: entry.emoji,
        })));
    return {
        embeds: [new EmbedBuilder().setColor(0x2563eb).setTitle('CHANNEL ROUTING').setDescription('Choose an activity type, then select a text or announcement channel.')],
        components: [
            new ActionRowBuilder().addComponents(menu),
            new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('skaw_el_dashboard:settings').setLabel('Back to Settings').setStyle(ButtonStyle.Secondary)),
        ],
        allowedMentions: { parse: [] },
    };
}

function buildEventBannerPicker(clear = false) {
    const menu = new StringSelectMenuBuilder()
        .setCustomId(clear ? 'skaw_el_clear_event_banner_pick' : 'skaw_el_event_banner_pick')
        .setPlaceholder(clear ? 'Choose which event banner to clear' : 'Choose which event banner to set')
        .setMinValues(1).setMaxValues(1)
        .addOptions(Object.entries(EMPLOYEE_LOG_BANNER_EVENTS).map(([key, entry]) => ({
            label: entry.label.slice(0, 100),
            description: clear ? 'Remove this custom event banner' : 'Set a custom banner for this event',
            value: key,
        })));
    return {
        embeds: [new EmbedBuilder().setColor(0x2563eb).setTitle(clear ? 'CLEAR EVENT BANNER' : 'CONFIGURE EVENT BANNER').setDescription('Select the employee activity or event.')],
        components: [
            new ActionRowBuilder().addComponents(menu),
            new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('skaw_el_dashboard:settings').setLabel('Back to Settings').setStyle(ButtonStyle.Secondary)),
        ],
        allowedMentions: { parse: [] },
    };
}

function buildRoleRegistryPanelPayload(registry) {
    const active = registry.roles.filter(role => role.active);
    const inactive = registry.roles.filter(role => !role.active);
    const lines = [
        '**Base Employee Role:** <@&' + BASE_EMPLOYEE_ROLE.id + '> (' + BASE_EMPLOYEE_ROLE.id + ')',
        '**Built-in mappings:** ' + Object.keys(SKAW_EMPLOYEE_ROLE_CATALOG).length,
        '**Custom mappings:** ' + active.length + ' active · ' + inactive.length + ' inactive',
        '',
    ];
    const shown = registry.roles.slice(0, 16);
    if (shown.length) {
        for (const role of shown) {
            let details = role.category.charAt(0).toUpperCase() + role.category.slice(1);
            if (role.department) details += ' · ' + role.department;
            if (role.level != null) details += ' · Level ' + role.level;
            if (role.warn) details += ' · ' + role.warn;
            lines.push((role.active ? '🟢' : '⚪') + ' <@&' + role.id + '> — ' + details + (role.active ? '' : ' (inactive)'));
        }
        if (registry.roles.length > shown.length) lines.push('…and ' + (registry.roles.length - shown.length) + ' more.');
    } else {
        lines.push('No custom role mappings registered yet. Built-in mappings remain available.');
    }
    return {
        embeds: [new EmbedBuilder().setColor(0x2563eb).setTitle('EMPLOYEE ROLE REGISTRY').setDescription(lines.join('\\n').slice(0, 3900))
            .setFooter({ text: 'Deactivate mappings instead of deleting them so existing records remain intact.' })],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('skaw_el_registry:add').setLabel('Register Role').setEmoji('➕').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('skaw_el_registry:edit').setLabel('Edit Mapping').setEmoji('✏️').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('skaw_el_registry:disable').setLabel('Deactivate Role').setEmoji('⏸️').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('skaw_el_dashboard:home').setLabel('Dashboard').setStyle(ButtonStyle.Secondary),
            ),
        ],
        allowedMentions: { parse: [] },
    };
}

function buildRegistryMappingPicker(registry, mode) {
    const options = registry.roles
        .filter(role => mode !== 'disable' || role.active)
        .slice(0, 25)
        .map(role => ({
            label: role.name.slice(0, 100),
            description: (role.active ? 'Active' : 'Inactive') + ' · ' + role.category + (role.department ? ' · ' + role.department : ''),
            value: role.id,
        }));
    if (!options.length) {
        return {
            content: mode === 'disable' ? 'There are no active custom role mappings to deactivate.' : 'Register a custom role first.',
            embeds: [],
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('skaw_el_dashboard:roles').setLabel('Back to Role Registry').setStyle(ButtonStyle.Secondary))],
            allowedMentions: { parse: [] },
        };
    }
    const menu = new StringSelectMenuBuilder()
        .setCustomId(mode === 'disable' ? 'skaw_el_registry_disable_pick' : 'skaw_el_registry_edit_pick')
        .setPlaceholder(mode === 'disable' ? 'Choose a role to deactivate' : 'Choose a role mapping to edit')
        .setMinValues(1).setMaxValues(1).addOptions(options);
    return {
        embeds: [new EmbedBuilder().setColor(0x2563eb).setTitle(mode === 'disable' ? 'DEACTIVATE ROLE MAPPING' : 'EDIT ROLE MAPPING').setDescription('Select a custom role mapping.')],
        components: [
            new ActionRowBuilder().addComponents(menu),
            new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('skaw_el_dashboard:roles').setLabel('Back to Registry').setStyle(ButtonStyle.Secondary)),
        ],
        allowedMentions: { parse: [] },
    };
}

function roleCategoryOptions(currentCategory = null) {
    const categories = [
        { label: 'Jabatan / Rank', value: 'rank', description: 'Rank in a division; level drives promotion/demotion.' },
        { label: 'Divisi', value: 'division', description: 'Division marker, not a rank by itself.' },
        { label: 'Warning', value: 'warning', description: 'Adds a warning log when assigned.' },
        { label: 'Blacklist', value: 'blacklist', description: 'Adds a blacklist log when assigned.' },
        { label: 'Retired / Former', value: 'retired', description: 'Non-active former employee marker.' },
        { label: 'Civilian / Non-employee', value: 'civilian', description: 'Non-active employee marker.' },
        { label: 'Other / Ignored', value: 'other', description: 'Registered for reference, no automatic classification.' },
    ];
    return new StringSelectMenuBuilder()
        .setCustomId('skaw_el_registry_category')
        .setPlaceholder('Choose the role category')
        .setMinValues(1).setMaxValues(1)
        .addOptions(categories.map(item => ({ ...item, default: item.value === currentCategory })));
}

function buildRegistryForm(category, session) {
    const modal = new ModalBuilder()
        .setCustomId('skaw_el_registry_form:' + category)
        .setTitle(('Register ' + category + ' mapping').slice(0, 45));
    const addInput = (id, label, placeholder, required, maxLength, value = '') => {
        const input = new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder)
            .setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(maxLength);
        if (String(value || '').length) input.setValue(String(value).slice(0, maxLength));
        modal.addComponents(new ActionRowBuilder().addComponents(input));
    };
    if (category === 'rank' || category === 'division') {
        addInput('department', 'Department key', 'e.g. mechanic, modshop, builder', true, 50, session.existing?.department || '');
    }
    if (category === 'rank') {
        addInput('level', 'Rank level (1–100)', 'Use higher numbers for higher ranks', true, 3, session.existing?.level == null ? '' : String(session.existing.level));
    }
    if (category === 'warning') {
        addInput('warn', 'Warning level (e.g. 1/2)', '1/2', true, 10, session.existing?.warn || '');
    }
    addInput('note', 'Internal note (optional)', 'Optional admin reference; not shown in public logs', false, 100, session.existing?.note || '');
    return modal;
}

function buildExitReviewList(reviews) {
    const embed = new EmbedBuilder()
        .setColor(0xd97706)
        .setTitle('PENDING EMPLOYEE EXIT REVIEWS')
        .setDescription(reviews.length
            ? 'These members lost the Company Staff role. Management must classify the exit before a final employee log is published.'
            : 'No pending employee exits need review.')
        .setFooter({ text: 'One membership exit produces one final classification.' });
    const components = [];
    if (reviews.length) {
        const menu = new StringSelectMenuBuilder()
            .setCustomId('skaw_el_exit_review_pick')
            .setPlaceholder('Choose an employee exit to review')
            .setMinValues(1).setMaxValues(1)
            .addOptions(reviews.slice(0, 25).map(review => ({
                label: (review.displayName || 'Unknown member').slice(0, 100),
                description: review.reviewId + ' · ' + formatDirectoryTimestamp(review.detectedAt),
                value: review.reviewId,
            })));
        components.push(new ActionRowBuilder().addComponents(menu));
    }
    components.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('skaw_el_dashboard:home').setLabel('Dashboard').setStyle(ButtonStyle.Secondary)));
    return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

function buildExitReviewDetail(review) {
    const text = [
        '**Employee:** ' + (review.displayName || 'Unknown member') + ' (<@' + review.userId + '>)',
        '**Review ID:** ' + review.reviewId,
        '**Role removed:** <@&' + BASE_EMPLOYEE_ROLE.id + '>',
        '**Detected:** ' + formatDirectoryTimestamp(review.detectedAt),
        '**Former position:** ' + (review.formerPositionId ? '<@&' + review.formerPositionId + '>' : 'Not recorded'),
        '',
        'Choose one final classification. The log is only published after Management confirms the outcome.',
    ].join('\\n');
    return {
        embeds: [new EmbedBuilder().setColor(0xd97706).setTitle('EMPLOYEE EXIT REVIEW').setDescription(text)
            .setFooter({ text: 'Sign Out is universal; Resignation and Dismissal explain the exit.' })],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('skaw_el_exit_outcome:' + review.reviewId + ':sign_out').setLabel('Sign Out').setEmoji('🔵').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('skaw_el_exit_outcome:' + review.reviewId + ':resignation').setLabel('Resignation').setEmoji('📄').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('skaw_el_exit_outcome:' + review.reviewId + ':dismissal').setLabel('Dismissal').setEmoji('⛔').setStyle(ButtonStyle.Danger),
            ),
            new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('skaw_el_dashboard:reviews').setLabel('Back to Exit Reviews').setStyle(ButtonStyle.Secondary)),
        ],
        allowedMentions: { parse: [] },
    };
}

function buildExitReasonModal(reviewId, outcome) {
    const label = outcome === 'resignation' ? 'Resignation Reason' : outcome === 'dismissal' ? 'Dismissal Reason' : 'Exit Reason (optional)';
    const modal = new ModalBuilder()
        .setCustomId('skaw_el_exit_form:' + reviewId + ':' + outcome)
        .setTitle((outcome === 'sign_out' ? 'Confirm Sign Out' : outcome === 'resignation' ? 'Confirm Resignation' : 'Confirm Dismissal').slice(0, 45));
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('reason').setLabel(label).setPlaceholder('Enter the approved reason, if applicable.')
        .setStyle(TextInputStyle.Paragraph).setRequired(outcome !== 'sign_out').setMaxLength(900)));
    return modal;
}

function buildFindModal() {
    return new ModalBuilder().setCustomId('skaw_el_find_form').setTitle('Find Employee')
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
            .setCustomId('query').setLabel('Name, mention, or Discord ID')
            .setPlaceholder('Search employee directory').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)));
}

async function buildReportPayload(client, guildId, days = 30) {
    const index = await getEmployeeDirectoryIndex(client, guildId);
    const audit = await getEmployeeLogAudit(client, guildId, { limit: 1000 });
    const since = Date.now() - Math.max(1, Number(days) || 30) * 86_400_000;
    const recent = audit.filter(item => new Date(item.publishedAt || 0).getTime() >= since);
    const counts = {};
    for (const item of recent) counts[item.type] = (counts[item.type] || 0) + 1;
    const embed = new EmbedBuilder().setColor(0x2563eb).setTitle('EMPLOYEE LOGS · MANAGEMENT REPORT')
        .setDescription('Activity summary for the last ' + days + ' days.')
        .addFields(
            { name: 'Active Employees', value: String(index.filter(item => item.status === 'active').length), inline: true },
            { name: 'Former Employees', value: String(index.filter(item => item.status === 'former').length), inline: true },
            { name: 'Directory Profiles', value: String(index.length), inline: true },
            { name: 'Records in Period', value: String(recent.length), inline: true },
            { name: 'Promotions', value: String(counts.promotion || 0), inline: true },
            { name: 'Mutations', value: String(counts.mutation || 0), inline: true },
            { name: 'Warnings', value: String(counts.warning || 0), inline: true },
            { name: 'Blacklists', value: String(counts.blacklist || 0), inline: true },
            { name: 'Sign In / Sign Out', value: String((counts.sign_in || 0) + (counts.sign_out || 0)), inline: true },
        )
        .setFooter({ text: 'Employee directory totals are indexed profiles; activity counts use durable log audit entries.' })
        .setTimestamp(new Date());
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('skaw_el_dashboard:home').setLabel('Dashboard').setStyle(ButtonStyle.Secondary))], allowedMentions: { parse: [] } };
}

async function handleInteraction(interaction) {
    if (!interaction.inGuild?.()) return;
    const isEmployeeLogsComponent = Boolean(interaction.customId?.startsWith('skaw_el_')) && (
        interaction.isButton?.() || interaction.isUserSelectMenu?.() || interaction.isRoleSelectMenu?.()
        || interaction.isStringSelectMenu?.() || interaction.isModalSubmit?.()
    );
    if (!isEmployeeLogsComponent) return;
    if (!hasManageGuild(interaction)) {
        return sendPrivate(interaction, 'You dont have permission');
    }
    if (interaction.isButton?.()) {
        if (interaction.customId.startsWith('skaw_el_edit_record:')) return handlePublishedRecordEditButton(interaction);
        if (interaction.customId.startsWith('skaw_el_start:')) return handleStart(interaction);
        if (interaction.customId.startsWith('skaw_el_back:')) return handleBackToPanel(interaction);
        if (interaction.customId.startsWith('skaw_el_edit:')) return handleEdit(interaction);
        if (interaction.customId.startsWith('skaw_el_confirm:')) return handleConfirm(interaction);
        if (interaction.customId.startsWith('skaw_el_cancel:')) return handleCancel(interaction);
    }
    if (interaction.isUserSelectMenu?.() && interaction.customId.startsWith('skaw_el_user:')) return handleUserSelect(interaction);
    if (interaction.isRoleSelectMenu?.() && interaction.customId.startsWith('skaw_el_role:')) return handleRoleSelect(interaction);
    if (interaction.isModalSubmit?.() && interaction.customId.startsWith('skaw_el_edit_record_modal:')) return handlePublishedRecordEditModal(interaction);
    if (interaction.isModalSubmit?.() && interaction.customId.startsWith('skaw_el_form:')) return handleModal(interaction);
    return sendPrivate(interaction, 'This Employee Logs action is not recognized or has expired. Reopen `/epl panel` and try again.');
}


export function buildEmployeeLogsPanel(config = null) {
    const embed = new EmbedBuilder()
        .setColor(0x2563eb)
        .setAuthor({ name: 'SKAW GROUP · PEOPLE OPERATIONS' })
        .setTitle('EMPLOYEE MANAGEMENT SYSTEM')
        .setDescription([
            '**CENTRAL PERSONNEL CONSOLE**',
            'Manage employee records, role mappings, membership exits, and system configuration from one place.',
            '',
            '• Manual logs and editable employee records',
            '• Role Registry and automatic role classification',
            '• Employee profile search and activity reports',
            '• Exit review queue for Company Staff membership changes',
        ].join('\\n'))
        .setFooter({ text: 'SKAW GROUP • EMPLOYEE LOGS' })
        .setTimestamp(new Date());
    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('skaw_el_dashboard:logs').setLabel('Manual Logs').setEmoji('📝').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('skaw_el_dashboard:find').setLabel('Find Employee').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('skaw_el_dashboard:report').setLabel('Reports').setEmoji('📊').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('skaw_el_dashboard:settings').setLabel('Settings').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('skaw_el_dashboard:roles').setLabel('Role Registry').setEmoji('🏷️').setStyle(ButtonStyle.Secondary),
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('skaw_el_dashboard:reviews').setLabel('Exit Reviews').setEmoji('📥').setStyle(ButtonStyle.Danger),
            ),
        ],
        allowedMentions: { parse: [] },
    };
}

export function buildEmployeeLogsActivitiesPanel(config = null) {
    const missingChannels = config ? Object.entries(EMPLOYEE_LOG_TYPES).filter(([type]) => !config.channels?.[type]).map(([, entry]) => entry.shortLabel) : [];
    const setupSummary = !config
        ? 'System setup details are available from the Employee Logs dashboard.'
        : missingChannels.length
            ? '⚙️ Channels still needed: ' + missingChannels.join(', ') + '. Open Dashboard → Settings.'
            : '✅ All activity destination channels are configured.';
    const embed = new EmbedBuilder()
        .setColor(0x2563eb)
        .setAuthor({ name: 'SKAW GROUP · PEOPLE OPERATIONS' })
        .setTitle('MANUAL EMPLOYEE LOGS')
        .setDescription([
            '**CREATE AN OFFICIAL PERSONNEL RECORD**',
            'Choose an activity below. Your selection, details, and preview are private.',
            '',
            '🟢 Sign In · 🔵 Sign Out · 🏆 Promotion · 🔻 Demote',
            '⛔ Dismissal · 📄 Resignation · 🔄 Mutation',
            '⚠️ Warning · 🛡️ Blacklist · 📝 Others',
            '',
            'The final embed is sent to the destination channel configured for that activity.',
            '',
            setupSummary,
        ].join('\\n'))
        .setFooter({ text: 'SKAW GROUP • PEOPLE OPERATIONS' })
        .setTimestamp(new Date());
    const types = Object.entries(EMPLOYEE_LOG_TYPES);
    const rowSizes = [4, 3, 3];
    const rows = [];
    let offset = 0;
    for (const rowSize of rowSizes) {
        const group = types.slice(offset, offset + rowSize);
        if (!group.length) continue;
        const row = new ActionRowBuilder();
        for (const [type, entry] of group) {
            const style = type === 'sign_in' ? ButtonStyle.Success
                : ['dismissal', 'blacklist', 'warning', 'demote'].includes(type) ? ButtonStyle.Danger
                : ['promotion', 'sign_out'].includes(type) ? ButtonStyle.Primary : ButtonStyle.Secondary;
            row.addComponents(new ButtonBuilder()
                .setCustomId('skaw_el_start:' + type)
                .setLabel(entry.shortLabel)
                .setEmoji(entry.emoji)
                .setStyle(style));
        }
        rows.push(row);
        offset += rowSize;
    }
    rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('skaw_el_dashboard:home').setLabel('Dashboard').setStyle(ButtonStyle.Secondary)));
    return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

export async function handleEmployeeLogsComponent(interaction) {
    try {
        await handleInteraction(interaction);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[Employee Logs]', error);
        if (!interaction.isRepliable?.()) return;
        try {
            const payload = { content: `❌ Employee Logs: ${message}`, embeds: [], components: [], allowedMentions: { parse: [] } };
            if (interaction.deferred && !interaction.replied) {
                await interaction.editReply(payload);
            } else if (interaction.replied) {
                await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
            } else {
                await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
            }
        } catch { /* Interaction expired or already acknowledged. */ }
    }
}
