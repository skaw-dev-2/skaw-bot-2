import { randomUUID } from 'node:crypto';
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    PermissionFlagsBits,
    RoleSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
    UserSelectMenuBuilder,
} from 'discord.js';
import {
    EMPLOYEE_LOG_TYPES,
    buildEmployeeLogEmbed,
    createEmployeeLogApproval,
    getEmployeeLogApproval,
    getEmployeeLogsConfig,
    resolveEmployeeLogsBanner,
    sendEmployeeLog,
    updateEmployeeLogApproval,
} from './employeeLogsService.js';

const SESSION_TTL_MS = 15 * 60 * 1000;
const sessions = new Map();
const attachedClients = new WeakSet();
const deferredUpdateInteractions = new WeakSet();
const approvalDecisionsInProgress = new Set();

async function acknowledgeComponentUpdate(interaction) {
    await interaction.deferUpdate();
    deferredUpdateInteractions.add(interaction);
}

function roleCacheHas(interaction, roleId) {
    if (!roleId) return false;
    const roles = interaction.member?.roles;
    if (roles?.cache?.has) return roles.cache.has(roleId);
    if (Array.isArray(roles)) return roles.includes(roleId);
    return Boolean(interaction.guild?.members?.cache?.get(interaction.user.id)?.roles?.cache?.has?.(roleId));
}
function hasManageGuild(interaction) {
    return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
        || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}
async function canCreate(interaction, config) {
    if (!interaction.inGuild?.()) return false;
    if (hasManageGuild(interaction)) return true;
    return roleCacheHas(interaction, config.staffRoleId);
}
function canApprove(interaction, config) {
    if (!interaction.inGuild?.()) return false;
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
    if (config.managementRoleId) return roleCacheHas(interaction, config.managementRoleId);
    return hasManageGuild(interaction);
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
    return ({ position: 'Position / jabatan', previousRank: 'Previous Rank', nextRank: 'New Rank', fromRole: 'Previous Position', toRole: 'New Position' })[field] || 'Position';
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
    if (session.type === 'dismissal' || session.type === 'blacklist') {
        modal.addComponents(
            textInput('reason', 'Reason (required)', 'Explain the reason for this notice.', true, TextInputStyle.Paragraph, 850, session.data.reason),
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
function previewButtons(sessionId, approvalRequired = false) {
    const submitLabel = approvalRequired ? 'Submit for Management Approval' : 'Confirm & Send';
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`skaw_el_edit:${sessionId}`).setLabel('Edit Details').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`skaw_el_confirm:${sessionId}`).setLabel(submitLabel).setEmoji(approvalRequired ? '🛡️' : '✅').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`skaw_el_cancel:${sessionId}`).setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Secondary),
    );
}
function approvalButtons(requestId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`skaw_el_approve:${requestId}`).setLabel('Approve & Publish').setEmoji('✅').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`skaw_el_reject:${requestId}`).setLabel('Reject').setEmoji('✖️').setStyle(ButtonStyle.Danger),
    );
}
async function sendPrivate(interaction, content) {
    const payload = { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
    if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
    return interaction.reply(payload);
}
function ensureChannelPermissions(channel, guild) {
    if (!channel || !channel.isTextBased?.() || channel.isDMBased?.() || channel.guildId !== guild.id) {
        throw new Error('Approval channel is missing or must be a text channel in this server.');
    }
    const me = guild.members.me;
    const perms = channel.permissionsFor(me || guild.client.user);
    const needed = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks;
    if (!perms?.has(needed)) throw new Error(`Bot needs View Channel, Send Messages, and Embed Links in ${channel}.`);
}
async function validateSessionConfig(interaction, type, config) {
    if (!config.channels[type]) throw new Error(`Channel for **${EMPLOYEE_LOG_TYPES[type].shortLabel}** is not configured. Ask an administrator to run /employee-logs set-channel.`);
    if (EMPLOYEE_LOG_TYPES[type].approvalRequired) {
        if (!config.approvalChannelId) throw new Error('Management approval channel is not configured. Ask an administrator to set it with /employee-logs set-approval-channel.');
        if (!config.managementRoleId) throw new Error('Management approver role is not configured. Ask an administrator to set it with /employee-logs set-management-role.');
    }
}
async function showPreview(interaction, session) {
    const config = await getEmployeeLogsConfig(interaction.client, interaction.guildId);
    await validateSessionConfig(interaction, session.type, config);
    session.data.recordedBy = interaction.user.id;
    const embed = buildEmployeeLogEmbed(session.type, session.data, resolveEmployeeLogsBanner(config, session.type));
    embed.setDescription(`**PRIVATE PREVIEW**\n${EMPLOYEE_LOG_TYPES[session.type].subtitle}\nCheck the details before publishing. This preview is visible only to you.`);
    return interaction.editReply({
        content: `**${EMPLOYEE_LOG_TYPES[session.type].shortLabel} — review your record**\nDestination: <#${config.channels[session.type]}>${EMPLOYEE_LOG_TYPES[session.type].approvalRequired ? `\nApproval request goes to <#${config.approvalChannelId}> first.` : ''}`,
        embeds: [embed],
        components: [previewButtons(session.id, Boolean(EMPLOYEE_LOG_TYPES[session.type].approvalRequired))],
        allowedMentions: { parse: [] },
    });
}
async function submitApprovalRequest(interaction, session, config) {
    const approvalChannel = await interaction.client.channels.fetch(config.approvalChannelId).catch(() => null);
    ensureChannelPermissions(approvalChannel, interaction.guild);
    const requestId = randomUUID().replaceAll('-', '').slice(0, 16);
    const request = await createEmployeeLogApproval(interaction.client, interaction.guildId, {
        id: requestId, type: session.type, data: { ...session.data }, requestedBy: interaction.user.id,
        approvalChannelId: approvalChannel.id, officialChannelId: config.channels[session.type],
    });
    const embed = buildEmployeeLogEmbed(session.type, request.data, resolveEmployeeLogsBanner(config, session.type), { pending: true })
        .setDescription(`**MANAGEMENT APPROVAL REQUIRED**\nRequested by <@${request.requestedBy}>. The official employee log will not be published until an authorized Management member approves it.`)
        .addFields({ name: '🔐 APPROVAL REQUEST', value: `Reference: ${request.id}
Status: **PENDING**`, inline: false });
    let message;
    try {
        message = await approvalChannel.send({ embeds: [embed], components: [approvalButtons(request.id)], allowedMentions: { parse: [] } });
    } catch (error) {
        await updateEmployeeLogApproval(interaction.client, interaction.guildId, request.id, { status: 'failed', failureReason: String(error?.message || error).slice(0, 300) }).catch(() => {});
        throw new Error(`Could not send the Management approval request: ${error?.message || error}`);
    }
    // The approval message is already live; don't mark the request failed if only the optional message-id update fails.
    await updateEmployeeLogApproval(interaction.client, interaction.guildId, request.id, { approvalMessageId: message.id, status: 'pending' }).catch(error => {
        console.warn('[Employee Logs] Approval request was sent but its message ID could not be saved:', error?.message || error);
    });
    return { message, channel: approvalChannel };
}

async function handleStart(interaction) {
    if (!interaction.inGuild?.()) return sendPrivate(interaction, 'Employee Logs can only be used in a server.');
    // Replace the current private panel instead of creating a trail of ephemeral messages.
    await acknowledgeComponentUpdate(interaction);
    const config = await getEmployeeLogsConfig(interaction.client, interaction.guildId);
    if (!await canCreate(interaction, config)) return interaction.editReply({ content: '❌ You need the configured Employee Staff role or Manage Server permission to create records.', embeds: [], components: [], allowedMentions: { parse: [] } });
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
    if (!session) return interaction.editReply({ content: '⌛ Form expired. Open `/employee-logs panel` and start again.', embeds: [], components: [], allowedMentions: { parse: [] } });
    const memberId = interaction.values[0];
    const member = await interaction.guild.members.fetch(memberId).catch(() => null);
    if (!member) return interaction.editReply({ content: '❌ Employee could not be found in this server.', embeds: [], components: [], allowedMentions: { parse: [] } });
    session.data.userId = member.id;
    session.stepIndex = 0;
    const roleFields = EMPLOYEE_LOG_TYPES[session.type].roleFields;
    return interaction.editReply({
        content: `**${EMPLOYEE_LOG_TYPES[session.type].shortLabel}**\nEmployee: <@${member.id}>\nStep 2 of ${roleFields.length + 2}: select **${roleFieldLabel(roleFields[0])}**.`,
        embeds: [], components: [roleSelectRow(session), backToPanelRow(session.id)], allowedMentions: { parse: [] },
    });
}

async function handleRoleSelect(interaction) {
    const sessionId = interaction.customId.slice('skaw_el_role:'.length);
    const session = getSession(interaction, sessionId);
    if (!session) return sendPrivate(interaction, '⌛ Form expired. Open `/employee-logs panel` and start again.');
    const fields = EMPLOYEE_LOG_TYPES[session.type].roleFields;
    const field = fields[session.stepIndex];
    const roleId = interaction.values[0];
    if (!roleId || roleId === interaction.guildId) return sendPrivate(interaction, '❌ Choose a valid position role.');
    session.data[field] = roleId;
    session.stepIndex += 1;
    if (session.stepIndex < fields.length) {
        const nextField = fields[session.stepIndex];
        return interaction.update({
            content: `**${EMPLOYEE_LOG_TYPES[session.type].shortLabel}**\nEmployee: <@${session.data.userId}>\nSelected: ${session.stepIndex}/${fields.length} roles\nNext: choose **${roleFieldLabel(nextField)}**.`,
            components: [roleSelectRow(session), backToPanelRow(session.id)], allowedMentions: { parse: [] },
        });
    }
    return interaction.showModal(buildModal(session));
}

async function handleModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sessionId = interaction.customId.slice('skaw_el_form:'.length);
    const session = getSession(interaction, sessionId);
    if (!session) return interaction.editReply({ content: '⌛ Form expired. Open `/employee-logs panel` and start again.', allowedMentions: { parse: [] } });
    const get = id => interaction.fields.getTextInputValue(id).trim();
    if (session.type === 'dismissal' || session.type === 'blacklist') session.data.reason = get('reason');
    if (session.type === 'warning') { session.data.warn = get('warn'); session.data.reason = get('reason'); }
    if (session.type === 'others') { session.data.activityTitle = get('activityTitle'); session.data.activityDescription = get('activityDescription'); }
    session.data.notes = get('notes');
    session.data.recordedBy = interaction.user.id;
    return showPreview(interaction, session);
}

async function handleEdit(interaction) {
    const sessionId = interaction.customId.slice('skaw_el_edit:'.length);
    const session = getSession(interaction, sessionId);
    if (!session) return sendPrivate(interaction, '⌛ Form expired. Open `/employee-logs panel` and start again.');
    return interaction.showModal(buildModal(session));
}

async function handleConfirm(interaction) {
    await acknowledgeComponentUpdate(interaction);
    const sessionId = interaction.customId.slice('skaw_el_confirm:'.length);
    const session = getSession(interaction, sessionId);
    if (!session) return interaction.editReply({ content: '⌛ Form expired. Open `/employee-logs panel` and start again.', embeds: [], components: [], allowedMentions: { parse: [] } });
    if (session.status === 'submitting') return sendPrivate(interaction, '⏳ This record is already being processed. Please wait.');
    session.status = 'submitting';
    try {
        const config = await getEmployeeLogsConfig(interaction.client, interaction.guildId);
        await validateSessionConfig(interaction, session.type, config);
        session.data.recordedBy = interaction.user.id;
        if (EMPLOYEE_LOG_TYPES[session.type].approvalRequired) {
            const request = await submitApprovalRequest(interaction, session, config);
            sessions.delete(sessionKey(session.guildId, session.userId));
            return interaction.editReply({ content: `✅ **${EMPLOYEE_LOG_TYPES[session.type].shortLabel} submitted for Management approval.**\nRequest sent to ${request.channel}. It has **not** been published to the official log channel yet.`, embeds: [], components: [], allowedMentions: { parse: [] } });
        }
        const result = await sendEmployeeLog(interaction.client, interaction.guild, session.type, session.data);
        sessions.delete(sessionKey(session.guildId, session.userId));
        const stickerNote = result.stickerWarning ? `\n⚠️ ${result.stickerWarning}` : (result.stickerSent ? '\n✨ Sticker successfully sent.' : '');
        return interaction.editReply({ content: `✅ **${result.template.shortLabel} published successfully** to ${result.channel}.${stickerNote}`, embeds: [], components: [], allowedMentions: { parse: [] } });
    } catch (error) {
        session.status = 'ready';
        throw error;
    }
}

async function handleBackToPanel(interaction) {
    await acknowledgeComponentUpdate(interaction);
    const sessionId = interaction.customId.slice('skaw_el_back:'.length);
    const session = getSession(interaction, sessionId);
    if (session) sessions.delete(sessionKey(session.guildId, session.userId));
    return interaction.editReply({ content: 'Session cancelled. Choose another activity or close this private panel.', ...buildEmployeeLogsPanel(), allowedMentions: { parse: [] } });
}

async function handleCancel(interaction) {
    await acknowledgeComponentUpdate(interaction);
    const sessionId = interaction.customId.slice('skaw_el_cancel:'.length);
    const session = getSession(interaction, sessionId);
    if (session) sessions.delete(sessionKey(session.guildId, session.userId));
    return interaction.editReply({ content: '🗑️ Record cancelled. Nothing was published.', embeds: [], components: [], allowedMentions: { parse: [] } });
}

async function handleApprovalDecision(interaction, approve) {
    await acknowledgeComponentUpdate(interaction);
    const requestId = interaction.customId.slice(approve ? 'skaw_el_approve:'.length : 'skaw_el_reject:'.length);
    const request = await getEmployeeLogApproval(interaction.client, interaction.guildId, requestId);
    if (!request) return sendPrivate(interaction, '❌ Approval request not found.');
    const config = await getEmployeeLogsConfig(interaction.client, interaction.guildId);
    if (!canApprove(interaction, config)) return sendPrivate(interaction, '🔒 Only Management or a server administrator can approve or reject this request.');
    const lockKey = `${interaction.guildId}:${requestId}`;
    if (approvalDecisionsInProgress.has(lockKey)) return sendPrivate(interaction, '⏳ Another Management member is already processing this request.');
    if (request.status !== 'pending') return sendPrivate(interaction, `This request is already **${request.status}**.`);
    approvalDecisionsInProgress.add(lockKey);
    try {
        await updateEmployeeLogApproval(interaction.client, interaction.guildId, requestId, { status: approve ? 'processing' : 'rejected', decidedBy: interaction.user.id });
        if (!approve) {
            const rejected = EmbedBuilder.from(interaction.message.embeds[0])
                .setDescription(`**⛔ REQUEST REJECTED**\nRejected by <@${interaction.user.id}>. The official employee log was not published.`)
                .setColor(0xdc2626);
            await interaction.message.edit({ embeds: [rejected], components: [], allowedMentions: { parse: [] } }).catch(() => {});
            await updateEmployeeLogApproval(interaction.client, interaction.guildId, requestId, { status: 'rejected', decidedBy: interaction.user.id, decidedAt: new Date().toISOString() });
            return sendPrivate(interaction, '✅ Request rejected. No official employee log was published.');
        }
        let result;
        try {
            const data = { ...request.data, recordedBy: request.requestedBy, approvedBy: interaction.user.id };
            result = await sendEmployeeLog(interaction.client, interaction.guild, request.type, data);
        } catch (error) {
            await updateEmployeeLogApproval(interaction.client, interaction.guildId, requestId, { status: 'pending', lastError: String(error?.message || error).slice(0, 300) }).catch(() => {});
            return sendPrivate(interaction, `❌ Approval could not be completed: ${error?.message || error}. The request remains pending so it can be retried.`);
        }
        // A published official record must never be made pending again; that could allow duplicate publication.
        const storedAsApproved = await updateEmployeeLogApproval(interaction.client, interaction.guildId, requestId, { status: 'approved', decidedBy: interaction.user.id, decidedAt: new Date().toISOString(), officialChannelId: result.channel.id, officialMessageId: result.message.id }).then(() => true).catch(error => {
            console.error('[Employee Logs] Record was published but approval status could not be saved:', error?.message || error);
            return false;
        });
        const approved = EmbedBuilder.from(interaction.message.embeds[0])
            .setDescription(`**✅ APPROVED & PUBLISHED**\nApproved by <@${interaction.user.id}>. Official record: ${result.channel}${storedAsApproved ? '' : '\n⚠️ The official log is published, but the approval status needs database review.'}`)
            .setColor(0x16a34a);
        await interaction.message.edit({ embeds: [approved], components: [], allowedMentions: { parse: [] } }).catch(() => {});
        return sendPrivate(interaction, `✅ **${EMPLOYEE_LOG_TYPES[request.type].shortLabel} approved and published** to ${result.channel}.${storedAsApproved ? '' : ' Warning: database status update failed, but the official record was sent.'}`);
    } finally {
        approvalDecisionsInProgress.delete(lockKey);
    }
}

async function handleInteraction(interaction) {
    if (!interaction.inGuild?.()) return;
    if (interaction.isButton?.()) {
        if (interaction.customId.startsWith('skaw_el_start:')) return handleStart(interaction);
        if (interaction.customId.startsWith('skaw_el_back:')) return handleBackToPanel(interaction);
        if (interaction.customId.startsWith('skaw_el_edit:')) return handleEdit(interaction);
        if (interaction.customId.startsWith('skaw_el_confirm:')) return handleConfirm(interaction);
        if (interaction.customId.startsWith('skaw_el_cancel:')) return handleCancel(interaction);
        if (interaction.customId.startsWith('skaw_el_approve:')) return handleApprovalDecision(interaction, true);
        if (interaction.customId.startsWith('skaw_el_reject:')) return handleApprovalDecision(interaction, false);
    }
    if (interaction.isUserSelectMenu?.() && interaction.customId.startsWith('skaw_el_user:')) return handleUserSelect(interaction);
    if (interaction.isRoleSelectMenu?.() && interaction.customId.startsWith('skaw_el_role:')) return handleRoleSelect(interaction);
    if (interaction.isModalSubmit?.() && interaction.customId.startsWith('skaw_el_form:')) return handleModal(interaction);
}

export function buildEmployeeLogsPanel() {
    const embed = new EmbedBuilder()
        .setColor(0x2563eb)
        .setAuthor({ name: '🏢 SKAW GROUP • PEOPLE OPERATIONS' })
        .setTitle('📑 EMPLOYEE RECORDS CONSOLE')
        .setDescription([
            '**CENTRAL PERSONNEL LOGGING SYSTEM**',
            'Choose an activity below. Forms and previews are visible only to you.',
            '',
            '🟢 Sign In • 🔵 Sign Out • 🏆 Promotion',
            '⛔ Dismissal • 📄 Resignation • 🔄 Mutation',
            '⚠️ Warning • 🛡️ Blacklist • 📝 Others',
            '',
            'Dismissal and Blacklist require Management approval before the final record is published.',
        ].join('\n'))
        .setFooter({ text: 'SKAW GROUP • PEOPLE OPERATIONS' })
        .setTimestamp(new Date());
    const types = Object.entries(EMPLOYEE_LOG_TYPES);
    const rows = [];
    for (let start = 0; start < types.length; start += 5) {
        const row = new ActionRowBuilder();
        for (const [type, entry] of types.slice(start, start + 5)) {
            const style = type === 'sign_in' ? ButtonStyle.Success
                : type === 'dismissal' || type === 'blacklist' ? ButtonStyle.Danger
                : type === 'promotion' ? ButtonStyle.Primary : ButtonStyle.Secondary;
            row.addComponents(new ButtonBuilder()
                .setCustomId(`skaw_el_start:${type}`)
                .setLabel(entry.shortLabel)
                .setEmoji(entry.emoji)
                .setStyle(style));
        }
        rows.push(row);
    }
    return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

export function startEmployeeLogsInteractionHandler(client) {
    if (!client || attachedClients.has(client)) return;
    attachedClients.add(client);
    client.on('interactionCreate', async interaction => {
        try { await handleInteraction(interaction); }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('[Employee Logs]', error);
            if (!interaction.isRepliable?.()) return;
            try {
                if (interaction.deferred && !interaction.replied && !deferredUpdateInteractions.has(interaction)) {
                    await interaction.editReply({ content: `❌ Employee Logs: ${message}`, embeds: [], components: [], allowedMentions: { parse: [] } });
                } else {
                    await sendPrivate(interaction, `❌ Employee Logs: ${message}`);
                }
            } catch { /* Interaction already expired/acknowledged */ }
        }
    });
}
