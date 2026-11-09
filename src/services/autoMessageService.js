// autoMessageService.js
// Persistent scheduled auto-message service for TitanBot / SKAW GROUP.
// Uses the existing client.db key-value interface.

import { EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';

const AUTO_MESSAGE_KEY = (guildId) => `guild:${guildId}:auto_messages`;
const DEFAULT_TIMEZONE = 'Asia/Jakarta';
const DISCORD_MAX_MESSAGE_LENGTH = 2000;
const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;
const MIN_INTERVAL_MS = 60 * 1000;
const DEFAULT_SCHEDULER_INTERVAL_MS = 30 * 1000;
const SEND_RETRY_BASE_MS = 60 * 1000;
const SEND_RETRY_MAX_MS = 30 * 60 * 1000;

const schedulerHandles = new WeakMap();
const schedulerRunningClients = new WeakSet();
const guildLockTails = new Map();

function assertAutoMessageStorageAvailable(client) {
    if (!client?.db) throw new Error('Auto Message database is unavailable.');
    if (client.db.isDegraded?.()) throw new Error('Auto Message requires persistent PostgreSQL storage. The database is currently in temporary memory mode; no schedule changes were made.');
    if (typeof client.db.isAvailable === 'function' && !client.db.isAvailable()) throw new Error('Auto Message persistent database is not available. Please try again when PostgreSQL is connected.');
}

async function withGuildAutoMessagesLock(client, guildId, callback) {
    const lockKey = String(guildId);
    const previous = guildLockTails.get(lockKey) || Promise.resolve();
    let releaseLocal;
    const localGate = new Promise(resolve => { releaseLocal = resolve; });
    const tail = previous.catch(() => {}).then(() => localGate);
    guildLockTails.set(lockKey, tail);
    await previous.catch(() => {});

    let pgClient = null;
    let advisoryLockAcquired = false;
    try {
        assertAutoMessageStorageAvailable(client);
        const pool = client.db?.db?.pool;
        if (pool && typeof pool.connect === 'function') {
            // Do not hold a pooled connection while waiting on a blocking advisory
            // lock. Under contention, every waiting caller could otherwise consume
            // the whole pool and starve the lock holder's read/write queries.
            while (!advisoryLockAcquired) {
                pgClient = await pool.connect();
                const lockResult = await pgClient.query(
                    'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked',
                    ['skaw:auto-message', lockKey],
                );
                advisoryLockAcquired = lockResult.rows?.[0]?.locked === true;
                if (!advisoryLockAcquired) {
                    pgClient.release();
                    pgClient = null;
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
        }
        return await callback();
    } finally {
        if (pgClient) {
            try {
                if (advisoryLockAcquired) await pgClient.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', ['skaw:auto-message', lockKey]);
            } catch (error) {
                logger.error('Could not release Auto Message advisory lock for guild ' + lockKey + ':', error);
            } finally {
                pgClient.release();
            }
        }
        releaseLocal();
        if (guildLockTails.get(lockKey) === tail) guildLockTails.delete(lockKey);
    }
}

export async function mutateGuildAutoMessages(client, guildId, mutator) {
    if (typeof mutator !== 'function') throw new Error('Auto Message mutation callback is required.');
    return withGuildAutoMessagesLock(client, guildId, async () => {
        const schedules = await getGuildAutoMessages(client, guildId);
        const result = await mutator(schedules);
        await saveGuildAutoMessages(client, guildId, schedules);
        return result;
    });
}

// SKAW GROUP brand color: navy/blue that stays visible on Discord's dark UI.
export const SKAW_DEFAULT_EMBED_COLOR = '#0A5EA8';

function resolveCustomEmojiSyntax(text, guild) {
    if (typeof text !== 'string' || !text || !guild?.emojis?.cache) return text;

    return text.replace(/(^|[^<]):([A-Za-z0-9_\-]{2,32}):/g, (full, prefix, name) => {
        const emoji = guild.emojis.cache.find(item =>
            item?.name && item.name.toLowerCase() === name.toLowerCase(),
        );

        if (!emoji) return full;

        const markup = emoji.animated
            ? `<a:${emoji.name}:${emoji.id}>`
            : `<:${emoji.name}:${emoji.id}>`;

        return `${prefix}${markup}`;
    });
}

function normalizeEmbed(embed, fallbackDescription = '') {
    // Text schedules intentionally store `embed: null`. Never dereference the
    // value directly: normalize null/invalid values to an empty object first.
    const source = embed && typeof embed === 'object' && !Array.isArray(embed)
        ? embed
        : {};

    const normalized = {
        title: typeof source.title === 'string' ? source.title.trim() : '',
        description: typeof source.description === 'string' ? source.description : '',
        color: typeof source.color === 'string' && source.color.trim()
            ? source.color.trim()
            : SKAW_DEFAULT_EMBED_COLOR,
        footer: typeof source.footer === 'string' ? source.footer.trim() : '',
        imageUrl: typeof source.imageUrl === 'string' ? source.imageUrl.trim() : '',
    };

    if (!normalized.description && fallbackDescription) {
        normalized.description = fallbackDescription;
    }

    return normalized;
}

function normalizeSchedule(record = {}) {
    const startAt = Number(record.startAt);
    const rawNext = record.nextRunAt == null ? null : Number(record.nextRunAt);

    const message = String(record.message || '');
    const messageType = record.messageType === 'embed' ? 'embed' : 'text';

    return {
        id: String(record.id || ''),
        guildId: String(record.guildId || ''),
        channelId: String(record.channelId || ''),
        message,
        messageType,
        // Keep text schedules clean and avoid treating `null` as an embed.
        embed: messageType === 'embed'
            ? normalizeEmbed(record.embed, message)
            : null,
        timezone: record.timezone || DEFAULT_TIMEZONE,
        scheduleType: record.scheduleType || (record.intervalMs == null ? 'once' : 'interval'),
        intervalMs: record.intervalMs == null ? null : Number(record.intervalMs),
        startAt,
        endAt: record.endAt == null ? null : Number(record.endAt),
        nextRunAt: record.nextRunAt === null ? null : (Number.isFinite(rawNext) ? rawNext : (Number.isFinite(startAt) ? startAt : null)),
        lastRunAt: record.lastRunAt == null ? null : Number(record.lastRunAt),
        enabled: record.enabled !== false,
        runCount: Number.isInteger(record.runCount) ? record.runCount : 0,
        failureCount: Math.max(0, Number(record.failureCount) || 0),
        lastFailureAt: record.lastFailureAt || null,
        lastError: typeof record.lastError === 'string' ? record.lastError.slice(0, 500) : null,
        inFlight: record.inFlight && typeof record.inFlight === 'object' ? { id: String(record.inFlight.id || ''), claimedAt: Number(record.inFlight.claimedAt) || null, scheduledFor: Number(record.inFlight.scheduledFor) || null } : null,
        deliveryUncertain: record.deliveryUncertain === true,
        deliveryUncertainAt: record.deliveryUncertainAt || null,
        createdAt: record.createdAt || new Date().toISOString(),
        createdBy: record.createdBy ? String(record.createdBy) : null,
        updatedAt: record.updatedAt || null,
    };
}

function asMap(records) {
    if (!records || typeof records !== 'object' || Array.isArray(records)) {
        throw new Error('Stored Auto Message data is malformed. No schedule updates were applied to protect existing records.');
    }

    const map = {};
    for (const [id, record] of Object.entries(records)) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
            throw new Error('Stored Auto Message entry "' + id + '" is malformed. No schedule updates were applied to protect existing records.');
        }
        map[id] = normalizeSchedule({ ...record, id: record.id || id });
    }
    return map;
}

export function parseInterval(intervalString) {
    if (!intervalString || typeof intervalString !== 'string') {
        throw new Error('Interval is required.');
    }

    const value = intervalString.trim().toLowerCase();
    if (value === 'once') return null;

    const match = value.match(/^(\d+)(s|m|h|d|w)$/i);
    if (!match) {
        throw new Error('Invalid interval. Use 1m, 5m, 30m, 1h, 1d, 1w, or once.');
    }

    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        w: 7 * 24 * 60 * 60 * 1000,
    }[unit];

    const intervalMs = amount * multiplier;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
        throw new Error('Interval must be at least 1 minute.');
    }

    return intervalMs;
}

function isValidTimeZone(timeZone) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone }).format();
        return true;
    } catch {
        return false;
    }
}

export function validateTimeZone(timeZone = DEFAULT_TIMEZONE) {
    const normalized = String(timeZone).trim() || DEFAULT_TIMEZONE;
    if (!isValidTimeZone(normalized)) {
        throw new Error(`Invalid timezone: ${normalized}`);
    }
    return normalized;
}

function parseParts(value) {
    const match = String(value)
        .trim()
        .match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);

    if (!match) return null;

    const [, y, mo, d, h, mi, s = '0'] = match;
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    const hour = Number(h);
    const minute = Number(mi);
    const second = Number(s);

    if (
        month < 1 || month > 12 ||
        day < 1 || day > 31 ||
        hour < 0 || hour > 23 ||
        minute < 0 || minute > 59 ||
        second < 0 || second > 59
    ) {
        return null;
    }

    const candidate = Date.UTC(year, month - 1, day, hour, minute, second, 0);
    const check = new Date(candidate);

    if (
        check.getUTCFullYear() !== year ||
        check.getUTCMonth() !== month - 1 ||
        check.getUTCDate() !== day ||
        check.getUTCHours() !== hour ||
        check.getUTCMinutes() !== minute ||
        check.getUTCSeconds() !== second
    ) {
        return null;
    }

    return { year, month, day, hour, minute, second };
}

function getTimeZoneOffsetMs(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);

    const values = {};
    for (const part of parts) {
        if (part.type !== 'literal') values[part.type] = part.value;
    }

    const asUTC = Date.UTC(
        Number(values.year),
        Number(values.month) - 1,
        Number(values.day),
        Number(values.hour),
        Number(values.minute),
        Number(values.second),
    );

    return asUTC - date.getTime();
}

export function parseScheduledDateTime(value, timeZone = DEFAULT_TIMEZONE) {
    if (!value || typeof value !== 'string') {
        throw new Error('Date/time is required.');
    }

    const raw = value.trim();

    if (/^\d{4}-\d{2}-\d{2}T/.test(raw) && /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
        const timestamp = Date.parse(raw);
        if (!Number.isNaN(timestamp)) return timestamp;
    }

    const parts = parseParts(raw);
    if (!parts) {
        throw new Error('Invalid date/time. Use YYYY-MM-DD HH:mm.');
    }

    const zone = validateTimeZone(timeZone);
    const wallClockAsUtc = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
    );

    const initialOffset = getTimeZoneOffsetMs(new Date(wallClockAsUtc), zone);
    let timestamp = wallClockAsUtc - initialOffset;

    const correctedOffset = getTimeZoneOffsetMs(new Date(timestamp), zone);
    if (correctedOffset !== initialOffset) {
        timestamp = wallClockAsUtc - correctedOffset;
    }

    const result = new Date(timestamp);
    if (Number.isNaN(result.getTime())) {
        throw new Error('Could not parse date/time.');
    }

    return timestamp;
}

export function formatDateTime(timestamp, timeZone = DEFAULT_TIMEZONE) {
    if (!Number.isFinite(Number(timestamp))) return 'Not scheduled';

    try {
        return new Intl.DateTimeFormat('en-GB', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).format(new Date(Number(timestamp)));
    } catch {
        return new Date(Number(timestamp)).toISOString();
    }
}

async function readAutoMessageStore(client, guildId) {
    assertAutoMessageStorageAvailable(client);
    const key = AUTO_MESSAGE_KEY(guildId);
    const pool = client.db?.db?.pool;
    if (pool && typeof pool.query === 'function' && client.db.isAvailable?.()) {
        const { pgConfig } = await import('../config/database/postgres.js');
        const result = await pool.query('SELECT value FROM ' + pgConfig.tables.temp_data + ' WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())', [key]);
        if (!result.rows?.length) return {};
        const value = result.rows[0].value;
        if (value === null || value === undefined) throw new Error('Stored Auto Message data is null. No schedule updates were applied to protect existing records.');
        if (typeof value === 'string') {
            try { return JSON.parse(value); } catch { throw new Error('Stored Auto Message data is not valid JSON.'); }
        }
        return value;
    }
    return await client.db.get(key, {});
}

async function writeAutoMessageStore(client, guildId, map) {
    assertAutoMessageStorageAvailable(client);
    const key = AUTO_MESSAGE_KEY(guildId);
    const pool = client.db?.db?.pool;
    if (pool && typeof pool.query === 'function' && client.db.isAvailable?.()) {
        const { pgConfig } = await import('../config/database/postgres.js');
        await pool.query('INSERT INTO ' + pgConfig.tables.temp_data + ' (key, value, expires_at) VALUES ($1, $2::jsonb, NULL) ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, expires_at = NULL', [key, JSON.stringify(map)]);
        return true;
    }
    const result = await client.db.set(key, map);
    if (result === false) throw new Error('PostgreSQL rejected the Auto Message schedule update.');
    return true;
}

export async function getGuildAutoMessages(client, guildId) {
    const raw = await readAutoMessageStore(client, guildId);
    return Object.values(asMap(raw)).filter(schedule => schedule.id);
}

export async function saveGuildAutoMessages(client, guildId, schedules) {
    const map = {};
    for (const schedule of schedules) {
        const normalized = normalizeSchedule(schedule);
        if (normalized.id) map[normalized.id] = normalized;
    }
    return writeAutoMessageStore(client, guildId, map);
}

export async function getAutoMessage(client, guildId, id) {
    const schedules = await getGuildAutoMessages(client, guildId);
    return schedules.find(schedule => schedule.id === id) || null;
}

export function createAutoMessageId() {
    return `am_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function validateMessage(message) {
    if (typeof message !== 'string') throw new Error('Message must be text.');

    const trimmed = message.trim();
    if (!trimmed) throw new Error('Message cannot be empty.');

    if (trimmed.length > DISCORD_MAX_MESSAGE_LENGTH) {
        throw new Error(`Message must be ${DISCORD_MAX_MESSAGE_LENGTH} characters or fewer.`);
    }

    return trimmed;
}

function validateExpandedMessageLength(content) {
    if (content.length > DISCORD_MAX_MESSAGE_LENGTH) throw new Error('Message exceeds Discord’s 2,000-character limit after custom emoji conversion.');
    return content;
}

function validateEmbedTotalLength(embed) {
    const titleLength = (embed.title || '').length;
    const descriptionLength = (embed.description || '').length;
    const footerLength = (embed.footer || '').length;

    if (titleLength > 256) throw new Error('Embed title exceeds Discord’s 256-character limit after custom emoji conversion.');
    if (descriptionLength > DISCORD_EMBED_DESCRIPTION_LIMIT) throw new Error('Embed description exceeds Discord’s 4,096-character limit after custom emoji conversion.');
    if (footerLength > 2048) throw new Error('Embed footer exceeds Discord’s 2,048-character limit after custom emoji conversion.');

    const total = titleLength + descriptionLength + footerLength;
    if (total > 6000) throw new Error('Embed text exceeds Discord’s 6,000-character combined limit (currently ' + total + ').');
    return total;
}

export function validateEmbedDescription(description) {
    if (typeof description !== 'string') throw new Error('Embed description must be text.');

    const trimmed = description.trim();
    if (!trimmed) throw new Error('Embed description cannot be empty.');

    if (trimmed.length > DISCORD_EMBED_DESCRIPTION_LIMIT) {
        throw new Error(`Embed description must be ${DISCORD_EMBED_DESCRIPTION_LIMIT} characters or fewer.`);
    }

    return trimmed;
}

export function validateEmbedColor(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    if (!/^#[0-9a-fA-F]{6}$/.test(raw)) {
        throw new Error('Embed color must be a 6-digit hex value such as #1A9EF3.');
    }

    return raw.toUpperCase();
}

export function validateEmbedUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    try {
        const url = new URL(raw);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
        return url.toString();
    } catch {
        throw new Error('Embed image URL must be a valid HTTP or HTTPS URL.');
    }
}

export function buildAutoMessageData({
    id,
    guildId,
    channelId,
    message,
    messageType = 'text',
    embed = null,
    intervalString,
    startString,
    endString,
    timezone,
    createdBy,
}) {
    const zone = validateTimeZone(timezone || DEFAULT_TIMEZONE);
    const intervalMs = parseInterval(intervalString);
    const normalizedType = messageType === 'embed' ? 'embed' : 'text';
    const cleanMessage = normalizedType === 'embed'
        ? validateEmbedDescription(message)
        : validateMessage(message);

    let cleanEmbed = null;
    if (normalizedType === 'embed') {
        cleanEmbed = normalizeEmbed(embed, cleanMessage);
        cleanEmbed.title = cleanEmbed.title.slice(0, 256);
        cleanEmbed.footer = cleanEmbed.footer.slice(0, 2048);
        cleanEmbed.color = validateEmbedColor(cleanEmbed.color);
        cleanEmbed.imageUrl = validateEmbedUrl(cleanEmbed.imageUrl);
        cleanEmbed.description = validateEmbedDescription(cleanEmbed.description);
        validateEmbedTotalLength(cleanEmbed);
    }

    const startAt = parseScheduledDateTime(startString, zone);
    const endAt = endString ? parseScheduledDateTime(endString, zone) : null;

    if (endAt !== null && endAt <= startAt) {
        throw new Error('End time must be after the start time.');
    }

    const now = Date.now();

    if (startAt <= now) {
        throw new Error('Start time must be in the future.');
    }

    return {
        id: id || createAutoMessageId(),
        guildId: String(guildId),
        channelId: String(channelId),
        message: cleanMessage,
        messageType: normalizedType,
        embed: cleanEmbed,
        timezone: zone,
        scheduleType: intervalMs === null ? 'once' : 'interval',
        intervalMs,
        startAt,
        endAt,
        nextRunAt: startAt,
        lastRunAt: null,
        enabled: true,
        runCount: 0,
        failureCount: 0,
        lastFailureAt: null,
        lastError: null,
        createdAt: new Date().toISOString(),
        createdBy: createdBy ? String(createdBy) : null,
        updatedAt: null,
    };
}

function parseHexColor(color) {
    const clean = String(color || '').trim();
    if (!clean) return null;
    return Number.parseInt(clean.slice(1), 16);
}

export function buildAutoMessagePayload(schedule, guild = null) {
    if (!schedule || schedule.messageType !== 'embed') {
        const content = resolveCustomEmojiSyntax(String(schedule?.message || ''), guild);
        return { content: validateExpandedMessageLength(content) };
    }

    const embedData = normalizeEmbed(schedule.embed, schedule.message);
    const embed = new EmbedBuilder();

    if (embedData.title) {
        embed.setTitle(resolveCustomEmojiSyntax(embedData.title.slice(0, 256), guild));
    }
    if (embedData.description) {
        embed.setDescription(resolveCustomEmojiSyntax(validateEmbedDescription(embedData.description), guild));
    }
    if (embedData.color) embed.setColor(parseHexColor(validateEmbedColor(embedData.color)));
    if (embedData.footer) {
        embed.setFooter({
            text: resolveCustomEmojiSyntax(embedData.footer.slice(0, 2048), guild),
        });
    }
    if (embedData.imageUrl) embed.setImage(validateEmbedUrl(embedData.imageUrl));
    validateEmbedTotalLength({
        title: resolveCustomEmojiSyntax(embedData.title, guild),
        description: resolveCustomEmojiSyntax(embedData.description, guild),
        footer: resolveCustomEmojiSyntax(embedData.footer, guild),
    });

    return { embeds: [embed] };
}

function getRetryDelayMs(failureCount, error = null) {
    const exponent = Math.min(Math.max(0, failureCount - 1), 10);
    const exponentialDelay = Math.min(SEND_RETRY_MAX_MS, SEND_RETRY_BASE_MS * (2 ** exponent));
    const retryAfterSeconds = Number(error?.retry_after ?? error?.rawError?.retry_after);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) return Math.min(SEND_RETRY_MAX_MS, Math.max(exponentialDelay, retryAfterSeconds * 1000));
    return exponentialDelay;
}

function recordScheduleFailure(schedule, error, now) {
    const failureCount = Math.max(0, Number(schedule.failureCount) || 0) + 1;
    const retryDelayMs = getRetryDelayMs(failureCount, error);
    schedule.failureCount = failureCount;
    schedule.lastFailureAt = new Date(now).toISOString();
    schedule.lastError = String(error?.message || error || 'Unknown delivery error').slice(0, 500);
    schedule.inFlight = null;
    schedule.deliveryUncertain = false;
    schedule.deliveryUncertainAt = null;
    schedule.nextRunAt = now + retryDelayMs;
    schedule.updatedAt = new Date(now).toISOString();
    return retryDelayMs;
}

function advanceScheduleAfterAttempt(schedule, scheduledFor, now) {
    if (schedule.scheduleType === 'once' || schedule.intervalMs === null) {
        schedule.enabled = false;
        schedule.nextRunAt = null;
        return;
    }
    const intervalMs = Number(schedule.intervalMs);
    if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
        schedule.enabled = false;
        schedule.nextRunAt = null;
        schedule.lastError = 'The saved repeat interval is invalid. Please create a new schedule.';
        return;
    }
    let nextRunAt = Number(scheduledFor) + intervalMs;
    while (nextRunAt <= now) nextRunAt += intervalMs;
    schedule.nextRunAt = nextRunAt;
    if (schedule.endAt !== null && (now >= schedule.endAt || nextRunAt >= schedule.endAt)) {
        schedule.enabled = false;
        schedule.nextRunAt = null;
    }
}

function recordUncertainDelivery(schedule, scheduledFor, now, reason) {
    schedule.failureCount = Math.max(0, Number(schedule.failureCount) || 0) + 1;
    schedule.lastFailureAt = new Date(now).toISOString();
    schedule.lastError = String(reason || 'The delivery outcome could not be confirmed.').slice(0, 500);
    schedule.deliveryUncertain = true;
    schedule.deliveryUncertainAt = new Date(now).toISOString();
    schedule.inFlight = null;
    schedule.updatedAt = new Date(now).toISOString();
    advanceScheduleAfterAttempt(schedule, scheduledFor, now);
}

function disableScheduleWithError(schedule, error, now) {
    schedule.enabled = false;
    schedule.nextRunAt = null;
    schedule.inFlight = null;
    schedule.failureCount = Math.max(0, Number(schedule.failureCount) || 0) + 1;
    schedule.lastFailureAt = new Date(now).toISOString();
    schedule.lastError = String(error?.message || error || 'Permanent Auto Message error').slice(0, 500);
    schedule.deliveryUncertain = false;
    schedule.deliveryUncertainAt = null;
    schedule.updatedAt = new Date(now).toISOString();
}

function isDefinitiveSendRejection(error) {
    const status = Number(error?.status ?? error?.statusCode);
    return (Number.isFinite(status) && status >= 400 && status < 500 && ![408, 425, 429].includes(status))
        || [10003, 50006, 50013, 50035].includes(Number(error?.code));
}

function isRateLimitError(error) {
    return Number(error?.status ?? error?.statusCode) === 429 || Number(error?.code) === 429;
}

async function persistGuildSchedules(client, guildId, schedules) {
    await saveGuildAutoMessages(client, guildId, schedules);
}

export function isAutoMessageSchedulerRunning(client) {
    const state = client ? schedulerHandles.get(client) : null;
    return Boolean(state?.timer);
}

export function startAutoMessageScheduler(client, intervalMs = DEFAULT_SCHEDULER_INTERVAL_MS) {
    if (!client || typeof client !== 'object') return false;
    const existing = schedulerHandles.get(client);
    if (existing?.timer) return true;

    const safeInterval = Number.isFinite(intervalMs) && intervalMs >= 5000 ? intervalMs : DEFAULT_SCHEDULER_INTERVAL_MS;
    const tick = () => {
        runAutoMessages(client).catch(error => logger.error('Auto Message scheduler tick failed:', error));
    };
    tick();
    const timer = setInterval(tick, safeInterval);
    if (typeof timer.unref === 'function') timer.unref();
    schedulerHandles.set(client, { timer, intervalMs: safeInterval });
    logger.info('Auto Message scheduler started (every ' + Math.round(safeInterval / 1000) + 's).');
    return true;
}

export function stopAutoMessageScheduler(client) {
    const state = client ? schedulerHandles.get(client) : null;
    if (!state?.timer) return false;
    clearInterval(state.timer);
    schedulerHandles.delete(client);
    logger.info('Auto Message scheduler stopped.');
    return true;
}

export async function runAutoMessages(client) {
    if (!client?.db) {
        logger.warn('Auto Message scheduler skipped: database unavailable.');
        return;
    }
    try {
        assertAutoMessageStorageAvailable(client);
    } catch (error) {
        logger.warn('Auto Message scheduler is waiting for persistent PostgreSQL storage: ' + error.message);
        return;
    }
    if (schedulerRunningClients.has(client)) {
        logger.debug('Auto Message scheduler skipped: previous run is still active.');
        return;
    }
    schedulerRunningClients.add(client);

    try {
        for (const guild of client.guilds.cache.values()) {
            try {
                await withGuildAutoMessagesLock(client, guild.id, async () => {
                    const schedules = await getGuildAutoMessages(client, guild.id);
                    if (schedules.length === 0) return;

                    for (const schedule of schedules) {
                        if (!schedule.enabled || !Number.isFinite(schedule.startAt)) continue;
                        const now = Date.now();

                        if (schedule.inFlight) {
                            const scheduledFor = Number(schedule.inFlight.scheduledFor) || Number(schedule.nextRunAt) || now;
                            recordUncertainDelivery(
                                schedule,
                                scheduledFor,
                                now,
                                'Previous delivery was interrupted. Discord may already have received it, so this occurrence was skipped to prevent duplicate messages. Review the schedule and manually re-enable it if a resend is required.',
                            );
                            await persistGuildSchedules(client, guild.id, schedules);
                            logger.warn('Auto Message ' + schedule.id + ' recovered an interrupted delivery; current occurrence marked uncertain.');
                            continue;
                        }

                        if (schedule.endAt !== null && now >= schedule.endAt) {
                            schedule.enabled = false;
                            schedule.nextRunAt = null;
                            schedule.updatedAt = new Date(now).toISOString();
                            await persistGuildSchedules(client, guild.id, schedules);
                            logger.info('Auto Message ' + schedule.id + ' expired in guild ' + guild.id + '.');
                            continue;
                        }

                        if (!Number.isFinite(schedule.nextRunAt)) {
                            schedule.nextRunAt = schedule.startAt;
                            await persistGuildSchedules(client, guild.id, schedules);
                        }
                        if (now < schedule.nextRunAt) continue;

                        let channel = null;
                        let channelFetchError = null;
                        try {
                            channel = await guild.channels.fetch(schedule.channelId);
                        } catch (error) {
                            channelFetchError = error;
                        }

                        if (channelFetchError) {
                            if (Number(channelFetchError.code) === 10003) {
                                disableScheduleWithError(schedule, new Error('The configured channel no longer exists.'), now);
                                await persistGuildSchedules(client, guild.id, schedules);
                                logger.warn('Auto Message ' + schedule.id + ' disabled: channel ' + schedule.channelId + ' no longer exists.');
                            } else {
                                const retryDelayMs = recordScheduleFailure(schedule, channelFetchError, now);
                                await persistGuildSchedules(client, guild.id, schedules);
                                logger.warn('Auto Message ' + schedule.id + ' could not fetch channel ' + schedule.channelId + '; retrying in ' + Math.ceil(retryDelayMs / 60000) + ' minute(s): ' + channelFetchError.message);
                            }
                            continue;
                        }

                        if (!channel) {
                            const retryDelayMs = recordScheduleFailure(schedule, new Error('Discord returned no channel for the configured channel ID.'), now);
                            await persistGuildSchedules(client, guild.id, schedules);
                            logger.warn('Auto Message ' + schedule.id + ' channel lookup returned empty; retrying in ' + Math.ceil(retryDelayMs / 60000) + ' minute(s).');
                            continue;
                        }

                        if (typeof channel.send !== 'function' || !channel.isTextBased()) {
                            disableScheduleWithError(schedule, new Error('The configured channel cannot receive messages.'), now);
                            await persistGuildSchedules(client, guild.id, schedules);
                            logger.warn('Auto Message ' + schedule.id + ' disabled: channel ' + schedule.channelId + ' cannot receive messages.');
                            continue;
                        }

                        let payload;
                        try {
                            payload = buildAutoMessagePayload(schedule, guild);
                        } catch (payloadError) {
                            disableScheduleWithError(schedule, payloadError, now);
                            await persistGuildSchedules(client, guild.id, schedules);
                            logger.error('Auto Message ' + schedule.id + ' disabled due to invalid message/embeds: ' + payloadError.message);
                            continue;
                        }

                        const scheduledFor = Number(schedule.nextRunAt);
                        const attemptId = createAutoMessageId();
                        schedule.inFlight = { id: attemptId, claimedAt: now, scheduledFor: scheduledFor };
                        schedule.updatedAt = new Date(now).toISOString();

                        try {
                            await persistGuildSchedules(client, guild.id, schedules);
                        } catch (claimError) {
                            schedule.inFlight = null;
                            logger.error('Auto Message ' + schedule.id + ' was not sent because its delivery claim could not be saved:', claimError);
                            continue;
                        }

                        let sent;
                        try {
                            sent = await channel.send({ ...payload, nonce: attemptId, enforceNonce: true });
                        } catch (sendError) {
                            if (isRateLimitError(sendError)) {
                                const retryDelayMs = recordScheduleFailure(schedule, sendError, Date.now());
                                await persistGuildSchedules(client, guild.id, schedules);
                                logger.warn('Auto Message ' + schedule.id + ' was rate limited; retrying in ' + Math.ceil(retryDelayMs / 60000) + ' minute(s): ' + sendError.message);
                            } else if (isDefinitiveSendRejection(sendError)) {
                                disableScheduleWithError(schedule, sendError, Date.now());
                                await persistGuildSchedules(client, guild.id, schedules);
                                logger.error('Auto Message ' + schedule.id + ' disabled after a permanent Discord rejection: ' + sendError.message);
                            } else {
                                recordUncertainDelivery(
                                    schedule,
                                    scheduledFor,
                                    Date.now(),
                                    'Discord did not confirm delivery (' + (sendError?.message || 'unknown network error') + '). This occurrence was not retried automatically because it may already have been accepted.',
                                );
                                await persistGuildSchedules(client, guild.id, schedules);
                                logger.warn('Auto Message ' + schedule.id + ' delivery outcome is uncertain; occurrence skipped to prevent a duplicate.');
                            }
                            continue;
                        }

                        if (!sent) {
                            recordUncertainDelivery(
                                schedule,
                                scheduledFor,
                                Date.now(),
                                'Discord returned no message confirmation. This occurrence was not retried automatically because it may already have been accepted.',
                            );
                            await persistGuildSchedules(client, guild.id, schedules);
                            continue;
                        }

                        const deliveredAt = Date.now();
                        schedule.lastRunAt = deliveredAt;
                        schedule.runCount += 1;
                        schedule.failureCount = 0;
                        schedule.lastFailureAt = null;
                        schedule.lastError = null;
                        schedule.inFlight = null;
                        schedule.deliveryUncertain = false;
                        schedule.deliveryUncertainAt = null;
                        schedule.updatedAt = new Date(deliveredAt).toISOString();
                        advanceScheduleAfterAttempt(schedule, scheduledFor, deliveredAt);

                        // The persisted in-flight marker prevents a restart from blindly
                        // resending this occurrence if this final write fails.
                        await persistGuildSchedules(client, guild.id, schedules);
                        logger.info('Auto Message sent: ' + schedule.id + ' in guild ' + guild.id + ', channel ' + schedule.channelId);
                    }
                });
            } catch (error) {
                logger.error('Auto Message scheduler error in guild ' + guild.id + ':', error);
            }
        }
    } finally {
        schedulerRunningClients.delete(client);
    }
}
