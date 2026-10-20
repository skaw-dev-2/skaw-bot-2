import { randomUUID } from 'node:crypto';
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';

const CONFIG_KEY = guildId => `guild:${guildId}:employee_logs`;
const AUDIT_KEY = guildId => `guild:${guildId}:employee_logs:audit`;
const BRAND_BLUE = 0x2563eb;
const FOOTER_TEXT = 'SKAW GROUP • PEOPLE OPERATIONS';
const SNOWFLAKE_RE = /^\d{17,20}$/;

export const EMPLOYEE_LOG_TYPES = Object.freeze({
    sign_in: { label: 'Employee Sign In', shortLabel: 'Sign In', title: 'EMPLOYEE SIGN IN RECORD', emoji: '🟢', subtitle: 'WORKFORCE • DUTY COMMENCEMENT', channelLabel: 'Sign In channel', roleFields: ['position'], bannerEvent: 'employee-sign-in' },
    sign_out: { label: 'Employee Sign Out', shortLabel: 'Sign Out', title: 'EMPLOYEE SIGN OUT RECORD', emoji: '🔵', subtitle: 'WORKFORCE • DUTY COMPLETION', channelLabel: 'Sign Out channel', roleFields: ['position'], bannerEvent: 'employee-sign-out' },
    promotion: { label: 'Employee Promotion Letter', shortLabel: 'Promotion', title: 'EMPLOYEE PROMOTION LETTER', emoji: '🏆', subtitle: 'PEOPLE OPERATIONS • CAREER ADVANCEMENT', channelLabel: 'Promotion channel', roleFields: ['previousRank', 'nextRank'], bannerEvent: 'promotion' },
    dismissal: { label: 'Employee Dismissal Notice', shortLabel: 'Dismissal', title: 'EMPLOYEE DISMISSAL NOTICE', emoji: '⛔', subtitle: 'PEOPLE OPERATIONS • EMPLOYMENT STATUS', channelLabel: 'Dismissal channel', roleFields: ['position'], bannerEvent: 'dismissal' },
    resignation: { label: 'Employee Resignation Record', shortLabel: 'Resignation', title: 'EMPLOYEE RESIGNATION RECORD', emoji: '📄', subtitle: 'PEOPLE OPERATIONS • VOLUNTARY DEPARTURE', channelLabel: 'Resignation channel', roleFields: ['position'], bannerEvent: 'employee-resignation' },
    mutation: { label: 'Employee Mutation Record', shortLabel: 'Mutation', title: 'EMPLOYEE MUTATION RECORD', emoji: '🔄', subtitle: 'WORKFORCE • POSITION CHANGE', channelLabel: 'Mutation channel', roleFields: ['fromRole', 'toRole'], bannerEvent: 'mutation' },
    warning: { label: 'Employee Warning Notice', shortLabel: 'Warning', title: 'EMPLOYEE WARNING NOTICE', emoji: '⚠️', subtitle: 'COMPLIANCE • EMPLOYEE CONDUCT RECORD', channelLabel: 'Warning channel', roleFields: ['position'], bannerEvent: 'warning' },
    blacklist: { label: 'Employee Blacklist Notice', shortLabel: 'Blacklist', title: 'EMPLOYEE BLACKLIST NOTICE', emoji: '🛡️', subtitle: 'COMPLIANCE • RESTRICTED PERSONNEL RECORD', channelLabel: 'Blacklist channel', roleFields: ['position'], bannerEvent: 'blacklist' },
    others: { label: 'Other Employee Activity', shortLabel: 'Others', title: 'EMPLOYEE ACTIVITY RECORD', emoji: '📝', subtitle: 'PEOPLE OPERATIONS • ADDITIONAL RECORD', channelLabel: 'Others channel', roleFields: ['position'], bannerEvent: 'employee-other' },
});

export const EMPLOYEE_LOG_BANNER_EVENTS = Object.freeze({
    'employee-sign-in': { label: 'Employee • Sign In' },
    'employee-sign-out': { label: 'Employee • Sign Out' },
    'employee-resignation': { label: 'Employee • Resignation' },
    'employee-other': { label: 'Employee • Others' },
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
    } catch { return null; }
}

function normalizeConfig(input = {}) {
    const channels = {};
    const stickers = {};
    const banners = {};
    const oldEmployeeChannel = typeof input?.channels?.employee === 'string' && SNOWFLAKE_RE.test(input.channels.employee) ? input.channels.employee : null;
    const oldEmployeeSticker = typeof input?.stickers?.employee === 'string' && SNOWFLAKE_RE.test(input.stickers.employee) ? input.stickers.employee : null;
    for (const type of Object.keys(EMPLOYEE_LOG_TYPES)) {
        const channelId = input?.channels?.[type];
        if (typeof channelId === 'string' && SNOWFLAKE_RE.test(channelId)) channels[type] = channelId;
        else if (oldEmployeeChannel && ['sign_in', 'sign_out', 'resignation', 'others'].includes(type)) channels[type] = oldEmployeeChannel;
        const stickerId = input?.stickers?.[type];
        if (typeof stickerId === 'string' && SNOWFLAKE_RE.test(stickerId)) stickers[type] = stickerId;
        else if (oldEmployeeSticker && ['sign_in', 'sign_out', 'resignation', 'others'].includes(type)) stickers[type] = oldEmployeeSticker;
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
export async function setEmployeeLogsBanner(client, guildId, urlValue, updatedBy = null) {
    const url = normalizeBannerUrl(String(urlValue || ''));
    if (!url) throw new Error('URL banner tidak valid. Gunakan URL gambar HTTPS langsung.');
    const config = await getEmployeeLogsConfig(client, guildId);
    config.bannerUrl = url;
    return saveConfig(client, guildId, config, updatedBy);
}
export async function clearEmployeeLogsBanner(client, guildId, updatedBy = null) {
    const config = await getEmployeeLogsConfig(client, guildId);
    config.bannerUrl = null;
    return saveConfig(client, guildId, config, updatedBy);
}
export async function setEmployeeLogsEventBanner(client, guildId, eventKey, urlValue, updatedBy = null) {
    if (!Object.hasOwn(EMPLOYEE_LOG_BANNER_EVENTS, eventKey)) throw new Error('Jenis event banner tidak dikenal.');
    const url = normalizeBannerUrl(String(urlValue || ''));
    if (!url) throw new Error('URL banner tidak valid. Gunakan URL gambar HTTPS langsung.');
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
export async function setEmployeeLogsSticker(client, guildId, type, stickerId, updatedBy = null) {
    if (!Object.hasOwn(EMPLOYEE_LOG_TYPES, type)) throw new Error('Jenis employee log tidak dikenal.');
    if (!SNOWFLAKE_RE.test(String(stickerId || ''))) throw new Error('Sticker ID tidak valid.');
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
export function getEmployeeLogBannerEventKey(type) {
    const template = EMPLOYEE_LOG_TYPES[type];
    if (!template) throw new Error('Jenis log tidak valid.');
    return template.bannerEvent;
}
export function resolveEmployeeLogsBanner(config, type) {
    const eventKey = getEmployeeLogBannerEventKey(type);
    return config?.banners?.[eventKey] || config?.bannerUrl || null;
}

function cleanText(value, label, { required = true, maxLength = 1000 } = {}) {
    const text = String(value ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
    if (required && !text) throw new Error(`${label} wajib diisi.`);
    if (text.length > maxLength) throw new Error(`${label} maksimal ${maxLength} karakter.`);
    if (/@everyone\b|@here\b/i.test(text)) throw new Error(`${label} tidak boleh menggunakan @everyone atau @here.`);
    return text;
}
function validId(value, label) {
    if (!SNOWFLAKE_RE.test(String(value || ''))) throw new Error(`${label} tidak valid.`);
    return String(value);
}
function userMention(id) { return `<@${validId(id, 'Employee')}>`; }
function roleMention(id, label) { return `<@&${validId(id, label)}>`; }
function actorMention(data) { return SNOWFLAKE_RE.test(String(data.recordedBy || '')) ? `<@${data.recordedBy}>` : 'Not recorded'; }

function formatTimestampWIB(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return 'Time unavailable';
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Jakarta',
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
    return `${parts} WIB`;
}

export function createEmployeeLogRecordId(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const datePart = `${fields.year}${fields.month}${fields.day}`;
    const suffix = cryptoRandomSuffix();
    return `SKAW-EL-${datePart}-${suffix}`;
}

function cryptoRandomSuffix() {
    return randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
}

export function buildEmployeeLogBody(type, data = {}) {
    const template = EMPLOYEE_LOG_TYPES[type];
    if (!template) throw new Error('Jenis log tidak valid.');
    const name = userMention(data.userId);
    let lines;
    if (type === 'sign_in' || type === 'sign_out') {
        lines = [
            `👤 **Employee:** ${name}`,
            `🏢 **Position:** ${roleMention(data.position, 'Position')}`,
            `📝 **Recorded By:** ${actorMention(data)}`,
        ];
    } else if (type === 'resignation') {
        lines = [
            `👤 **Employee:** ${name}`,
            `🏢 **Position:** ${roleMention(data.position, 'Position')}`,
            `📌 **Reason:** ${cleanText(data.reason, 'Resignation reason', { maxLength: 850 })}`,
            `📝 **Recorded By:** ${actorMention(data)}`,
        ];
    } else if (type === 'promotion') {
        if (data.previousRank === data.nextRank) throw new Error('Previous Rank dan New Rank tidak boleh sama.');
        lines = [
            `👤 **Employee:** ${name}`,
            `⬆️ **Previous Rank:** ${roleMention(data.previousRank, 'Previous Rank')}`,
            `🏆 **New Rank:** ${roleMention(data.nextRank, 'New Rank')}`,
            `📝 **Recorded By:** ${actorMention(data)}`,
        ];
    } else if (type === 'mutation') {
        if (data.fromRole === data.toRole) throw new Error('Role asal dan tujuan mutation tidak boleh sama.');
        lines = [
            `👤 **Employee:** ${name}`,
            `◽ **Previous Position:** ${roleMention(data.fromRole, 'Previous Position')}`,
            `🔄 **New Position:** ${roleMention(data.toRole, 'New Position')}`,
            `📝 **Recorded By:** ${actorMention(data)}`,
        ];
    } else if (type === 'dismissal' || type === 'blacklist') {
        lines = [
            `👤 **Individual:** ${name}`,
            `🏢 **Last Known Position:** ${roleMention(data.position, 'Position')}`,
            `📌 **Reason:** ${cleanText(data.reason, 'Reason', { maxLength: 900 })}`,
            `📝 **Issued By:** ${actorMention(data)}`,
        ];
    } else if (type === 'warning') {
        const warn = cleanText(data.warn, 'Warning Level', { maxLength: 10 });
        if (!/^([1-9]\d?)\/([1-9]\d?)$/.test(warn)) throw new Error('Warning Level harus berformat seperti 1/2.');
        const [current, maximum] = warn.split('/').map(Number);
        if (current > maximum) throw new Error('Angka pertama Warning Level tidak boleh lebih besar dari angka kedua.');
        lines = [
            `👤 **Employee:** ${name}`,
            `🏢 **Position:** ${roleMention(data.position, 'Position')}`,
            `⚠️ **Warning Level:** ${warn}`,
            `📌 **Reason:** ${cleanText(data.reason, 'Reason', { maxLength: 850 })}`,
            `📝 **Issued By:** ${actorMention(data)}`,
        ];
    } else if (type === 'others') {
        lines = [
            `🏷️ **Activity:** ${cleanText(data.activityTitle, 'Activity title', { maxLength: 80 })}`,
            `👤 **Employee:** ${name}`,
            `🏢 **Position:** ${roleMention(data.position, 'Position')}`,
            '',
            '**📌 ACTIVITY DETAILS**',
            cleanText(data.activityDescription, 'Activity details', { maxLength: 850 }),
            '',
            `📝 **Recorded By:** ${actorMention(data)}`,
        ];
    } else {
        throw new Error('Template employee log belum tersedia.');
    }
    return lines.join('\n');
}

function getActivitySummary(type) {
    const summaries = {
        sign_in: "This record confirms the employee's commencement of duty.",
        sign_out: "This record documents the completion of the employee's duty period.",
        promotion: 'This notice formally records a career advancement within SKAW GROUP.',
        dismissal: 'This notice records an employee status change for official personnel administration.',
        resignation: 'This record documents an employee resignation from their position.',
        mutation: 'This record documents an updated organizational assignment.',
        warning: 'This notice documents a formal employee warning for compliance records.',
        blacklist: 'This record documents a blacklist decision maintained for SKAW GROUP compliance and administrative purposes.',
        others: 'This entry documents an additional personnel activity registered by SKAW Management.',
    };
    return summaries[type] || 'Official personnel record maintained by SKAW Management.';
}

export function buildEmployeeLogEmbed(type, data = {}, bannerUrl = null) {
    const template = EMPLOYEE_LOG_TYPES[type];
    if (!template) throw new Error('Jenis log tidak valid.');
    const now = data.recordedAt ? new Date(data.recordedAt) : new Date();
    const recordId = cleanText(data.recordId || createEmployeeLogRecordId(now), 'Record ID', { maxLength: 64 });
    const title = type === 'others'
        ? `📝 ${cleanText(data.activityTitle, 'Activity title', { maxLength: 80 })}`
        : `${template.emoji} ${template.title}`;
    const intro = getActivitySummary(type);
    const lines = [
        `**${template.subtitle}**`,
        '',
        intro,
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━',
        '',
        '**📋 RECORD INFORMATION**',
        '',
        buildEmployeeLogBody(type, data),
    ];
    const notes = cleanText(data.notes, 'Notes', { required: false, maxLength: 900 });
    if (notes) {
        lines.push('', '━━━━━━━━━━━━━━━━━━━━━━━━', '', '**🗒️ ADDITIONAL NOTES**', '', notes);
    }
    lines.push('', '━━━━━━━━━━━━━━━━━━━━━━━━', '', 'Regards,', '', '**SKAW Management.**');
    const description = lines.join('\n');
    if (description.length > 4096) throw new Error('Isi log terlalu panjang untuk embed Discord. Ringkas deskripsi atau Notes.');
    const embed = new EmbedBuilder()
        .setColor(BRAND_BLUE)
        .setAuthor({ name: 'SKAW GROUP  ·  PEOPLE OPERATIONS' })
        .setTitle(title.slice(0, 256))
        .setDescription(description)
        .setFooter({ text: `${FOOTER_TEXT}  •  ${recordId}  •  ${formatTimestampWIB(now)}`.slice(0, 2048) });
    const safeBanner = normalizeBannerUrl(bannerUrl);
    if (safeBanner) embed.setImage(safeBanner);
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
    if (!channelId) throw new Error(`Channel ${template.shortLabel} belum diatur. Admin perlu menjalankan /employee-logs set-channel.`);
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased?.() || channel.isDMBased?.() || channel.guildId !== guild.id) {
        throw new Error(`Channel ${template.shortLabel} tidak ditemukan atau bukan channel teks di server ini. Atur ulang dengan /employee-logs set-channel.`);
    }
    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const permissions = channel.permissionsFor(botMember || client.user);
    const required = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks;
    if (!permissions?.has(required)) throw new Error(`Bot membutuhkan izin View Channel, Send Messages, dan Embed Links di ${channel}.`);

    const publishedAt = new Date();
    const recordId = data.recordId || createEmployeeLogRecordId(publishedAt);
    const publishedData = { ...data, recordId, recordedAt: publishedAt, recordedBy: data.recordedBy || '' };
    const bannerUrl = resolveEmployeeLogsBanner(config, type);
    const embed = buildEmployeeLogEmbed(type, publishedData, bannerUrl);
    const allowedMentions = { parse: [] };
    const stickerId = config.stickers[type];
    let message;
    let stickerSent = false;
    let stickerWarning = null;
    if (stickerId) {
        try {
            message = await channel.send({ embeds: [embed], stickers: [stickerId], allowedMentions });
            stickerSent = true;
        } catch (error) {
            if (!isStickerSpecificDiscordError(error)) throw error;
            message = await channel.send({ embeds: [embed], allowedMentions });
            stickerWarning = 'Sticker tidak dapat dikirim; embed log tetap terkirim.';
        }
    } else {
        message = await channel.send({ embeds: [embed], allowedMentions });
    }
    try {
        const oldEntries = await client.db.get(AUDIT_KEY(guild.id), []);
        const history = Array.isArray(oldEntries) ? oldEntries : [];
        history.push({
            recordId,
            type,
            employeeId: String(data.userId || ''),
            recordedBy: String(data.recordedBy || ''),
            channelId: String(channel.id),
            messageId: String(message.id),
            publishedAt: publishedAt.toISOString(),
        });
        await client.db.set(AUDIT_KEY(guild.id), history.slice(-1000));
    } catch (auditError) {
        console.warn('[Employee Logs] Published record but could not persist the audit entry:', auditError?.message || auditError);
    }
    return { channel, message, template, recordId, publishedAt, stickerSent, stickerWarning };
}

export async function getEmployeeLogAudit(client, guildId, { type = null, limit = 10 } = {}) {
    if (!client?.db) throw new Error('Database belum siap.');
    const raw = await client.db.get(AUDIT_KEY(guildId), []);
    const entries = Array.isArray(raw) ? raw : [];
    const filtered = type ? entries.filter(entry => entry.type === type) : entries;
    return filtered.slice(-Math.max(1, Math.min(25, Number(limit) || 10))).reverse();
}

