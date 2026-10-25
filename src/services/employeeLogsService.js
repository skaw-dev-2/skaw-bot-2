import { randomUUID } from 'node:crypto';
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';

const CONFIG_KEY = guildId => `guild:${guildId}:employee_logs`;
const AUDIT_KEY = guildId => `guild:${guildId}:employee_logs:audit`;
const BRAND_BLUE = 0x2563eb;
const FOOTER_TEXT = 'SKAW GROUP • PEOPLE OPERATIONS';
const SNOWFLAKE_RE = /^\d{17,20}$/;

export const EMPLOYEE_LOG_TYPES = Object.freeze({
    sign_in: { label: 'Employee Sign In', shortLabel: 'Sign In', title: 'EMPLOYEE SIGN-IN RECORD', emoji: '🟢', subtitle: 'OFFICIAL PERSONNEL RECORD · DUTY COMMENCEMENT', channelLabel: 'Sign In channel', roleFields: ['position'], bannerEvent: 'employee-sign-in', actorLabel: 'Recorded by' },
    sign_out: { label: 'Employee Sign Out', shortLabel: 'Sign Out', title: 'EMPLOYEE SIGN-OUT RECORD', emoji: '🔵', subtitle: 'OFFICIAL PERSONNEL RECORD · DUTY COMPLETION', channelLabel: 'Sign Out channel', roleFields: ['position'], bannerEvent: 'employee-sign-out', actorLabel: 'Recorded by' },
    promotion: { label: 'Employee Promotion Letter', shortLabel: 'Promotion', title: 'EMPLOYEE PROMOTION NOTICE', emoji: '🏆', subtitle: 'CAREER DEVELOPMENT · OFFICIAL RECORD', channelLabel: 'Promotion channel', roleFields: ['previousRank', 'newRank'], bannerEvent: 'promotion', actorLabel: 'Issued by' },
    demote: { label: 'Employee Demotion Notice', shortLabel: 'Demote', title: 'EMPLOYEE DEMOTION NOTICE', emoji: '🔻', subtitle: 'RANK ADJUSTMENT · OFFICIAL RECORD', channelLabel: 'Demotion channel', roleFields: ['previousRank', 'newRank'], bannerEvent: 'demotion', actorLabel: 'Issued by' },
    dismissal: { label: 'Employee Dismissal Notice', shortLabel: 'Dismissal', title: 'EMPLOYEE DISMISSAL NOTICE', emoji: '⛔', subtitle: 'EMPLOYMENT STATUS · OFFICIAL RECORD', channelLabel: 'Dismissal channel', roleFields: ['position'], bannerEvent: 'dismissal', actorLabel: 'Issued by' },
    resignation: { label: 'Employee Resignation Record', shortLabel: 'Resignation', title: 'EMPLOYEE RESIGNATION RECORD', emoji: '📄', subtitle: 'EMPLOYMENT STATUS · OFFICIAL RECORD', channelLabel: 'Resignation channel', roleFields: ['position'], bannerEvent: 'employee-resignation', actorLabel: 'Recorded by' },
    mutation: { label: 'Employee Mutation Notice', shortLabel: 'Mutation', title: 'EMPLOYEE MUTATION NOTICE', emoji: '🔄', subtitle: 'POSITION TRANSFER · OFFICIAL RECORD', channelLabel: 'Mutation channel', roleFields: ['fromRole', 'toRole'], bannerEvent: 'mutation', actorLabel: 'Recorded by' },
    warning: { label: 'Employee Warning Notice', shortLabel: 'Warning', title: 'EMPLOYEE WARNING NOTICE', emoji: '⚠️', subtitle: 'CONDUCT & COMPLIANCE · OFFICIAL RECORD', channelLabel: 'Warning channel', roleFields: ['position'], bannerEvent: 'warning', actorLabel: 'Issued by' },
    blacklist: { label: 'Personnel Blacklist Record', shortLabel: 'Blacklist', title: 'PERSONNEL BLACKLIST RECORD', emoji: '🛡️', subtitle: 'COMPLIANCE & SECURITY · RESTRICTED RECORD', channelLabel: 'Blacklist channel', roleFields: ['position'], bannerEvent: 'blacklist', actorLabel: 'Issued by' },
    others: { label: 'Other Employee Activity', shortLabel: 'Others', title: 'PERSONNEL ACTIVITY RECORD', emoji: '📝', subtitle: 'GENERAL ADMINISTRATION · CUSTOM RECORD', channelLabel: 'Others channel', roleFields: ['position'], bannerEvent: 'employee-other', actorLabel: 'Recorded by' },
});

export const EMPLOYEE_LOG_BANNER_EVENTS = Object.freeze({
    'employee-sign-in': { label: 'Employee • Sign In' },
    'employee-sign-out': { label: 'Employee • Sign Out' },
    'employee-resignation': { label: 'Employee • Resignation' },
    'employee-other': { label: 'Employee • Others' },
    promotion: { label: 'Promotion' },
    demotion: { label: 'Demotion' },
    mutation: { label: 'Mutation' },
    dismissal: { label: 'Dismissal' },
    warning: { label: 'Warning' },
    blacklist: { label: 'Blacklist' },
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
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
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

const EMOJI = Object.freeze({
    signIn: String.fromCodePoint(0x1F7E2),
    signOut: String.fromCodePoint(0x1F535),
    promotion: String.fromCodePoint(0x1F3C6),
    demotion: String.fromCodePoint(0x1F53B),
    dismissal: String.fromCodePoint(0x26D4, 0xFE0F),
    resignation: String.fromCodePoint(0x1F4C4),
    mutation: String.fromCodePoint(0x1F504),
    warning: String.fromCodePoint(0x26A0, 0xFE0F),
    blacklist: String.fromCodePoint(0x1F6E1, 0xFE0F),
    others: String.fromCodePoint(0x1F4DD),
    person: String.fromCodePoint(0x1F464),
    building: String.fromCodePoint(0x1F3E2),
    pin: String.fromCodePoint(0x1F4CC),
    note: String.fromCodePoint(0x1F5D2, 0xFE0F),
    clipboard: String.fromCodePoint(0x1F4CB),
    rank: String.fromCodePoint(0x1F539),
    arrow: String.fromCodePoint(0x27A1, 0xFE0F),
    recorded: String.fromCodePoint(0x1F4DD),
});

const TITLE_EMOJI = Object.freeze({
    sign_in: EMOJI.signIn,
    sign_out: EMOJI.signOut,
    promotion: EMOJI.promotion,
    demote: EMOJI.demotion,
    dismissal: EMOJI.dismissal,
    resignation: EMOJI.resignation,
    mutation: EMOJI.mutation,
    warning: EMOJI.warning,
    blacklist: EMOJI.blacklist,
    others: EMOJI.others,
});

export function buildEmployeeLogBody(type, data = {}) {
    const template = EMPLOYEE_LOG_TYPES[type];
    if (!template) throw new Error('Jenis log tidak valid.');
    const name = userMention(data.userId);
    const person = `${EMOJI.person} **Employee:** ${name}`;
    const position = `${EMOJI.building} **Position:** ${roleMention(data.position, 'Position')}`;
    const lines = [];

    if (type === 'sign_in' || type === 'sign_out') {
        lines.push(person, position);
    } else if (type === 'resignation') {
        lines.push(person, position, `${EMOJI.pin} **Reason:** ${cleanText(data.reason, 'Resignation reason', { maxLength: 850 })}`);
    } else if (type === 'promotion' || type === 'demote') {
        if (data.previousRank === data.newRank) throw new Error('Previous Rank dan New Rank tidak boleh sama.');
        lines.push(
            person,
            `${EMOJI.rank} **Previous Rank:** ${roleMention(data.previousRank, 'Previous Rank')}`,
            `${type === 'promotion' ? EMOJI.promotion : EMOJI.demotion} **New Rank:** ${roleMention(data.newRank, 'New Rank')}`,
        );
        if (type === 'demote') lines.push(`${EMOJI.pin} **Reason:** ${cleanText(data.reason, 'Demotion reason', { maxLength: 850 })}`);
    } else if (type === 'mutation') {
        if (data.fromRole === data.toRole) throw new Error('Role asal dan tujuan mutation tidak boleh sama.');
        lines.push(
            person,
            `${EMOJI.rank} **Previous Position:** ${roleMention(data.fromRole, 'Previous Position')}`,
            `${EMOJI.arrow} **New Position:** ${roleMention(data.toRole, 'New Position')}`,
        );
    } else if (type === 'dismissal' || type === 'blacklist') {
        lines.push(
            `${EMOJI.person} **Individual:** ${name}`,
            `${EMOJI.building} **Last Known Position:** ${roleMention(data.position, 'Position')}`,
            `${EMOJI.pin} **${type === 'blacklist' ? 'Blacklist Reason' : 'Dismissal Reason'}:** ${cleanText(data.reason, 'Reason', { maxLength: 900 })}`,
        );
    } else if (type === 'warning') {
        const warn = cleanText(data.warn, 'Warning Level', { maxLength: 10 });
        if (!/^([1-9]\d?)\/([1-9]\d?)$/.test(warn)) throw new Error('Warning Level harus berformat seperti 1/2.');
        const [current, maximum] = warn.split('/').map(Number);
        if (current > maximum) throw new Error('Angka pertama Warning Level tidak boleh lebih besar dari angka kedua.');
        lines.push(
            person,
            position,
            `${EMOJI.warning} **Warning Level:** ${warn}`,
            `${EMOJI.pin} **Reason:** ${cleanText(data.reason, 'Warning reason', { maxLength: 850 })}`,
        );
    } else if (type === 'others') {
        lines.push(
            `${EMOJI.clipboard} **Activity:** ${cleanText(data.activityTitle, 'Activity title', { maxLength: 80 })}`,
            person,
            position,
            `${EMOJI.pin} **Activity Details:** ${cleanText(data.activityDescription, 'Activity details', { maxLength: 850 })}`,
        );
    } else {
        throw new Error('Template employee log belum tersedia.');
    }
    return lines.join('\n');
}

function getActivitySummary(type) {
    const summaries = {
        sign_in: "Official record confirming the employee's commencement of duty.",
        sign_out: "Official record confirming the completion of the employee's duty.",
        promotion: "Official notice documenting an employee's career advancement within SKAW GROUP.",
        demote: "Official notice documenting an employee's rank reduction within SKAW GROUP.",
        dismissal: "Official notice documenting an employee's dismissal.",
        resignation: "Official record documenting an employee's resignation.",
        mutation: "Official record documenting an employee's position transfer.",
        warning: "Official notice regarding employee conduct and compliance.",
        blacklist: "Restricted personnel record maintained for compliance and security reference.",
        others: "Official record of an additional personnel activity registered by SKAW Management.",
    };
    return summaries[type] || 'Official personnel record maintained by SKAW Management.';
}

export function buildEmployeeLogEmbed(type, data = {}, bannerUrl = null) {
    const template = EMPLOYEE_LOG_TYPES[type];
    if (!template) throw new Error('Jenis log tidak valid.');

    const now = data.recordedAt ? new Date(data.recordedAt) : new Date();
    if (Number.isNaN(now.getTime())) throw new Error('Waktu pencatatan tidak valid.');
    const recordId = cleanText(data.recordId || createEmployeeLogRecordId(now), 'Record ID', { maxLength: 64 });
    const activityTitle = type === 'others'
        ? cleanText(data.activityTitle, 'Activity title', { maxLength: 80 })
        : template.title;
    // Build Unicode icons from code points at runtime rather than relying on an
    // editor's literal emoji encoding. Native embed title provides the heading.
    const title = `${TITLE_EMOJI[type]} ${activityTitle}`;
    const separator = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    const lines = [
        `-# ${template.subtitle}`,
        getActivitySummary(type),
        separator,
        `**${EMOJI.clipboard} RECORD INFORMATION**`,
        ...buildEmployeeLogBody(type, data).split('\n'),
    ];

    const notes = cleanText(data.notes, 'Notes', { required: false, maxLength: 900 });
    if (notes) {
        lines.push(
            separator,
            `**${EMOJI.note} ADDITIONAL NOTES**`,
            notes,
        );
    }

    lines.push(
        separator,
        'Regards,',
        '**SKAW Management.**',
        `-# ${EMOJI.recorded} ${template.actorLabel} ${actorMention(data)}`,
    );

    const description = lines.join('\n');
    if (description.length > 4096) throw new Error('Isi log terlalu panjang untuk embed Discord. Ringkas deskripsi atau Notes.');

    const safeBanner = normalizeBannerUrl(bannerUrl);
    const footer = `${FOOTER_TEXT} • ${recordId} • ${formatTimestampWIB(now)}`;
    const embed = new EmbedBuilder()
        .setColor(BRAND_BLUE)
        .setAuthor({ name: 'SKAW GROUP · PEOPLE OPERATIONS' })
        .setTitle(title)
        .setDescription(description)
        .setFooter({ text: footer });

    // Keep the explicit WIB timestamp in the footer. A second native timestamp
    // is deliberately omitted so readers do not see duplicate time metadata.
    if (safeBanner) embed.setImage(safeBanner);
    return embed;
}

function isStickerSpecificDiscordError(error) {
    const code = Number(error?.code ?? error?.rawError?.code);
    return code === 10014 || code === 50035 || code === 50024 || code === 50013;
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
