import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits, escapeMarkdown } from 'discord.js';
import { upsertEmployeeDirectoryFromLog } from './employeeDirectoryService.js';

const CONFIG_KEY = guildId => `guild:${guildId}:employee_logs`;
const AUDIT_KEY = guildId => `guild:${guildId}:employee_logs:audit`;
const RECORD_KEY = (guildId, recordId) => `guild:${guildId}:employee_logs:record:${recordId}`;
const AUTO_ROLE_CONFIG_KEY = guildId => `guild:${guildId}:employee_logs:auto_role`;
const DIRECTORY_BACKFILL_KEY = guildId => `guild:${guildId}:employee_directory:backfill_v1`;
const directoryBackfills = new Map();
const BRAND_BLUE = 0x2563eb;
const SNOWFLAKE_RE = /^\d{17,20}$/;

export const EMPLOYEE_LOG_TYPES = Object.freeze({
    sign_in: { label: 'Employee Sign In', shortLabel: 'Sign In', title: 'EMPLOYEE SIGN-IN', emoji: '🟢', subtitle: 'OFFICIAL PERSONNEL RECORD', channelLabel: 'Sign In channel', roleFields: ['division', 'position'], bannerEvent: 'employee-sign-in', actorLabel: 'Recorded by' },
    sign_out: { label: 'Employee Sign Out', shortLabel: 'Sign Out', title: 'EMPLOYEE SIGN-OUT', emoji: '🔵', subtitle: 'OFFICIAL PERSONNEL RECORD', channelLabel: 'Sign Out channel', roleFields: ['division', 'position'], bannerEvent: 'employee-sign-out', actorLabel: 'Recorded by' },
    promotion: { label: 'Employee Promotion Letter', shortLabel: 'Promotion', title: 'EMPLOYEE PROMOTION', emoji: '🏆', subtitle: 'CAREER DEVELOPMENT', channelLabel: 'Promotion channel', roleFields: ['previousRank', 'newRank'], bannerEvent: 'promotion', actorLabel: 'Issued by' },
    demote: { label: 'Employee Demotion Notice', shortLabel: 'Demote', title: 'EMPLOYEE DEMOTION', emoji: '🔻', subtitle: 'PERSONNEL STATUS UPDATE', channelLabel: 'Demotion channel', roleFields: ['previousRank', 'newRank'], bannerEvent: 'demotion', actorLabel: 'Issued by' },
    dismissal: { label: 'Employee Dismissal Notice', shortLabel: 'Dismissal', title: 'EMPLOYEE DISMISSAL', emoji: '⛔', subtitle: 'EMPLOYMENT TERMINATION', channelLabel: 'Dismissal channel', roleFields: ['position'], bannerEvent: 'dismissal', actorLabel: 'Issued by' },
    resignation: { label: 'Employee Resignation Record', shortLabel: 'Resignation', title: 'EMPLOYEE RESIGNATION', emoji: '📄', subtitle: 'EMPLOYMENT STATUS UPDATE', channelLabel: 'Resignation channel', roleFields: ['position'], bannerEvent: 'employee-resignation', actorLabel: 'Recorded by' },
    mutation: { label: 'Employee Mutation Notice', shortLabel: 'Mutation', title: 'EMPLOYEE MUTATION', emoji: '🔄', subtitle: 'PERSONNEL REASSIGNMENT', channelLabel: 'Mutation channel', roleFields: ['fromRole', 'toRole'], bannerEvent: 'mutation', actorLabel: 'Recorded by' },
    warning: { label: 'Employee Warning Notice', shortLabel: 'Warning', title: 'EMPLOYEE WARNING', emoji: '⚠️', subtitle: 'OFFICIAL DISCIPLINARY NOTICE', channelLabel: 'Warning channel', roleFields: ['position'], bannerEvent: 'warning', actorLabel: 'Issued by' },
    blacklist: { label: 'Personnel Blacklist Record', shortLabel: 'Blacklist', title: 'PERSONNEL BLACKLIST', emoji: '🛡️', subtitle: 'OFFICIAL PERSONNEL RESTRICTION', channelLabel: 'Blacklist channel', roleFields: ['position'], bannerEvent: 'blacklist', actorLabel: 'Issued by' },
    others: { label: 'Other Employee Activity', shortLabel: 'Others', title: 'OTHER EMPLOYEE ACTIVITY', emoji: '📝', subtitle: 'GENERAL PERSONNEL RECORD', channelLabel: 'Others channel', roleFields: ['position'], bannerEvent: 'employee-other', actorLabel: 'Recorded by' },
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
function formatEmployeeIdentity(data = {}) {
    const mention = userMention(data.userId);
    // displayName is captured from GuildMember.displayName (server display name),
    // never from User.username. Escape Markdown so a nickname cannot alter the record layout.
    const displayName = String(data.displayName ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    return displayName ? `${escapeMarkdown(displayName)} (**${mention}**)` : mention;
}
function optionalRoleMention(id) { return SNOWFLAKE_RE.test(String(id || '')) ? `<@&${id}>` : null; }
function actorMention(data) { return SNOWFLAKE_RE.test(String(data.recordedBy || '')) ? `<@${data.recordedBy}>` : 'Not recorded'; }

function formatTimestampWIB(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return 'Time unavailable';
    const datePart = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric',
    }).format(date);
    const timePart = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(date);
    return `${datePart} · ${timePart} WIB`;
}

export function createEmployeeLogRecordId(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const datePart = `${fields.year}${fields.month}${fields.day}`;
    return `SKAW-EL-${datePart}-${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
}

export function buildEmployeeLogEditRow(recordId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`skaw_el_edit_record:${recordId}`)
            .setLabel('Edit')
            .setEmoji('✏️')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`skaw_el_audit_record:${recordId}`)
            .setLabel('Audit Trail')
            .setEmoji('🧾')
            .setStyle(ButtonStyle.Secondary),
    );
}

function getReasonLabel(type) {
    if (type === 'dismissal') return 'Dismissal Reason';
    if (type === 'blacklist') return 'Blacklist Reason';
    if (type === 'resignation') return 'Reason';
    if (type === 'warning') return 'Reason';
    if (type === 'demote') return 'Reason';
    return 'Reason';
}

const EXIT_REASON_CATEGORY_LABELS = Object.freeze({
    dismissal: 'Dismissal',
    personal_resignation: 'Personal Resignation',
    blacklist: 'Blacklist',
    others: 'Others',
});

export function buildEmployeeLogBody(type, data = {}) {
    const template = EMPLOYEE_LOG_TYPES[type];
    if (!template) throw new Error('Jenis log tidak valid.');
    const employee = formatEmployeeIdentity(data);
    const reason = cleanText(data.reason, 'Reason', { required: false, maxLength: 900 });
    const lines = [];
    const addPosition = (label = 'Position', id = data.position) => {
        const mention = optionalRoleMention(id);
        if (mention) lines.push(`**${label}:** ${mention}`);
    };
    const addPositionOrUnset = (label, id) => {
        const mention = optionalRoleMention(id);
        lines.push(`**${label}:** ${mention || 'Belum ditetapkan'}`);
    };
    const addReason = (label = getReasonLabel(type)) => {
        if (reason) lines.push(`**${label}:** ${reason}`);
    };

    if (type === 'sign_in') {
        lines.push(`**Employee:** ${employee}`);
        addPositionOrUnset('Division', data.division);
        addPositionOrUnset('Position', data.position);
        addReason();
    } else if (type === 'sign_out') {
        lines.push(`**Employee:** ${employee}`);
        addPositionOrUnset('Division', data.division);
        addPositionOrUnset('Position', data.position);
        const category = EXIT_REASON_CATEGORY_LABELS[data.reasonCategory] || '';
        if (category) lines.push(`**Reason:** ${category}`);
        else if (reason) addReason();
        else lines.push('**Reason:** Belum ditentukan');
        if (category && reason) lines.push(`**Reason Details:** ${reason}`);
    } else if (type === 'resignation') {
        lines.push(`**Employee:** ${employee}`);
        addPosition();
        addReason();
    } else if (type === 'promotion' || type === 'demote') {
        if (data.previousRank && data.newRank && data.previousRank === data.newRank) {
            throw new Error('Previous Rank dan New Rank tidak boleh sama.');
        }
        lines.push(`**Employee:** ${employee}`);
        addPosition('Previous Rank', data.previousRank);
        addPosition('New Rank', data.newRank);
        addReason();
    } else if (type === 'mutation') {
        if (data.fromRole && data.toRole && data.fromRole === data.toRole) {
            throw new Error('Role asal dan tujuan mutation tidak boleh sama.');
        }
        lines.push(`**Employee:** ${employee}`);
        addPosition('Previous Position', data.fromRole);
        addPosition('New Position', data.toRole);
        addReason();
    } else if (type === 'dismissal' || type === 'blacklist') {
        lines.push(`**Individual:** ${employee}`);
        addPosition('Last Known Position');
        addReason();
    } else if (type === 'warning') {
        lines.push(`**Employee:** ${employee}`);
        addPosition();
        if (data.warn) {
            const warn = cleanText(data.warn, 'Warning Level', { maxLength: 10 });
            if (!/^([1-9]\d?)\/([1-9]\d?)$/.test(warn)) throw new Error('Warning Level harus berformat seperti 1/2.');
            const [current, maximum] = warn.split('/').map(Number);
            if (current > maximum) throw new Error('Angka pertama Warning Level tidak boleh lebih besar dari angka kedua.');
            lines.push(`**Warning Level:** ${warn}`);
        }
        addReason();
    } else if (type === 'others') {
        lines.push(`**Activity:** ${cleanText(data.activityTitle, 'Activity title', { maxLength: 80 })}`);
        lines.push(`**Employee:** ${employee}`);
        addPosition();
        lines.push('', '**ACTIVITY DETAILS**', cleanText(data.activityDescription, 'Activity details', { maxLength: 850 }));
        addReason();
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
    const separator = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    const lines = [
        `## ${template.title}`,
        `-# ${template.subtitle}`,
        '',
        getActivitySummary(type),
        '',
        separator,
        '',
        '**EMPLOYEE INFORMATION**',
        ...buildEmployeeLogBody(type, data).split('\n'),
    ];

    const notes = cleanText(data.notes, 'Additional Notes', { required: false, maxLength: 900 });
    if (notes) lines.push('', separator, '', '**ADDITIONAL NOTES**', notes);

    lines.push(
        '', separator, '',
        'Regards,',
        '**SKAW Management.**',
        '',
        data.automatic
            ? `-# ${template.actorLabel} ${SNOWFLAKE_RE.test(String(data.recordedBy || '')) ? actorMention(data) : 'SKAW Bot'}`
            : `-# ${template.actorLabel} ${actorMention(data)}`,
        `-# Record ID: ${recordId}`,
        `-# Published: ${formatTimestampWIB(now)}`,
        '-# SKAW GROUP · PEOPLE OPERATIONS',
    );

    const description = lines.join('\n');
    if (description.length > 4096) throw new Error('Isi log terlalu panjang untuk embed Discord. Ringkas deskripsi atau Notes.');
    const safeBanner = normalizeBannerUrl(bannerUrl);
    const embed = new EmbedBuilder().setColor(BRAND_BLUE).setDescription(description);
    if (safeBanner) embed.setImage(safeBanner);
    return embed;
}

export async function getEmployeeAutoRoleConfig(client, guildId) {
    const defaults = { enabled: false, updatedAt: null, updatedBy: null };
    if (!client?.db || !guildId) return defaults;
    const raw = await client.db.get(AUTO_ROLE_CONFIG_KEY(guildId), defaults);
    return {
        enabled: raw?.enabled === true,
        updatedAt: raw?.updatedAt || null,
        updatedBy: raw?.updatedBy || null,
    };
}

export async function setEmployeeAutoRoleEnabled(client, guildId, enabled, updatedBy = null) {
    if (!client?.db) throw new Error('Database belum siap. Coba lagi setelah bot tersambung ke database.');
    const config = {
        ...(await getEmployeeAutoRoleConfig(client, guildId)),
        enabled: Boolean(enabled),
        updatedAt: new Date().toISOString(),
        updatedBy: updatedBy ? String(updatedBy) : null,
    };
    await client.db.set(AUTO_ROLE_CONFIG_KEY(guildId), config);
    return config;
}

export async function getEmployeeLogRecord(client, guildId, recordId) {
    if (!recordId || !client?.db) return null;
    const raw = await client.db.get(RECORD_KEY(guildId, recordId), null);
    return raw?.recordId === recordId && raw?.guildId === String(guildId) ? raw : null;
}

/**
 * One-time migration of the latest durable Employee Log records into the
 * directory. This lets /find discover records published before the directory
 * feature was installed, provided those records still exist in the bot DB.
 */
export async function ensureEmployeeDirectoryBackfilled(client, guild) {
    if (!client?.db || !guild?.id) throw new Error('Employee directory database is not ready.');
    const guildId = String(guild.id);
    const existingRun = directoryBackfills.get(guildId);
    if (existingRun) return existingRun;

    const run = (async () => {
        const marker = await client.db.get(DIRECTORY_BACKFILL_KEY(guildId), null);
        if (marker?.completedAt) return marker;

        const rawAudit = await client.db.get(AUDIT_KEY(guildId), []);
        const audit = Array.isArray(rawAudit) ? [...rawAudit] : [];
        audit.sort((a, b) => new Date(a.publishedAt || 0).getTime() - new Date(b.publishedAt || 0).getTime());
        let processed = 0;
        for (const item of audit) {
            if (!item?.recordId) continue;
            const record = await getEmployeeLogRecord(client, guildId, String(item.recordId));
            if (!record) continue;
            await upsertEmployeeDirectoryFromLog(client, guild, record);
            processed += 1;
        }

        const completed = { completedAt: new Date().toISOString(), processedRecords: processed };
        await client.db.set(DIRECTORY_BACKFILL_KEY(guildId), completed);
        return completed;
    })();
    directoryBackfills.set(guildId, run);
    try {
        return await run;
    } finally {
        if (directoryBackfills.get(guildId) === run) directoryBackfills.delete(guildId);
    }
}

async function saveEmployeeLogRecord(client, guildId, record) {
    if (!client?.db) throw new Error('Database belum siap. Record tetap terkirim, tetapi tombol Edit tidak dapat disimpan.');
    await client.db.set(RECORD_KEY(guildId, record.recordId), record);
}

export async function updateEmployeeLogRecord(client, guildId, recordId, input = {}, updatedBy = null) {
    const record = await getEmployeeLogRecord(client, guildId, recordId);
    if (!record) throw new Error('Record data was not found or is no longer editable.');
    if (record.guildId !== String(guildId)) throw new Error('This record belongs to another server.');
    const channel = await client.channels.fetch(record.channelId).catch(() => null);
    if (!channel || !channel.isTextBased?.() || channel.isDMBased?.() || channel.guildId !== String(guildId)) {
        throw new Error('The original Employee Logs channel is unavailable.');
    }
    const message = await channel.messages.fetch(record.messageId).catch(() => null);
    if (!message || message.author?.id !== client.user?.id) throw new Error('The original Employee Logs message is unavailable or is not owned by this bot.');

    const has = key => Object.prototype.hasOwnProperty.call(input || {}, key);
    const nextReason = cleanText(has('reason') ? input.reason : (record.data?.reason || ''), 'Reason', { required: false, maxLength: 900 });
    const nextNotes = cleanText(has('notes') ? input.notes : (record.data?.notes || ''), 'Additional Notes', { required: false, maxLength: 900 });
    const categoryCandidate = has('reasonCategory') ? String(input.reasonCategory || '') : String(record.data?.reasonCategory || '');
    const nextReasonCategory = Object.hasOwn(EXIT_REASON_CATEGORY_LABELS, categoryCandidate) ? categoryCandidate : '';
    const nextDivision = String(has('division') ? (input.division || '') : (record.data?.division || ''));
    const nextPosition = String(has('position') ? (input.position || '') : (record.data?.position || ''));
    const previousReason = String(record.data?.reason || '');
    const previousNotes = String(record.data?.notes || '');
    const previousReasonCategory = String(record.data?.reasonCategory || '');
    const previousDivision = String(record.data?.division || '');
    const previousPosition = String(record.data?.position || '');
    const editedAt = new Date().toISOString();
    const changes = {};
    if (previousReason !== nextReason) changes.reason = { before: previousReason, after: nextReason };
    if (previousNotes !== nextNotes) changes.notes = { before: previousNotes, after: nextNotes };
    if (previousReasonCategory !== nextReasonCategory) changes.reasonCategory = { before: previousReasonCategory, after: nextReasonCategory };
    if (previousDivision !== nextDivision) changes.division = { before: previousDivision, after: nextDivision };
    if (previousPosition !== nextPosition) changes.position = { before: previousPosition, after: nextPosition };
    const editHistory = Array.isArray(record.editHistory) ? [...record.editHistory] : [];
    if (Object.keys(changes).length) {
        editHistory.push({
            editedAt,
            editedBy: SNOWFLAKE_RE.test(String(updatedBy || '')) ? String(updatedBy) : null,
            changes,
        });
    }
    const nextRecord = {
        ...record,
        data: {
            ...record.data,
            reason: nextReason,
            notes: nextNotes,
            reasonCategory: nextReasonCategory,
            division: nextDivision,
            position: nextPosition,
            recordId: record.recordId,
            recordedAt: record.publishedAt,
        },
        editHistory: editHistory.slice(-100),
        updatedAt: Object.keys(changes).length ? editedAt : record.updatedAt || null,
        updatedBy: Object.keys(changes).length && updatedBy ? String(updatedBy) : record.updatedBy || null,
    };
    if (!Object.keys(changes).length) return { message, record };
    const config = await getEmployeeLogsConfig(client, guildId);
    const embed = buildEmployeeLogEmbed(record.type, nextRecord.data, record.bannerUrl || resolveEmployeeLogsBanner(config, record.type));
    await saveEmployeeLogRecord(client, guildId, nextRecord);
    try {
        await message.edit({ embeds: [embed], components: [buildEmployeeLogEditRow(recordId)], allowedMentions: { parse: [] } });
    } catch (error) {
        await saveEmployeeLogRecord(client, guildId, record).catch(() => {});
        throw error;
    }
    const guild = client.guilds?.cache?.get?.(String(guildId)) || null;
    await upsertEmployeeDirectoryFromLog(client, guild, nextRecord).catch(error => {
        console.warn('[Employee Directory] Updated the log message but could not refresh directory data:', error?.message || error);
    });
    return { message, record: nextRecord };
}
export async function sendEmployeeLog(client, guild, type, data) {
    const template = EMPLOYEE_LOG_TYPES[type];
    if (!template) throw new Error('Jenis log tidak valid.');
    if (!client?.db) throw new Error('Database belum siap. Employee Logs membutuhkan penyimpanan aktif.');
    const config = await getEmployeeLogsConfig(client, guild.id);
    const channelId = config.channels[type];
    if (!channelId) throw new Error(`Channel ${template.shortLabel} belum diatur. Admin perlu menjalankan /epl set-channel.`);
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased?.() || channel.isDMBased?.() || channel.guildId !== guild.id) {
        throw new Error(`Channel ${template.shortLabel} tidak ditemukan atau bukan channel teks di server ini. Atur ulang dengan /epl set-channel.`);
    }
    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const permissions = channel.permissionsFor(botMember || client.user);
    const required = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks | PermissionFlagsBits.ReadMessageHistory;
    if (!permissions?.has(required)) throw new Error(`Bot membutuhkan izin View Channel, Send Messages, Embed Links, dan Read Message History di ${channel}.`);

    const publishedAt = new Date();
    const recordId = data.recordId || createEmployeeLogRecordId(publishedAt);
    let displayName = String(data.displayName ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!displayName) {
        const memberId = String(data.userId || '');
        let member = guild.members?.cache?.get?.(memberId) || null;
        if (!member && SNOWFLAKE_RE.test(memberId) && typeof guild.members?.fetch === 'function') {
            member = await guild.members.fetch(memberId).catch(() => null);
        }
        // Do not fall back to username: it may differ from the server display name.
        displayName = String(member?.displayName || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    }
    const publishedData = {
        ...data,
        displayName: displayName || 'Unknown member',
        recordId,
        recordedAt: publishedAt.toISOString(),
        recordedBy: data.recordedBy || '',
    };
    const bannerUrl = resolveEmployeeLogsBanner(config, type);
    const embed = buildEmployeeLogEmbed(type, publishedData, bannerUrl);
    const allowedMentions = { parse: [] };
    // Send first without components. The Edit button is attached only after its durable record is saved.
    const message = await channel.send({ embeds: [embed], allowedMentions });

    const record = {
        guildId: String(guild.id),
        recordId,
        type,
        data: publishedData,
        bannerUrl: bannerUrl || null,
        channelId: String(channel.id),
        messageId: String(message.id),
        publishedAt: publishedAt.toISOString(),
        automatic: publishedData.automatic === true,
        createdAt: publishedAt.toISOString(),
        updatedAt: null,
        updatedBy: null,
    };
    let editButtonAttached = false;
    try {
        await saveEmployeeLogRecord(client, guild.id, record);
        await message.edit({ components: [buildEmployeeLogEditRow(recordId)], allowedMentions });
        editButtonAttached = true;
    } catch (recordError) {
        // A published record without a durable Edit button violates this feature's
        // contract. Attempt to roll back the public message rather than silently
        // publish an incomplete record. If the channel forbids deletion, log it.
        await message.delete().catch(deleteError => {
            console.error('[Employee Logs] Could not roll back a record whose Edit state failed:', deleteError?.message || deleteError);
        });
        if (typeof client.db.delete === 'function') {
            await client.db.delete(RECORD_KEY(guild.id, recordId)).catch(() => {});
        } else {
            await client.db.set(RECORD_KEY(guild.id, recordId), null).catch(() => {});
        }
        throw new Error(`Employee Log could not be safely published with its Edit button: ${recordError?.message || recordError}`);
    }

    await upsertEmployeeDirectoryFromLog(client, guild, record).catch(directoryError => {
        console.warn('[Employee Directory] Published the log but could not refresh directory data:', directoryError?.message || directoryError);
    });

    try {
        const oldEntries = await client.db.get(AUDIT_KEY(guild.id), []);
        const history = Array.isArray(oldEntries) ? oldEntries : [];
        history.push({
            recordId, type,
            employeeId: String(data.userId || ''),
            recordedBy: String(data.recordedBy || ''),
            channelId: String(channel.id),
            messageId: String(message.id),
            publishedAt: publishedAt.toISOString(),
            automatic: publishedData.automatic === true,
        });
        await client.db.set(AUDIT_KEY(guild.id), history.slice(-1000));
    } catch (auditError) {
        console.warn('[Employee Logs] Published record but could not persist the audit entry:', auditError?.message || auditError);
    }
    return { channel, message, template, recordId, publishedAt, stickerSent: false, stickerWarning: null, editButtonAttached };
}

export async function getEmployeeLogAudit(client, guildId, { type = null, limit = 10 } = {}) {
    if (!client?.db) throw new Error('Database belum siap.');
    const raw = await client.db.get(AUDIT_KEY(guildId), []);
    const entries = Array.isArray(raw) ? raw : [];
    const filtered = type ? entries.filter(entry => entry.type === type) : entries;
    return filtered.slice(-Math.max(1, Math.min(1000, Number(limit) || 10))).reverse();
}

