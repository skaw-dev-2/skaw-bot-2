import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    PermissionFlagsBits,
    PermissionsBitField,
} from 'discord.js';

export const MESSAGE_MANAGER_DEFAULT_EMBED_COLOR = '#1500FF';
export const MESSAGE_MANAGER_PUBLIC_EDIT_CUSTOM_ID = 'skaw_mm_v1_public_edit';
export const MESSAGE_MANAGER_PUBLIC_EDIT_COMPONENTS = [
    new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(MESSAGE_MANAGER_PUBLIC_EDIT_CUSTOM_ID)
            .setLabel('Edit')
            .setEmoji('✏️')
            .setStyle(ButtonStyle.Secondary),
    ),
];

const STORAGE_KEY = (guildId) => `guild:${guildId}:message_manager`;
const MAX_STORED_MESSAGES = 250;
const MAX_REGULAR_MESSAGE_LENGTH = 2000;

function uniqueIds(values) {
    if (!Array.isArray(values)) return [];
    return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
        .filter(id => /^\d{17,20}$/.test(id));
}

function normalizeEmbedRecord(raw = {}) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
        title: String(source.title || '').trim(),
        description: String(source.description || ''),
        color: String(source.color || MESSAGE_MANAGER_DEFAULT_EMBED_COLOR).trim() || MESSAGE_MANAGER_DEFAULT_EMBED_COLOR,
        url: String(source.url || '').trim(),
        authorName: String(source.authorName || '').trim(),
        authorUrl: String(source.authorUrl || '').trim(),
        authorIconUrl: String(source.authorIconUrl || '').trim(),
        footerText: String(source.footerText || '').trim(),
        footerIconUrl: String(source.footerIconUrl || '').trim(),
        thumbnailUrl: String(source.thumbnailUrl || '').trim(),
        imageUrl: String(source.imageUrl || '').trim(),
    };
}

function normalizeMessageRecord(raw, fallbackId = '') {
    if (!raw || typeof raw !== 'object') return null;
    const messageId = String(raw.messageId || fallbackId || '').trim();
    const channelId = String(raw.channelId || '').trim();
    if (!messageId || !channelId) return null;

    const type = raw.type === 'embed' ? 'embed' : 'regular';
    return {
        messageId,
        channelId,
        type,
        content: type === 'regular' ? String(raw.content || '') : '',
        embed: type === 'embed' ? normalizeEmbedRecord(raw.embed) : null,
        createdBy: String(raw.createdBy || ''),
        createdAt: String(raw.createdAt || new Date().toISOString()),
        updatedBy: String(raw.updatedBy || raw.createdBy || ''),
        updatedAt: String(raw.updatedAt || raw.createdAt || new Date().toISOString()),
    };
}

function normalizeManagerData(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const messages = {};

    const entries = source.messages && typeof source.messages === 'object' && !Array.isArray(source.messages)
        ? Object.entries(source.messages)
        : [];

    for (const [messageId, value] of entries) {
        const record = normalizeMessageRecord(value, messageId);
        if (record) messages[record.messageId] = record;
    }

    return {
        allowedRoleIds: uniqueIds(source.allowedRoleIds),
        messages,
    };
}

function getPermissions(member, interaction) {
    const value = member?.permissions || interaction?.memberPermissions;
    if (value?.has) return value;

    try {
        return new PermissionsBitField(value ?? 0n);
    } catch {
        return new PermissionsBitField(0n);
    }
}

async function resolveGuildMember(interaction) {
    const cached = interaction.guild?.members?.cache?.get(interaction.user?.id);
    if (cached) return cached;

    if (interaction.guild?.members?.fetch && interaction.user?.id) {
        const fetched = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (fetched) return fetched;
    }

    return interaction.member || null;
}

export function memberCanManageMessageSettings(member, interaction = null) {
    const permissions = getPermissions(member, interaction);
    return permissions.has(PermissionFlagsBits.Administrator)
        || permissions.has(PermissionFlagsBits.ManageGuild);
}

export function memberHasAnyAllowedRole(member, roleIds = []) {
    const allowed = new Set(uniqueIds(roleIds));
    if (allowed.size === 0) return false;

    const roleCache = member?.roles?.cache;
    if (roleCache?.some) {
        return roleCache.some(role => allowed.has(role.id));
    }

    const roleArray = Array.isArray(member?.roles) ? member.roles.map(String) : [];
    return roleArray.some(roleId => allowed.has(roleId));
}

export async function getMessageManagerData(client, guildId) {
    if (!client?.db?.get) {
        throw new Error('The database is not available. Message Manager cannot load its configuration.');
    }

    const raw = await client.db.get(STORAGE_KEY(guildId), {});
    return normalizeManagerData(raw);
}

export async function saveMessageManagerData(client, guildId, value) {
    if (!client?.db?.set) {
        throw new Error('The database is not available. Message Manager changes cannot be saved.');
    }

    const normalized = normalizeManagerData(value);
    await client.db.set(STORAGE_KEY(guildId), normalized);
    return normalized;
}

export async function getMessageManagerAccess(interaction) {
    if (!interaction?.guildId || !interaction?.guild) return false;

    const member = await resolveGuildMember(interaction);
    if (memberCanManageMessageSettings(member, interaction)) return true;

    const data = await getMessageManagerData(interaction.client, interaction.guildId);
    return memberHasAnyAllowedRole(member, data.allowedRoleIds);
}

export async function requireMessageManagerAccess(interaction) {
    if (await getMessageManagerAccess(interaction)) return true;
    return false;
}

export async function requireMessageSettingsPermission(interaction) {
    if (!interaction?.guildId || !interaction?.guild) return false;
    const member = await resolveGuildMember(interaction);
    return memberCanManageMessageSettings(member, interaction);
}

export async function getAllowedMessageRoles(client, guildId) {
    const data = await getMessageManagerData(client, guildId);
    return data.allowedRoleIds;
}

export async function setAllowedMessageRoles(client, guildId, roleIds) {
    const data = await getMessageManagerData(client, guildId);
    data.allowedRoleIds = uniqueIds(roleIds);
    await saveMessageManagerData(client, guildId, data);
    return data.allowedRoleIds;
}

export function validateRegularMessage(content) {
    const value = String(content ?? '');
    if (!value.trim()) throw new Error('Message content cannot be empty.');
    if (value.length > MAX_REGULAR_MESSAGE_LENGTH) {
        throw new Error(`Regular messages must be ${MAX_REGULAR_MESSAGE_LENGTH} characters or fewer.`);
    }
    return value;
}

export function validateHexColor(value, fallback = MESSAGE_MANAGER_DEFAULT_EMBED_COLOR) {
    const color = String(value || '').trim() || fallback;
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
        throw new Error('Color must be a 6-digit HEX value, for example #1500FF.');
    }
    return color.toUpperCase();
}

export function validateOptionalHttpUrl(value, label = 'URL', maxLength = 2048) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.length > maxLength) throw new Error(`${label} is too long.`);

    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error(`${label} must be a valid HTTP or HTTPS URL.`);
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`${label} must use HTTP or HTTPS.`);
    }

    return raw;
}

export function validateEmbedData(raw = {}) {
    const embed = normalizeEmbedRecord(raw);
    if (!embed.description.trim()) throw new Error('Embed description is required.');
    if (embed.title.length > 256) throw new Error('Embed title cannot exceed 256 characters.');
    if (embed.description.length > 4096) throw new Error('Embed description cannot exceed 4096 characters.');
    if (embed.authorName.length > 256) throw new Error('Author name cannot exceed 256 characters.');
    if (embed.footerText.length > 2048) throw new Error('Footer text cannot exceed 2048 characters.');

    embed.color = validateHexColor(embed.color);
    embed.url = validateOptionalHttpUrl(embed.url, 'Embed URL');
    embed.authorUrl = validateOptionalHttpUrl(embed.authorUrl, 'Author URL');
    embed.authorIconUrl = validateOptionalHttpUrl(embed.authorIconUrl, 'Author icon URL');
    embed.footerIconUrl = validateOptionalHttpUrl(embed.footerIconUrl, 'Footer icon URL');
    embed.thumbnailUrl = validateOptionalHttpUrl(embed.thumbnailUrl, 'Thumbnail URL');
    embed.imageUrl = validateOptionalHttpUrl(embed.imageUrl, 'Image URL');

    if (embed.authorUrl && !embed.authorName) {
        throw new Error('Enter an Author Name before setting an Author URL.');
    }
    if (embed.authorIconUrl && !embed.authorName) {
        throw new Error('Enter an Author Name before setting an Author Icon URL.');
    }
    if (embed.footerIconUrl && !embed.footerText) {
        throw new Error('Enter Footer Text before setting a Footer Icon URL.');
    }

    return embed;
}

export function buildManagedEmbed(raw) {
    const data = validateEmbedData(raw);
    const embed = new EmbedBuilder()
        .setDescription(data.description)
        .setColor(Number.parseInt(data.color.slice(1), 16));

    if (data.title) embed.setTitle(data.title);
    if (data.url) embed.setURL(data.url);

    if (data.authorName) {
        embed.setAuthor({
            name: data.authorName,
            ...(data.authorUrl ? { url: data.authorUrl } : {}),
            ...(data.authorIconUrl ? { iconURL: data.authorIconUrl } : {}),
        });
    }

    if (data.footerText) {
        embed.setFooter({
            text: data.footerText,
            ...(data.footerIconUrl ? { iconURL: data.footerIconUrl } : {}),
        });
    }

    if (data.thumbnailUrl) embed.setThumbnail(data.thumbnailUrl);
    if (data.imageUrl) embed.setImage(data.imageUrl);

    return embed;
}

export function buildManagedMessagePayload(record) {
    const normalized = normalizeMessageRecord(record);
    if (!normalized) throw new Error('The managed message record is invalid.');

    const components = MESSAGE_MANAGER_PUBLIC_EDIT_COMPONENTS;
    const common = {
        components,
        allowedMentions: { parse: [] },
    };

    if (normalized.type === 'regular') {
        return {
            ...common,
            content: validateRegularMessage(normalized.content),
            embeds: [],
        };
    }

    return {
        ...common,
        content: '',
        embeds: [buildManagedEmbed(normalized.embed)],
    };
}

export async function getManagedMessage(client, guildId, messageId) {
    const data = await getMessageManagerData(client, guildId);
    return data.messages[String(messageId)] || null;
}

export async function getManagedMessages(client, guildId, limit = 25) {
    const data = await getMessageManagerData(client, guildId);
    return Object.values(data.messages)
        .sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt))
        .slice(0, Math.max(1, Math.min(25, Number(limit) || 25)));
}

export async function saveManagedMessage(client, guildId, record) {
    const normalizedRecord = normalizeMessageRecord(record);
    if (!normalizedRecord) throw new Error('Cannot save an invalid managed message.');

    const data = await getMessageManagerData(client, guildId);
    data.messages[normalizedRecord.messageId] = normalizedRecord;

    const ordered = Object.values(data.messages)
        .sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt))
        .slice(0, MAX_STORED_MESSAGES);
    data.messages = Object.fromEntries(ordered.map(item => [item.messageId, item]));

    await saveMessageManagerData(client, guildId, data);
    return normalizedRecord;
}

export async function removeManagedMessage(client, guildId, messageId) {
    const data = await getMessageManagerData(client, guildId);
    const record = data.messages[String(messageId)] || null;
    if (!record) return null;

    delete data.messages[String(messageId)];
    await saveMessageManagerData(client, guildId, data);
    return record;
}

export async function assertCanSendManagedMessage(channel, guild, type = 'regular') {
    if (!channel || !guild || !channel.isTextBased?.() || channel.isDMBased?.()) {
        throw new Error('The selected channel is unavailable or cannot receive messages.');
    }

    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me) throw new Error('Could not resolve the bot member to verify channel permissions.');

    const permissions = channel.permissionsFor(me);
    if (!permissions
        || !permissions.has(PermissionFlagsBits.ViewChannel)
        || !permissions.has(PermissionFlagsBits.SendMessages)
        || (type === 'embed' && !permissions.has(PermissionFlagsBits.EmbedLinks))) {
        const missing = [
            !permissions?.has(PermissionFlagsBits.ViewChannel) ? 'View Channel' : null,
            !permissions?.has(PermissionFlagsBits.SendMessages) ? 'Send Messages' : null,
            type === 'embed' && !permissions?.has(PermissionFlagsBits.EmbedLinks) ? 'Embed Links' : null,
        ].filter(Boolean);

        throw new Error(`I need ${missing.join(', ')} permission(s) in ${channel}.`);
    }

    return channel;
}

export async function persistNewManagedMessage(client, guildId, payload, metadata) {
    const now = new Date().toISOString();
    const record = normalizeMessageRecord({
        ...metadata,
        ...payload,
        createdAt: now,
        updatedAt: now,
        updatedBy: metadata.createdBy,
    });

    await saveManagedMessage(client, guildId, record);
    return record;
}
