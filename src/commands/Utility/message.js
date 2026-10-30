import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    EmbedBuilder,
    LabelBuilder,
    MessageFlags,
    ModalBuilder,
    PermissionFlagsBits,
    RoleSelectMenuBuilder,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { logger } from '../../utils/logger.js';
import {
    MESSAGE_MANAGER_DEFAULT_EMBED_COLOR,
    MESSAGE_MANAGER_PUBLIC_EDIT_CUSTOM_ID,
    assertCanSendManagedMessage,
    buildManagedEmbed,
    buildManagedMessagePayload,
    getAllowedMessageRoles,
    getManagedMessage,
    getManagedMessages,
    getMessageManagerAccess,
    normalizeMessageRecord,
    removeManagedMessage,
    requireMessageSettingsPermission,
    saveManagedMessage,
    setAllowedMessageRoles,
    validateEmbedData,
    validateRegularMessage,
} from '../../services/messageManagerService.js';

const PREFIX = 'skaw_mm_v1_';
const DRAFT_TTL_MS = 15 * 60 * 1000;
const drafts = new Map();
const roleDrafts = new Map();

const IDS = {
    homeRegular: `${PREFIX}create_regular`,
    homeEmbed: `${PREFIX}create_embed`,
    homeManage: `${PREFIX}manage`,
    publicEdit: MESSAGE_MANAGER_PUBLIC_EDIT_CUSTOM_ID,
    channel: 'mm_channel',
    regularContent: 'mm_regular_content',
    embedTitle: 'mm_embed_title',
    embedDescription: 'mm_embed_description',
    embedColor: 'mm_embed_color',
    embedUrl: 'mm_embed_url',
    authorName: 'mm_author_name',
    authorUrl: 'mm_author_url',
    authorIcon: 'mm_author_icon',
    footerText: 'mm_footer_text',
    footerIcon: 'mm_footer_icon',
    thumbnailUrl: 'mm_thumbnail_url',
    imageUrl: 'mm_image_url',
};

function makeToken() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}

function draftKey(guildId, userId, token) {
    return `${guildId}:${userId}:${token}`;
}

function cleanupExpiredDrafts() {
    const now = Date.now();
    for (const [key, draft] of drafts) {
        if (now - draft.updatedAt > DRAFT_TTL_MS) drafts.delete(key);
    }
    for (const [key, draft] of roleDrafts) {
        if (now - draft.updatedAt > DRAFT_TTL_MS) roleDrafts.delete(key);
    }
}

function saveDraft(interaction, draft) {
    cleanupExpiredDrafts();
    draft.updatedAt = Date.now();
    drafts.set(draftKey(interaction.guildId, interaction.user.id, draft.token), draft);
}

function getDraft(interaction, token) {
    cleanupExpiredDrafts();
    return drafts.get(draftKey(interaction.guildId, interaction.user.id, token)) || null;
}

function deleteDraft(interaction, token) {
    drafts.delete(draftKey(interaction.guildId, interaction.user.id, token));
}

function roleDraftKey(interaction) {
    return `${interaction.guildId}:${interaction.user.id}`;
}

function setRoleDraft(interaction, roleIds) {
    roleDrafts.set(roleDraftKey(interaction), {
        roleIds: [...new Set((roleIds || []).map(String))],
        updatedAt: Date.now(),
    });
}

function getRoleDraft(interaction) {
    cleanupExpiredDrafts();
    return roleDrafts.get(roleDraftKey(interaction)) || null;
}

function shortInput(customId, placeholder, value = '', maxLength = 200, required = false) {
    const input = new TextInputBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .setStyle(TextInputStyle.Short)
        .setMaxLength(maxLength)
        .setRequired(required);

    if (value) input.setValue(String(value).slice(0, maxLength));
    return input;
}

function paragraphInput(customId, placeholder, value = '', maxLength = 4096, required = true) {
    const input = new TextInputBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(maxLength)
        .setRequired(required);

    if (value) input.setValue(String(value).slice(0, maxLength));
    return input;
}

function textLabel(label, description, input) {
    return new LabelBuilder()
        .setLabel(label)
        .setDescription(description)
        .setTextInputComponent(input);
}

function channelLabel(draft) {
    const selector = new ChannelSelectMenuBuilder()
        .setCustomId(IDS.channel)
        .setPlaceholder(draft.channelId ? 'Destination channel selected' : 'Select a destination channel')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(1)
        .setMaxValues(1)
        .setRequired(true);

    if (draft.channelId) selector.setDefaultChannels(draft.channelId);

    return new LabelBuilder()
        .setLabel('Destination Channel')
        .setDescription('Choose the text channel where the bot will send the message.')
        .setChannelSelectMenuComponent(selector);
}

function buildRegularCreateModal(draft) {
    return new ModalBuilder()
        .setCustomId(`${PREFIX}modal_regular:${draft.token}`)
        .setTitle('Create Regular Message')
        .addLabelComponents(
            channelLabel(draft),
            textLabel(
                'Message',
                'Write the message that SKAW GROUP Bot will send.',
                paragraphInput(IDS.regularContent, 'Enter your message...', draft.content, 2000, true),
            ),
        );
}

function buildRegularEditModal(draft) {
    return new ModalBuilder()
        .setCustomId(`${PREFIX}modal_content:${draft.token}`)
        .setTitle('Edit Regular Message')
        .addLabelComponents(
            textLabel(
                'Message',
                'Your existing message is loaded below. Edit only what you need.',
                paragraphInput(IDS.regularContent, 'Enter your message...', draft.content, 2000, true),
            ),
        );
}

function buildEmbedCreateModal(draft) {
    return new ModalBuilder()
        .setCustomId(`${PREFIX}modal_embed:${draft.token}`)
        .setTitle('Create Embed Message')
        .addLabelComponents(
            channelLabel(draft),
            textLabel(
                'Title',
                'Optional. Maximum 256 characters.',
                shortInput(IDS.embedTitle, 'Embed title...', draft.embed.title, 256, false),
            ),
            textLabel(
                'Description',
                'Main embed text. Maximum 4096 characters.',
                paragraphInput(IDS.embedDescription, 'Enter the embed description...', draft.embed.description, 4096, true),
            ),
            textLabel(
                'Color',
                `Default: ${MESSAGE_MANAGER_DEFAULT_EMBED_COLOR}. Enter a 6-digit HEX color.`,
                shortInput(IDS.embedColor, MESSAGE_MANAGER_DEFAULT_EMBED_COLOR, draft.embed.color, 7, false),
            ),
        );
}

function buildEmbedContentModal(draft) {
    return new ModalBuilder()
        .setCustomId(`${PREFIX}modal_content:${draft.token}`)
        .setTitle('Edit Embed Content')
        .addLabelComponents(
            textLabel(
                'Title',
                'Optional. Maximum 256 characters.',
                shortInput(IDS.embedTitle, 'Embed title...', draft.embed.title, 256, false),
            ),
            textLabel(
                'Description',
                'The main embed text. Your previous content is loaded.',
                paragraphInput(IDS.embedDescription, 'Enter the embed description...', draft.embed.description, 4096, true),
            ),
        );
}

function buildAppearanceModal(draft) {
    return new ModalBuilder()
        .setCustomId(`${PREFIX}modal_appearance:${draft.token}`)
        .setTitle('Embed Appearance')
        .addLabelComponents(
            textLabel(
                'Embed Color',
                'Use #1500FF for SKAW default blue. Enter another HEX to customize.',
                shortInput(IDS.embedColor, MESSAGE_MANAGER_DEFAULT_EMBED_COLOR, draft.embed.color, 7, false),
            ),
            textLabel(
                'Embed URL',
                'Optional HTTP/HTTPS URL opened when the embed title is clicked.',
                shortInput(IDS.embedUrl, 'https://example.com', draft.embed.url, 2048, false),
            ),
        );
}

function buildIdentityModal(draft) {
    return new ModalBuilder()
        .setCustomId(`${PREFIX}modal_identity:${draft.token}`)
        .setTitle('Embed Author & Footer')
        .addLabelComponents(
            textLabel('Author Name', 'Optional.', shortInput(IDS.authorName, 'Author name...', draft.embed.authorName, 256)),
            textLabel('Author URL', 'Optional HTTP/HTTPS URL.', shortInput(IDS.authorUrl, 'https://example.com', draft.embed.authorUrl, 2048)),
            textLabel('Author Icon URL', 'Optional HTTP/HTTPS image URL.', shortInput(IDS.authorIcon, 'https://example.com/icon.png', draft.embed.authorIconUrl, 2048)),
            textLabel('Footer Text', 'Optional.', shortInput(IDS.footerText, 'Footer text...', draft.embed.footerText, 2048)),
            textLabel('Footer Icon URL', 'Optional HTTP/HTTPS image URL.', shortInput(IDS.footerIcon, 'https://example.com/icon.png', draft.embed.footerIconUrl, 2048)),
        );
}

function buildMediaModal(draft) {
    return new ModalBuilder()
        .setCustomId(`${PREFIX}modal_media:${draft.token}`)
        .setTitle('Embed Media')
        .addLabelComponents(
            textLabel('Thumbnail URL', 'Optional HTTP/HTTPS image URL.', shortInput(IDS.thumbnailUrl, 'https://example.com/thumbnail.png', draft.embed.thumbnailUrl, 2048)),
            textLabel('Image URL', 'Optional HTTP/HTTPS image URL.', shortInput(IDS.imageUrl, 'https://example.com/image.png', draft.embed.imageUrl, 2048)),
        );
}

function makeButton(customId, label, style = ButtonStyle.Secondary, emoji = null) {
    const button = new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
    if (emoji) button.setEmoji(emoji);
    return button;
}

function buildHomePanel() {
    return {
        embeds: [{
            title: 'MESSAGE MANAGER',
            description: [
                'Create and manage messages sent by SKAW GROUP Bot.',
                '',
                '**Create Message**',
                'Choose a regular text message or a customizable embed.',
                '',
                '**Manage Existing Messages**',
                'Find, edit, or delete messages previously sent through this panel.',
            ].join('\n'),
            color: Number.parseInt(MESSAGE_MANAGER_DEFAULT_EMBED_COLOR.slice(1), 16),
            footer: { text: 'SKAW GROUP • Message Management' },
        }],
        components: [
            new ActionRowBuilder().addComponents(
                makeButton(IDS.homeRegular, 'Regular Message', ButtonStyle.Primary, '💬'),
                makeButton(IDS.homeEmbed, 'Embed Message', ButtonStyle.Primary, '🧩'),
            ),
            new ActionRowBuilder().addComponents(
                makeButton(IDS.homeManage, 'Manage Existing Messages', ButtonStyle.Secondary, '📂'),
            ),
        ],
    };
}

function buildDraftPreview(draft) {
    const info = new EmbedBuilder()
        .setTitle(draft.mode === 'edit' ? 'EDIT MESSAGE • PREVIEW' : 'NEW MESSAGE • PREVIEW')
        .setColor(Number.parseInt(MESSAGE_MANAGER_DEFAULT_EMBED_COLOR.slice(1), 16))
        .addFields(
            { name: 'Message Type', value: draft.type === 'embed' ? 'Embed Message' : 'Regular Message', inline: true },
            { name: 'Destination', value: draft.channelId ? `<#${draft.channelId}>` : 'Not selected', inline: true },
        )
        .setFooter({ text: 'Review the preview before confirming your action.' });

    const components = [];

    if (draft.type === 'embed') {
        components.push(
            new ActionRowBuilder().addComponents(
                makeButton(`${PREFIX}edit_content:${draft.token}`, 'Edit Content', ButtonStyle.Secondary, '✏️'),
                makeButton(`${PREFIX}edit_appearance:${draft.token}`, 'Appearance', ButtonStyle.Secondary, '🎨'),
                makeButton(`${PREFIX}edit_identity:${draft.token}`, 'Author / Footer', ButtonStyle.Secondary, '📝'),
                makeButton(`${PREFIX}edit_media:${draft.token}`, 'Media', ButtonStyle.Secondary, '🖼️'),
            ),
        );
        components.push(
            new ActionRowBuilder().addComponents(
                makeButton(`${PREFIX}reset_color:${draft.token}`, 'Reset Color', ButtonStyle.Secondary),
                makeButton(`${PREFIX}confirm:${draft.token}`, draft.mode === 'edit' ? 'Save Changes' : 'Send Message', ButtonStyle.Success, '📨'),
                makeButton(`${PREFIX}cancel:${draft.token}`, 'Cancel', ButtonStyle.Danger),
            ),
        );

        return {
            content: '',
            embeds: [info, buildManagedEmbed(draft.embed)],
            components,
            allowedMentions: { parse: [] },
        };
    }

    components.push(
        new ActionRowBuilder().addComponents(
            makeButton(`${PREFIX}edit_content:${draft.token}`, 'Edit Content', ButtonStyle.Secondary, '✏️'),
            makeButton(`${PREFIX}confirm:${draft.token}`, draft.mode === 'edit' ? 'Save Changes' : 'Send Message', ButtonStyle.Success, '📨'),
            makeButton(`${PREFIX}cancel:${draft.token}`, 'Cancel', ButtonStyle.Danger),
        ),
    );

    return {
        content: draft.content || '',
        embeds: [info],
        components,
        allowedMentions: { parse: [] },
    };
}

function buildManageList(messages) {
    if (!messages.length) {
        return {
            embeds: [{
                title: 'MANAGE EXISTING MESSAGES',
                description: 'No messages have been created through Message Manager yet.',
                color: Number.parseInt(MESSAGE_MANAGER_DEFAULT_EMBED_COLOR.slice(1), 16),
            }],
            components: [
                new ActionRowBuilder().addComponents(
                    makeButton(`${PREFIX}back_home`, 'Back', ButtonStyle.Secondary, '↩️'),
                ),
            ],
        };
    }

    const options = messages.map(record => {
        const text = record.type === 'embed'
            ? (record.embed?.title || record.embed?.description || 'Untitled embed')
            : record.content;
        const clean = String(text || 'No text').replace(/\s+/g, ' ').trim();
        const channelName = record.channelId;
        return {
            label: `${record.type === 'embed' ? 'Embed' : 'Regular'} • ${clean.slice(0, 60) || 'Untitled'}`.slice(0, 100),
            description: `#${channelName} • ${new Date(record.updatedAt || record.createdAt).toLocaleDateString('en-GB')}`.slice(0, 100),
            value: record.messageId,
        };
    });

    return {
        embeds: [{
            title: 'MANAGE EXISTING MESSAGES',
            description: 'Select a message below to edit or delete it. The list shows the 25 most recently updated managed messages.',
            color: Number.parseInt(MESSAGE_MANAGER_DEFAULT_EMBED_COLOR.slice(1), 16),
        }],
        components: [
            new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`${PREFIX}manage_pick`)
                    .setPlaceholder('Select a managed message')
                    .setMinValues(1)
                    .setMaxValues(1)
                    .addOptions(options),
            ),
            new ActionRowBuilder().addComponents(
                makeButton(`${PREFIX}back_home`, 'Back', ButtonStyle.Secondary, '↩️'),
            ),
        ],
    };
}

function buildSelectedMessagePanel(record) {
    const title = record.type === 'embed'
        ? (record.embed?.title || 'Embed Message')
        : 'Regular Message';
    const description = record.type === 'embed'
        ? record.embed?.description || ''
        : record.content || '';

    const info = new EmbedBuilder()
        .setTitle('MANAGE MESSAGE')
        .setDescription(`**${title.slice(0, 200)}**\n\n${description.slice(0, 2500)}`)
        .setColor(Number.parseInt(MESSAGE_MANAGER_DEFAULT_EMBED_COLOR.slice(1), 16))
        .addFields(
            { name: 'Channel', value: `<#${record.channelId}>`, inline: true },
            { name: 'Type', value: record.type === 'embed' ? 'Embed' : 'Regular', inline: true },
            { name: 'Message ID', value: `\`${record.messageId}\``, inline: false },
        );

    const components = [
        new ActionRowBuilder().addComponents(
            makeButton(`${PREFIX}manage_edit:${record.messageId}`, 'Edit', ButtonStyle.Primary, '✏️'),
            makeButton(`${PREFIX}manage_delete:${record.messageId}`, 'Delete', ButtonStyle.Danger, '🗑️'),
        ),
        new ActionRowBuilder().addComponents(
            makeButton(`${PREFIX}manage_back`, 'Back to Messages', ButtonStyle.Secondary, '↩️'),
        ),
    ];

    if (record.type === 'embed') {
        return {
            embeds: [info, buildManagedEmbed(record.embed)],
            components,
        };
    }

    return {
        embeds: [info],
        components,
    };
}

function buildDeleteConfirmation(record) {
    return {
        embeds: [{
            title: 'DELETE MANAGED MESSAGE?',
            description: [
                `You are about to delete the message in <#${record.channelId}>.`,
                '',
                'This action cannot be undone.',
            ].join('\n'),
            color: 0xED4245,
            fields: [{ name: 'Message ID', value: `\`${record.messageId}\`` }],
        }],
        components: [
            new ActionRowBuilder().addComponents(
                makeButton(`${PREFIX}delete_confirm:${record.messageId}`, 'Confirm Delete', ButtonStyle.Danger, '🗑️'),
                makeButton(`${PREFIX}delete_cancel:${record.messageId}`, 'Cancel', ButtonStyle.Secondary),
            ),
        ],
    };
}

function getSelectedChannel(interaction) {
    const selected = interaction.fields.getSelectedChannels(
        IDS.channel,
        true,
        [ChannelType.GuildText, ChannelType.GuildAnnouncement],
    );
    return selected?.first() || null;
}

function readInput(interaction, customId) {
    return interaction.fields.getTextInputValue(customId) ?? '';
}

async function updateFromModal(interaction, draft) {
    saveDraft(interaction, draft);
    const payload = buildDraftPreview(draft);

    if (interaction.message && typeof interaction.update === 'function') {
        return interaction.update(payload);
    }

    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

async function sendPrivateError(interaction, title, description) {
    const payload = {
        embeds: [{
            title,
            description: String(description || 'An unexpected error occurred.').slice(0, 4000),
            color: 0xED4245,
        }],
        components: [],
        flags: MessageFlags.Ephemeral,
    };

    if (interaction.deferred || interaction.replied) {
        return interaction.followUp(payload).catch(() => null);
    }
    return interaction.reply(payload).catch(() => null);
}

async function canUsePanel(interaction) {
    if (!interaction.inGuild?.() || !interaction.guildId || !interaction.guild) {
        await sendPrivateError(interaction, 'Message Manager', 'This feature can only be used inside a server.');
        return false;
    }

    const allowed = await getMessageManagerAccess(interaction);
    if (!allowed) {
        await sendPrivateError(
            interaction,
            'Access Denied',
            'You do not have access to Message Manager. Ask a server Administrator or Manage Server administrator to add one of your roles using `/message set`.',
        );
        return false;
    }

    return true;
}

async function canConfigureRoles(interaction) {
    if (!interaction.inGuild?.() || !interaction.guildId || !interaction.guild) {
        await sendPrivateError(interaction, 'Message Settings', 'This feature can only be used inside a server.');
        return false;
    }

    if (!(await requireMessageSettingsPermission(interaction))) {
        await sendPrivateError(interaction, 'Access Denied', 'Only members with Administrator or Manage Server permission can configure Message Manager roles.');
        return false;
    }

    return true;
}

async function beginCreate(interaction, type) {
    const draft = {
        token: makeToken(),
        guildId: interaction.guildId,
        userId: interaction.user.id,
        mode: 'create',
        type,
        channelId: '',
        content: '',
        embed: {
            title: '',
            description: '',
            color: MESSAGE_MANAGER_DEFAULT_EMBED_COLOR,
            url: '',
            authorName: '',
            authorUrl: '',
            authorIconUrl: '',
            footerText: '',
            footerIconUrl: '',
            thumbnailUrl: '',
            imageUrl: '',
        },
        messageId: null,
        updatedAt: Date.now(),
    };

    saveDraft(interaction, draft);
    return interaction.showModal(type === 'regular'
        ? buildRegularCreateModal(draft)
        : buildEmbedCreateModal(draft));
}

async function beginEdit(interaction, record, updateCurrentMessage = true) {
    const draft = {
        token: makeToken(),
        guildId: interaction.guildId,
        userId: interaction.user.id,
        mode: 'edit',
        type: record.type,
        channelId: record.channelId,
        content: record.content || '',
        embed: record.type === 'embed'
            ? { ...record.embed, color: record.embed?.color || MESSAGE_MANAGER_DEFAULT_EMBED_COLOR }
            : {
                title: '',
                description: '',
                color: MESSAGE_MANAGER_DEFAULT_EMBED_COLOR,
                url: '',
                authorName: '',
                authorUrl: '',
                authorIconUrl: '',
                footerText: '',
                footerIconUrl: '',
                thumbnailUrl: '',
                imageUrl: '',
            },
        messageId: record.messageId,
        originalRecord: record,
        updatedAt: Date.now(),
    };

    saveDraft(interaction, draft);
    const payload = buildDraftPreview(draft);
    if (updateCurrentMessage) return interaction.update(payload);
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

async function showManageList(interaction, update = true) {
    const messages = await getManagedMessages(interaction.client, interaction.guildId, 25);
    const payload = buildManageList(messages);
    if (update) return interaction.update(payload);
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

function createRecordFromDraft(draft, userId) {
    const now = new Date().toISOString();
    return normalizeMessageRecord({
        messageId: draft.messageId || 'pending-message-id',
        channelId: draft.channelId,
        type: draft.type,
        content: draft.type === 'regular' ? validateRegularMessage(draft.content) : '',
        embed: draft.type === 'embed' ? validateEmbedData(draft.embed) : null,
        createdBy: draft.mode === 'edit' ? draft.originalRecord?.createdBy : userId,
        createdAt: draft.mode === 'edit' ? draft.originalRecord?.createdAt : now,
        updatedBy: userId,
        updatedAt: now,
    });
}

async function confirmDraft(interaction, token) {
    const draft = getDraft(interaction, token);
    if (!draft) throw new Error('This editor session expired. Run `/message panel` to start again.');

    const record = createRecordFromDraft(draft, interaction.user.id);
    const channel = await interaction.guild.channels.fetch(record.channelId).catch(() => null);
    await assertCanSendManagedMessage(channel, interaction.guild, record.type, draft.mode === 'edit');

    if (draft.mode === 'create') {
        const payloadRecord = { ...record, messageId: 'pending-message-id' };
        const sent = await channel.send(buildManagedMessagePayload(payloadRecord));
        const savedRecord = { ...record, messageId: sent.id };

        try {
            await saveManagedMessage(interaction.client, interaction.guildId, savedRecord);
        } catch (error) {
            await sent.delete().catch(() => null);
            throw new Error(`The message could not be saved to the database, so the sent message was removed. ${error.message}`);
        }

        deleteDraft(interaction, token);
        return interaction.update({
            embeds: [{
                title: 'Message Sent Successfully',
                description: `Your ${record.type === 'embed' ? 'Embed Message' : 'Regular Message'} was sent to ${channel}.\n\nMessage ID: \`${sent.id}\``,
                color: 0x57F287,
            }],
            components: [],
        });
    }

    const original = draft.originalRecord || await getManagedMessage(interaction.client, interaction.guildId, draft.messageId);
    if (!original || original.messageId !== draft.messageId) {
        throw new Error('The managed message record could not be found. It may have been removed.');
    }

    const message = await channel.messages.fetch(draft.messageId).catch(() => null);
    if (!message || message.author?.id !== interaction.client.user?.id) {
        throw new Error('The original bot message is unavailable or is no longer owned by this bot.');
    }

    const updatedRecord = { ...record, messageId: original.messageId, channelId: original.channelId, createdBy: original.createdBy, createdAt: original.createdAt };
    await saveManagedMessage(interaction.client, interaction.guildId, updatedRecord);

    try {
        await message.edit(buildManagedMessagePayload(updatedRecord));
    } catch (error) {
        await saveManagedMessage(interaction.client, interaction.guildId, original).catch(() => null);
        throw error;
    }

    deleteDraft(interaction, token);
    return interaction.update({
        embeds: [{
            title: 'Message Updated Successfully',
            description: `The original message in ${channel} has been updated. No duplicate message was created.`,
            color: 0x57F287,
        }],
        components: [],
    });
}

async function deleteManagedMessageFlow(interaction, messageId) {
    const record = await getManagedMessage(interaction.client, interaction.guildId, messageId);
    if (!record) throw new Error('This message is no longer registered in Message Manager.');

    const channel = await interaction.guild.channels.fetch(record.channelId).catch(() => null);
    if (!channel) {
        await removeManagedMessage(interaction.client, interaction.guildId, messageId);
        return interaction.update({
            embeds: [{ title: 'Managed Record Removed', description: 'The original channel no longer exists. The stale Message Manager record has been removed.', color: 0x57F287 }],
            components: [],
        });
    }

    const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
    const permissions = me ? channel.permissionsFor(me) : null;
    if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions?.has(PermissionFlagsBits.ReadMessageHistory)) {
        throw new Error('The bot needs View Channel and Read Message History permission to locate the original message before deleting it.');
    }

    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (message && message.author?.id !== interaction.client.user?.id) {
        throw new Error('The selected message is not owned by this bot, so it will not be deleted.');
    }

    await removeManagedMessage(interaction.client, interaction.guildId, messageId);
    try {
        if (message) await message.delete();
    } catch (error) {
        await saveManagedMessage(interaction.client, interaction.guildId, record).catch(() => null);
        throw error;
    }

    return interaction.update({
        embeds: [{
            title: 'Message Deleted',
            description: message ? `The message in ${channel} and its Message Manager record have been deleted.` : 'The original message was already missing. Its Message Manager record has been removed.',
            color: 0x57F287,
        }],
        components: [],
    });
}

function roleNames(guild, roleIds) {
    if (!roleIds.length) return 'No additional roles are configured. Only Administrator and Manage Server can use Message Manager.';
    return roleIds.map(id => {
        const role = guild.roles.cache.get(id);
        return role ? role.toString() : `<@&${id}>`;
    }).join('\n').slice(0, 3500);
}

function buildRoleSettingsPanel(guild, selectedRoleIds, status = '') {
    const validIds = [...new Set((selectedRoleIds || []).map(String))].filter(id => id !== guild.id);
    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId(`${PREFIX}role_select`)
        .setPlaceholder('Select one or more roles')
        .setMinValues(1)
        .setMaxValues(25);

    if (validIds.length) roleSelect.setDefaultRoles(...validIds);

    return {
        embeds: [{
            title: 'MESSAGE MANAGER • ACCESS SETTINGS',
            description: [
                'Choose the roles that are allowed to use `/message panel`.',
                'Members need at least one selected role. Administrator and Manage Server always retain access.',
                '',
                '**Currently selected roles**',
                roleNames(guild, validIds),
                status ? `\n\n${status}` : '',
            ].join('\n'),
            color: Number.parseInt(MESSAGE_MANAGER_DEFAULT_EMBED_COLOR.slice(1), 16),
        }],
        components: [
            new ActionRowBuilder().addComponents(roleSelect),
            new ActionRowBuilder().addComponents(
                makeButton(`${PREFIX}role_save`, 'Save Changes', ButtonStyle.Success, '💾'),
                makeButton(`${PREFIX}role_reset`, 'Reset to Admin / Manage Server Only', ButtonStyle.Danger),
            ),
        ],
    };
}

async function openRoleSettings(interaction, update = false, status = '') {
    const existingDraft = getRoleDraft(interaction);
    const roleIds = existingDraft?.roleIds || await getAllowedMessageRoles(interaction.client, interaction.guildId);
    setRoleDraft(interaction, roleIds);

    const payload = buildRoleSettingsPanel(interaction.guild, roleIds, status);
    if (update) return interaction.update(payload);
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

async function handleRoleSettingsComponent(interaction) {
    if (!(await canConfigureRoles(interaction))) return;

    if (interaction.customId === `${PREFIX}role_select`) {
        const selected = [...new Set((interaction.values || []).map(String))].filter(id => id !== interaction.guildId);
        setRoleDraft(interaction, selected);
        return interaction.update(buildRoleSettingsPanel(interaction.guild, selected, 'Selection updated. Press Save Changes to apply it.'));
    }

    if (interaction.customId === `${PREFIX}role_save`) {
        const draft = getRoleDraft(interaction);
        if (!draft) throw new Error('This role settings session expired. Run `/message set` again.');
        const existingRoles = await interaction.guild.roles.fetch().catch(() => interaction.guild.roles.cache);
        const validRoleIds = draft.roleIds.filter(id => existingRoles.has(id) && id !== interaction.guildId);
        await setAllowedMessageRoles(interaction.client, interaction.guildId, validRoleIds);
        setRoleDraft(interaction, validRoleIds);
        return interaction.update(buildRoleSettingsPanel(
            interaction.guild,
            validRoleIds,
            '✅ Role access settings have been saved.',
        ));
    }

    if (interaction.customId === `${PREFIX}role_reset`) {
        await setAllowedMessageRoles(interaction.client, interaction.guildId, []);
        setRoleDraft(interaction, []);
        return interaction.update(buildRoleSettingsPanel(
            interaction.guild,
            [],
            '✅ Access roles cleared. Only Administrator and Manage Server can use Message Manager.',
        ));
    }
}

async function handleModal(interaction) {
    const [action, token] = interaction.customId.slice(PREFIX.length).split(':');
    if (!token) throw new Error('Invalid Message Manager form session.');

    if (!(await canUsePanel(interaction))) return;
    const draft = getDraft(interaction, token);
    if (!draft) throw new Error('This editor session expired. Run `/message panel` to start again.');

    if (action === 'modal_regular') {
        const channel = getSelectedChannel(interaction);
        if (!channel) throw new Error('Please select a destination channel.');
        draft.channelId = channel.id;
        draft.content = validateRegularMessage(readInput(interaction, IDS.regularContent));
    } else if (action === 'modal_embed') {
        const channel = getSelectedChannel(interaction);
        if (!channel) throw new Error('Please select a destination channel.');
        draft.channelId = channel.id;
        draft.embed = validateEmbedData({
            ...draft.embed,
            title: readInput(interaction, IDS.embedTitle),
            description: readInput(interaction, IDS.embedDescription),
            color: readInput(interaction, IDS.embedColor) || MESSAGE_MANAGER_DEFAULT_EMBED_COLOR,
        });
    } else if (action === 'modal_content') {
        if (draft.type === 'regular') {
            draft.content = validateRegularMessage(readInput(interaction, IDS.regularContent));
        } else {
            draft.embed = validateEmbedData({
                ...draft.embed,
                title: readInput(interaction, IDS.embedTitle),
                description: readInput(interaction, IDS.embedDescription),
            });
        }
    } else if (action === 'modal_appearance') {
        draft.embed = validateEmbedData({
            ...draft.embed,
            color: readInput(interaction, IDS.embedColor) || draft.embed.color || MESSAGE_MANAGER_DEFAULT_EMBED_COLOR,
            url: readInput(interaction, IDS.embedUrl),
        });
    } else if (action === 'modal_identity') {
        draft.embed = validateEmbedData({
            ...draft.embed,
            authorName: readInput(interaction, IDS.authorName),
            authorUrl: readInput(interaction, IDS.authorUrl),
            authorIconUrl: readInput(interaction, IDS.authorIcon),
            footerText: readInput(interaction, IDS.footerText),
            footerIconUrl: readInput(interaction, IDS.footerIcon),
        });
    } else if (action === 'modal_media') {
        draft.embed = validateEmbedData({
            ...draft.embed,
            thumbnailUrl: readInput(interaction, IDS.thumbnailUrl),
            imageUrl: readInput(interaction, IDS.imageUrl),
        });
    } else {
        throw new Error('Unknown Message Manager form.');
    }

    return updateFromModal(interaction, draft);
}

async function handlePublicEdit(interaction) {
    if (!(await canUsePanel(interaction))) return;

    const publicMessage = interaction.message;
    if (!publicMessage || publicMessage.author?.id !== interaction.client.user?.id) {
        throw new Error('This Edit button is not attached to a message sent by this bot.');
    }

    const record = await getManagedMessage(interaction.client, interaction.guildId, publicMessage.id);
    if (!record) {
        throw new Error('This message is no longer registered in Message Manager. It cannot be edited from this button.');
    }

    const channel = interaction.channel;
    if (!channel || channel.id !== record.channelId) {
        throw new Error('The original message channel could not be verified.');
    }

    return beginEdit(interaction, record, false);
}

async function handleComponent(interaction) {
    if (!(await canUsePanel(interaction))) return;

    const id = interaction.customId;
    if (id === IDS.homeRegular) return beginCreate(interaction, 'regular');
    if (id === IDS.homeEmbed) return beginCreate(interaction, 'embed');
    if (id === IDS.homeManage) return showManageList(interaction, true);
    if (id === `${PREFIX}back_home`) return interaction.update(buildHomePanel());
    if (id === `${PREFIX}manage_back`) return showManageList(interaction, true);

    if (id === `${PREFIX}manage_pick`) {
        const messageId = interaction.values?.[0];
        if (!messageId) throw new Error('Please select a message.');
        const record = await getManagedMessage(interaction.client, interaction.guildId, messageId);
        if (!record) throw new Error('That message is no longer registered.');
        return interaction.update(buildSelectedMessagePanel(record));
    }

    if (id.startsWith(`${PREFIX}manage_edit:`)) {
        const messageId = id.split(':')[1];
        const record = await getManagedMessage(interaction.client, interaction.guildId, messageId);
        if (!record) throw new Error('That message is no longer registered.');
        return beginEdit(interaction, record, true);
    }

    if (id.startsWith(`${PREFIX}manage_delete:`)) {
        const messageId = id.split(':')[1];
        const record = await getManagedMessage(interaction.client, interaction.guildId, messageId);
        if (!record) throw new Error('That message is no longer registered.');
        return interaction.update(buildDeleteConfirmation(record));
    }

    if (id.startsWith(`${PREFIX}delete_confirm:`)) {
        return deleteManagedMessageFlow(interaction, id.split(':')[1]);
    }

    if (id.startsWith(`${PREFIX}delete_cancel:`)) {
        return showManageList(interaction, true);
    }

    if (id.startsWith(`${PREFIX}edit_content:`)) {
        const token = id.split(':')[1];
        const draft = getDraft(interaction, token);
        if (!draft) throw new Error('This editor session expired. Run `/message panel` to start again.');
        return interaction.showModal(draft.type === 'regular'
            ? buildRegularEditModal(draft)
            : buildEmbedContentModal(draft));
    }

    if (id.startsWith(`${PREFIX}edit_appearance:`)) {
        const token = id.split(':')[1];
        const draft = getDraft(interaction, token);
        if (!draft || draft.type !== 'embed') throw new Error('This Embed editor session expired.');
        return interaction.showModal(buildAppearanceModal(draft));
    }

    if (id.startsWith(`${PREFIX}edit_identity:`)) {
        const token = id.split(':')[1];
        const draft = getDraft(interaction, token);
        if (!draft || draft.type !== 'embed') throw new Error('This Embed editor session expired.');
        return interaction.showModal(buildIdentityModal(draft));
    }

    if (id.startsWith(`${PREFIX}edit_media:`)) {
        const token = id.split(':')[1];
        const draft = getDraft(interaction, token);
        if (!draft || draft.type !== 'embed') throw new Error('This Embed editor session expired.');
        return interaction.showModal(buildMediaModal(draft));
    }

    if (id.startsWith(`${PREFIX}reset_color:`)) {
        const token = id.split(':')[1];
        const draft = getDraft(interaction, token);
        if (!draft || draft.type !== 'embed') throw new Error('This Embed editor session expired.');
        draft.embed = validateEmbedData({ ...draft.embed, color: MESSAGE_MANAGER_DEFAULT_EMBED_COLOR });
        saveDraft(interaction, draft);
        return interaction.update(buildDraftPreview(draft));
    }

    if (id.startsWith(`${PREFIX}confirm:`)) {
        return confirmDraft(interaction, id.split(':')[1]);
    }

    if (id.startsWith(`${PREFIX}cancel:`)) {
        const token = id.split(':')[1];
        deleteDraft(interaction, token);
        return interaction.update({
            embeds: [{
                title: 'Message Editor Cancelled',
                description: 'No message was sent or changed.',
                color: 0x747F8D,
            }],
            components: [],
        });
    }

    return false;
}

export function isMessageManagerInteraction(interaction) {
    return typeof interaction?.customId === 'string'
        && interaction.customId.startsWith(PREFIX);
}

export async function handleMessageManagerInteraction(interaction) {
    if (!isMessageManagerInteraction(interaction)) return false;

    try {
        if (interaction.isRoleSelectMenu?.() || interaction.customId === `${PREFIX}role_save` || interaction.customId === `${PREFIX}role_reset`) {
            await handleRoleSettingsComponent(interaction);
            return true;
        }

        if (interaction.customId === IDS.publicEdit) {
            await handlePublicEdit(interaction);
            return true;
        }

        if (interaction.isModalSubmit?.()) {
            await handleModal(interaction);
            return true;
        }

        if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
            await handleComponent(interaction);
            return true;
        }

        return false;
    } catch (error) {
        logger.error('Message Manager interaction failed:', error);
        await sendPrivateError(interaction, 'Message Manager Error', error.message || 'An unexpected error occurred.');
        return true;
    }
}

export default {
    data: new SlashCommandBuilder()
        .setName('message')
        .setDescription('Open the SKAW Message Manager.')
        .addSubcommand(subcommand => subcommand
            .setName('panel')
            .setDescription('Open the Message Manager panel to create or manage bot messages.'))
        .addSubcommand(subcommand => subcommand
            .setName('set')
            .setDescription('Configure which roles can access Message Manager.')),

    async execute(interaction) {
        try {
            if (!interaction.inGuild()) {
                return sendPrivateError(interaction, 'Message Manager', 'This command can only be used inside a server.');
            }

            const subcommand = interaction.options.getSubcommand();
            if (subcommand === 'set') {
                if (!(await canConfigureRoles(interaction))) return;
                return openRoleSettings(interaction, false);
            }

            if (subcommand === 'panel') {
                if (!(await canUsePanel(interaction))) return;
                return interaction.reply({ ...buildHomePanel(), flags: MessageFlags.Ephemeral });
            }
        } catch (error) {
            logger.error('Message Manager command failed:', error);
            return sendPrivateError(interaction, 'Message Manager Error', error.message || 'Could not open Message Manager.');
        }
    },
};
