import { PermissionFlagsBits, EmbedBuilder } from 'discord.js';

const CONFIG_KEY = (guildId) => `guild:${guildId}:employee_logs`;
const BRAND_BLUE = 0x2563eb;
const FOOTER_TEXT = 'SKAW GROUP • PEOPLE OPERATIONS';
const SNOWFLAKE_RE = /^\d{17,20}$/;

export const EMPLOYEE_LOG_TYPES = Object.freeze({
    employee: {
        label: 'Employee Activity Record',
        shortLabel: 'Employee Logs',
        title: 'EMPLOYEE ACTIVITY RECORD',
        emoji: '📋',
        subtitle: 'WORKFORCE • ACTIVITY REGISTER',
        channelLabel: 'Employee logs channel',
        roleFields: ['position'],
        textForm: 'employee',
    },
    promotion: {
        label: 'Employee Promotion Letter',
        shortLabel: 'Promotion',
        title: 'EMPLOYEE PROMOTION LETTER',
        emoji: '🏆',
        subtitle: 'PEOPLE OPERATIONS • CAREER ADVANCEMENT',
        channelLabel: 'Promotion channel',
        roleFields: ['previousRank', 'nextRank'],
        textForm: null,
    },
    mutation: {
        label: 'Employee Mutation Record',
        shortLabel: 'Mutation',
        title: 'EMPLOYEE MUTATION RECORD',
        emoji: '🔄',
        subtitle: 'WORKFORCE • POSITION CHANGE',
        channelLabel: 'Mutation channel',
        roleFields: ['fromRole', 'toRole'],
        textForm: 'mutation',
    },
    blacklist: {
        label: 'Employee Blacklist Notice',
        shortLabel: 'Blacklist',
        title: 'EMPLOYEE BLACKLIST NOTICE',
        emoji: '🛡️',
        subtitle: 'COMPLIANCE • RESTRICTED PERSONNEL RECORD',
        channelLabel: 'Blacklist channel',
        roleFields: ['position'],
        textForm: 'reason',
    },
    dismissal: {
        label: 'Employee Dismissal Notice',
        shortLabel: 'Dismissal',
        title: 'EMPLOYEE DISMISSAL NOTICE',
        emoji: '⛔',
        subtitle: 'PEOPLE OPERATIONS • EMPLOYMENT STATUS',
        channelLabel: 'Dismissal channel',
        roleFields: ['position'],
        textForm: 'reason',
    },
    warning: {
        label: 'Employee Warning Notice',
        shortLabel: 'Warning',
        title: 'EMPLOYEE WARNING NOTICE',
        emoji: '⚠️',
        subtitle: 'COMPLIANCE • EMPLOYEE CONDUCT RECORD',
        channelLabel: 'Warning channel',
        roleFields: ['position'],
        textForm: 'warning',
    },
});

/** Banner overrides are independent for each employee activity and record type. */
export const EMPLOYEE_LOG_BANNER_EVENTS = Object.freeze({
    'employee-sign-in': { label: 'Employee • Sign In' },
    'employee-sign-out': { label: 'Employee • Sign Out' },
    'employee-resignation': { label: 'Employee • Personal Resignation' },
    'employee-other': { label: 'Employee • Other Activity' },
    promotion: { label: 'Promotion' },
    mutation: { label: 'Mutation' },
    blacklist: { label: 'Blacklist' },
    dismissal: { label: 'Dismissal' },
    warning: { label: 'Warning' },
});

const DEFAULT_CONFIG = Object.freeze({ channels: {}, bannerUrl: null, banners: {}, stickers: {} });

function normalizeBannerUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
        const url = new URL(value.trim());
        if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
        return url.toString();
    } catch {
        return null;
    }
}

function normalizeConfig(input = {}) {
    const channels = {};
    const stickers = {};
    const banners = {};
    if (input?.channels && typeof input.channels === 'object') {
        for (const type of Object.keys(EMPLOYEE_LOG_TYPES)) {
            const channelId = input.channels[type];
            if (typeof channelId === 'string' && SNOWFLAKE_RE.test(channelId)) channels[type] = channelId;
        }
    }
    if (input?.stickers && typeof input.stickers === 'object') {
        for (const type of Object.keys(EMPLOYEE_LOG_TYPES)) {
            const stickerId = input.stickers[type];
            if (typeof stickerId === 'string' && SNOWFLAKE_RE.test(stickerId)) stickers[type] = stickerId;
        }
    }
    if (input?.banners && typeof input.banners === 'object') {
        for (const eventKey of Object.keys(EMPLOYEE_LOG_BANNER_EVENTS)) {
            const url = normalizeBannerUrl(input.banners[eventKey]);
            if (url) banners[eventKey] = url;
        }
    }
    return {
        channels,
        stickers,
        bannerUrl: normalizeBannerUrl(input.bannerUrl),
        banners,
        updatedAt: input.updatedAt || null,
        updatedBy: input.updatedBy || null,
    };
}

export async function getEmployeeLogsConfig(client, guildId) {
    if (!client?.db || !guildId) return normalizeConfig(DEFAULT_CONFIG);
    const raw = await client.db.get(CONFIG_KEY(guildId), DEFAULT_CONFIG);
    return normalizeConfig(raw);
}

async function saveConfig(client, guildId, config, updatedBy = null) {
    if (!client?.db) throw new Error('Database belum siap. Coba lagi setelah bot tersambung ke database.');
    config.updatedAt = new Date().toISOString();
    config.updatedBy = updatedBy ? String(updatedBy) : null;
    await client.db.set(CONFIG_KEY(guildId), config);
    return config;
}

export async function setEmployeeLogsChannel(client, guildId, type, channelId, updatedBy = null) {
    if (!Object.hasOwn(EMPLOYEE_LOG_TYPES, type)) throw new Error('Jenis employee log tidak dikenal.');
    if (!SNOWFLAKE_RE.test(String(channelId || ''))) throw new Error('Channel ID tidak valid.');
    const config = await getEmployeeLogsConfig(client, guildId);
    config.channels[type] = String(channelId);
    return saveConfig(client, guildId, config, updatedBy);
}

export async function clearEmployeeLogsChannel(client, guildId, type, updatedBy = null) {
    if (!Object.hasOwn(EMPLOYEE_LOG_TYPES, type)) throw new Error('Jenis employee log tidak dikenal.');
    const config = await getEmployeeLogsConfig(client, guildId);
    delete config.channels[type];
    return saveConfig(client, guildId, config, updatedBy);
}

export async function setEmployeeLogsBanner(client, guildId, bannerUrl, updatedBy = null) {
    if (!client?.db) throw new Error('Database belum siap. Coba lagi setelah bot tersambung ke database.');
    const url = normalizeBannerUrl(String(bannerUrl || ''));
    if (!url) throw new Error('URL banner tidak valid. Gunakan URL gambar HTTPS langsung, misalnya gambar dari Discord CDN.');
    const config = await getEmployeeLogsConfig(client, guildId);
    config.bannerUrl = url;
    return saveConfig(client, guildId, config, updatedBy);
}

export async function clearEmployeeLogsBanner(client, guildId, updatedBy = null) {
    const config = await getEmployeeLogsConfig(client, guildId);
    config.bannerUrl = null;
    return saveConfig(client, guildId, config, updatedBy);
}

export async function setEmployeeLogsEventBanner(client, guildId, eventKey, bannerUrl, updatedBy = null) {
    if (!Object.hasOwn(EMPLOYEE_LOG_BANNER_EVENTS, eventKey)) throw new Error('Jenis event banner tidak dikenal.');
    const url = normalizeBannerUrl(String(bannerUrl || ''));
    if (!url) throw new Error('URL banner tidak valid. Gunakan URL gambar HTTPS langsung, misalnya gambar dari Discord CDN.');
    const config = await getEmployeeLogsConfig(client, guildId);
    config.banners[eventKey] = url;
    return saveConfig(client, guildId, config, updatedBy);
}

export async function clearEmployeeLogsEventBanner(client, guildId, eventKey, updatedBy = null) {
    if (!Object.hasOwn(EMPLOYEE_LOG_BANNER_EVENTS, eventKey)) throw new Error('Jenis event banner tidak dikenal.');
    const config = await getEmployeeLogsConfig(client, guildId);
    delete config.banners[eventKey];
    return saveConfig(client, guildId, config, updatedBy);
}

/** Determine the banner variation from the actual employee activity text. */
export function getEmployeeLogBannerEventKey(type, data = {}) {
    if (type !== 'employee') {
        if (!Object.hasOwn(EMPLOYEE_LOG_TYPES, type)) throw new Error('Jenis log tidak valid.');
        return type;
    }

    const activity = String(data.logs || '').normalize('NFKC').toLowerCase().replace(/[–—]/g, '-');
    if (/\b(sign[\s_-]*in|signed[\s_-]*in|log[\s_-]*in|logged[\s_-]*in|login|clock[\s_-]*in)\b/.test(activity)) {
        return 'employee-sign-in';
    }
    if (/\b(sign[\s_-]*out|signed[\s_-]*out|log[\s_-]*out|logged[\s_-]*out|logout|clock[\s_-]*out)\b/.test(activity)) {
        return 'employee-sign-out';
    }
    if (/\b(resign(?:ation|ed)?|personal[\s_-]+resignation|quit(?:ting)?)\b/.test(activity)) {
        return 'employee-resignation';
    }
    return 'employee-other';
}

/** Per-event banner wins; the legacy global banner remains as a fallback. */
export function resolveEmployeeLogsBanner(config, type, data = {}) {
    const eventKey = getEmployeeLogBannerEventKey(type, data);
    return config?.banners?.[eventKey] || config?.bannerUrl || null;
}

export async function setEmployeeLogsSticker(client, guildId, type, stickerId, updatedBy = null) {
    if (!Object.hasOwn(EMPLOYEE_LOG_TYPES, type)) throw new Error('Jenis employee log tidak dikenal.');
    if (!SNOWFLAKE_RE.test(String(stickerId || ''))) throw new Error('Sticker ID tidak valid. Gunakan ID sticker server Discord berupa angka.');
    const config = await getEmployeeLogsConfig(client, guildId);
    config.stickers[type] = String(stickerId);
    return saveConfig(client, guildId, config, updatedBy);
}

export async function clearEmployeeLogsSticker(client, guildId, type, updatedBy = null) {
    if (!Object.hasOwn(EMPLOYEE_LOG_TYPES, type)) throw new Error('Jenis employee log tidak dikenal.');
    const config = await getEmployeeLogsConfig(client, guildId);
    delete config.stickers[type];
    return saveConfig(client, guildId, config, updatedBy);
}

function requiredMention(id, label) {
    if (!SNOWFLAKE_RE.test(String(id || ''))) throw new Error(`${label} tidak valid.`);
    return String(id);
}

function cleanText(value, label, { required = true, maxLength = 1000 } = {}) {
    const text = String(value ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
    if (required && !text) throw new Error(`${label} wajib diisi.`);
    if (text.length > maxLength) throw new Error(`${label} maksimal ${maxLength} karakter.`);
    if (/@everyone\b|@here\b/i.test(text)) throw new Error(`${label} tidak boleh menggunakan @everyone atau @here.`);
    return text;
}

function mentionUser(id) { return `<@${requiredMention(id, 'Anggota')}>`; }
function mentionRole(id, label) { return `<@&${requiredMention(id, label)}>`; }

export function buildEmployeeLogBody(type, data) {
    const template = EMPLOYEE_LOG_TYPES[type];
    if (!template) throw new Error('Jenis log tidak valid.');
    const name = mentionUser(data.userId);

    if (type === 'employee') {
        const position = mentionRole(data.position, 'Position');
        const rawLogs = cleanText(data.logs, 'Activity', { maxLength: 800 });
        const logs = /[.!?]$/.test(rawLogs) ? rawLogs : `${rawLogs}.`;
        return `> Name : ${name}\n> Position : ${position}\n> Activity : ${logs}`;
    }
    if (type === 'promotion') {
        const previousRank = mentionRole(data.previousRank, 'Previous Rank');
        const nextRank = mentionRole(data.nextRank, 'New Rank');
        if (previousRank === nextRank) throw new Error('Previous Rank dan New Rank tidak boleh sama.');
        return `> Name : ${name}\n> Previous Rank : ${previousRank}\n> New Rank : ${nextRank}`;
    }
    if (type === 'mutation') {
        const fromRole = mentionRole(data.fromRole, 'Previous Position');
        const toRole = mentionRole(data.toRole, 'New Position');
        if (fromRole === toRole) throw new Error('Role asal dan tujuan mutation tidak boleh sama.');
        const defaultLogs = `Requested by ${name} for a position mutation.`;
        const logs = cleanText(data.logs || defaultLogs, 'Mutation details', { required: false, maxLength: 800 }) || defaultLogs;
        return `> Name : ${name}\n> Previous Position : ${fromRole}\n> New Position : ${toRole}\n> Mutation Details : ${logs}`;
    }
    if (type === 'blacklist' || type === 'dismissal') {
        const position = mentionRole(data.position, 'Position');
        const reason = cleanText(data.reason, 'Reason', { maxLength: 900 });
        return `> Name : ${name}\n> Position : ${position}\n> Reason : ${reason}`;
    }
    if (type === 'warning') {
        const position = mentionRole(data.position, 'Position');
        const warn = cleanText(data.warn, 'Warning Level', { maxLength: 10 });
        if (!/^([1-9]\d?)\/([1-9]\d?)$/.test(warn)) throw new Error('Warning Level harus berformat seperti 1/2.');
        const [current, maximum] = warn.split('/').map(Number);
        if (current > maximum) throw new Error('Angka pertama Warning Level tidak boleh lebih besar dari angka kedua.');
        const reason = cleanText(data.reason, 'Reason', { maxLength: 850 });
        return `> Name : ${name}\n> Position : ${position}\n> Warning Level : ${warn}\n> Reason : ${reason}`;
    }
    throw new Error('Template employee log belum tersedia.');
}

/** Plain-text preview retained for tooling and backwards compatibility. */
export function buildEmployeeLogMessage(type, data) {
    const template = EMPLOYEE_LOG_TYPES[type];
    return `__**${template?.emoji || '📑'} ${template?.title || 'EMPLOYEE LOG'}**__\n\n${buildEmployeeLogBody(type, data)}\n\nRegards,\n__**SKAW Management**__.`;
}

function recordedByValue(data) {
    if (typeof data.recordedBy === 'string' && SNOWFLAKE_RE.test(data.recordedBy)) return `<@${data.recordedBy}>`;
    return 'Not recorded';
}

function safeFieldValue(value, maxLength = 1024) {
    const text = String(value ?? '').trim();
    return (text || '—').slice(0, maxLength);
}

/** Build the branded corporate embed used for all production logs. */
export function buildEmployeeLogEmbed(type, data, bannerUrl = null) {
    const template = EMPLOYEE_LOG_TYPES[type];
    if (!template) throw new Error('Jenis log tidak valid.');

    const employee = mentionUser(data.userId);
    const actor = recordedByValue(data);
    const embed = new EmbedBuilder()
        .setColor(BRAND_BLUE)
        .setAuthor({ name: 'SKAW GROUP  •  PEOPLE OPERATIONS' })
        .setTitle(`${template.emoji}  ${template.title}`)
        .setDescription(`**${template.subtitle}**\nOfficial personnel record maintained by SKAW Management.`)
        .setFooter({ text: FOOTER_TEXT })
        .setTimestamp(new Date());

    if (type === 'employee') {
        embed.addFields(
            { name: '👤  EMPLOYEE', value: employee, inline: true },
            { name: '🏷️  POSITION', value: mentionRole(data.position, 'Position'), inline: true },
            { name: '📌  ACTIVITY', value: safeFieldValue(cleanText(data.logs, 'Activity', { maxLength: 800 })), inline: false },
            { name: '🧾  RECORDED BY', value: actor, inline: true },
        );
    } else if (type === 'promotion') {
        const previousRank = mentionRole(data.previousRank, 'Previous Rank');
        const nextRank = mentionRole(data.nextRank, 'New Rank');
        if (previousRank === nextRank) throw new Error('Previous Rank dan New Rank tidak boleh sama.');
        embed.addFields(
            { name: '👤  EMPLOYEE', value: employee, inline: true },
            { name: '🪪  PREVIOUS RANK', value: previousRank, inline: true },
            { name: '🏆  NEW RANK', value: nextRank, inline: true },
            { name: '✅  ISSUED BY', value: actor, inline: true },
            { name: '📣  MESSAGE', value: 'Congratulations on your promotion. We wish you continued success in your new role.', inline: false },
        );
    } else if (type === 'mutation') {
        const fromRole = mentionRole(data.fromRole, 'Previous Position');
        const toRole = mentionRole(data.toRole, 'New Position');
        if (fromRole === toRole) throw new Error('Role asal dan tujuan mutation tidak boleh sama.');
        const defaultLogs = `Requested by ${employee} for a position mutation.`;
        const logs = cleanText(data.logs || defaultLogs, 'Mutation details', { required: false, maxLength: 800 }) || defaultLogs;
        embed.addFields(
            { name: '👤  EMPLOYEE', value: employee, inline: true },
            { name: '📍  PREVIOUS POSITION', value: fromRole, inline: true },
            { name: '🧭  NEW POSITION', value: toRole, inline: true },
            { name: '📝  MUTATION DETAILS', value: safeFieldValue(logs), inline: false },
            { name: '🧾  RECORDED BY', value: actor, inline: true },
        );
    } else if (type === 'blacklist' || type === 'dismissal') {
        const position = mentionRole(data.position, 'Position');
        const reason = cleanText(data.reason, 'Reason', { maxLength: 900 });
        embed.addFields(
            { name: '👤  EMPLOYEE', value: employee, inline: true },
            { name: '🏷️  POSITION', value: position, inline: true },
            { name: type === 'blacklist' ? '🛡️  BLACKLIST REASON' : '⛔  DISMISSAL REASON', value: safeFieldValue(reason), inline: false },
            { name: '🧾  ISSUED BY', value: actor, inline: true },
        );
        if (type === 'blacklist') embed.addFields({ name: '🔒  RECORD STATUS', value: 'Filed in the SKAW personnel compliance record.', inline: false });
        else embed.addFields({ name: '📁  RECORD STATUS', value: 'Employment dismissal notice recorded by SKAW Management.', inline: false });
    } else if (type === 'warning') {
        const position = mentionRole(data.position, 'Position');
        const warn = cleanText(data.warn, 'Warning Level', { maxLength: 10 });
        if (!/^([1-9]\d?)\/([1-9]\d?)$/.test(warn)) throw new Error('Warning Level harus berformat seperti 1/2.');
        const [current, maximum] = warn.split('/').map(Number);
        if (current > maximum) throw new Error('Angka pertama Warning Level tidak boleh lebih besar dari angka kedua.');
        const reason = cleanText(data.reason, 'Reason', { maxLength: 850 });
        embed.addFields(
            { name: '👤  EMPLOYEE', value: employee, inline: true },
            { name: '🏷️  POSITION', value: position, inline: true },
            { name: '⚠️  WARNING LEVEL', value: `**${warn}**`, inline: true },
            { name: '📋  REASON / OBSERVATION', value: safeFieldValue(reason), inline: false },
            { name: '🧾  ISSUED BY', value: actor, inline: true },
            { name: '📌  ACKNOWLEDGEMENT', value: 'Please comply with SKAW policies and the requirements of your role.', inline: false },
        );
    }

    const safeBannerUrl = normalizeBannerUrl(bannerUrl);
    if (safeBannerUrl) embed.setImage(safeBannerUrl);
    return embed;
}

function isStickerSpecificDiscordError(error) {
    const code = Number(error?.code ?? error?.rawError?.code);
    return code === 50035 || code === 50024 || code === 50013;
}

export async function sendEmployeeLog(client, guild, type, data) {
    const template = EMPLOYEE_LOG_TYPES[type];
    if (!template) throw new Error('Jenis log tidak valid.');

    const config = await getEmployeeLogsConfig(client, guild.id);
    const channelId = config.channels[type];
    if (!channelId) throw new Error(`Channel ${template.shortLabel} belum diatur. Jalankan /employee-logs set-channel.`);

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased?.() || channel.isDMBased?.() || channel.guildId !== guild.id) {
        throw new Error(`Channel ${template.shortLabel} tidak ditemukan atau bukan channel teks di server ini. Atur ulang dengan /employee-logs set-channel.`);
    }

    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const permissions = channel.permissionsFor(botMember || client.user);
    const requiredPermissions = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks;
    if (!permissions?.has(requiredPermissions)) {
        throw new Error(`Bot membutuhkan izin View Channel, Send Messages, dan Embed Links di ${channel}.`);
    }

    const bannerUrl = resolveEmployeeLogsBanner(config, type, data);
    const embed = buildEmployeeLogEmbed(type, data, bannerUrl);
    const allowedMentions = { parse: [] };
    const stickerId = config.stickers[type];
    if (stickerId) {
        try {
            const message = await channel.send({ embeds: [embed], stickers: [stickerId], allowedMentions });
            return { channel, message, template, stickerSent: true, stickerWarning: null };
        } catch (error) {
            if (!isStickerSpecificDiscordError(error)) throw error;
            // Sticker delivery is optional: never lose the official record if a sticker is unavailable or blocked.
            const message = await channel.send({ embeds: [embed], allowedMentions });
            return { channel, message, template, stickerSent: false, stickerWarning: 'Sticker tidak dapat dikirim; embed log tetap terkirim.' };
        }
    }

    const message = await channel.send({ embeds: [embed], allowedMentions });
    return { channel, message, template, stickerSent: false, stickerWarning: null };
}
