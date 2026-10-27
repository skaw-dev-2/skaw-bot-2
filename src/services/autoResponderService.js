import { randomUUID } from 'node:crypto';
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';

const CONFIG_KEY = guildId => 'guild:' + guildId + ':auto_responder:v1';
const MATCH_MODES = new Set(['exact', 'contains']);
const RESPONSE_MODES = new Set(['text', 'embed', 'both']);
const COOLDOWNS = new Set([0, 3, 5, 10, 30, 60]);
const cooldowns = new Map();

export function normalizeAutoResponderPrefix(value, fallback = '!') {
    const candidate = String(value ?? '').trim();
    if (!candidate) return fallback;
    if (candidate.length > 3 || /\s/.test(candidate) || candidate.includes('<@')) {
        throw new Error('Prefix harus terdiri dari 1–3 karakter tanpa spasi.');
    }
    if (candidate === '/' || candidate === '@') {
        throw new Error('Prefix / dan @ tidak diperbolehkan.');
    }
    return candidate;
}

function cleanString(value, maxLength = 4000) {
    return String(value ?? '').replace(/\r/g, '').trim().slice(0, maxLength);
}

function normalizeUrl(value) {
    const candidate = cleanString(value, 500);
    if (!candidate) return '';
    try {
        const url = new URL(candidate);
        return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.toString() : '';
    } catch {
        return '';
    }
}

function normalizeTrigger(trigger) {
    const type = trigger?.type === 'command' ? 'command' : 'keyword';
    const value = cleanString(trigger?.value, 100).replace(/\s+/g, ' ');
    if (!value) return null;
    if (/@everyone\b|@here\b/i.test(value)) throw new Error('Trigger tidak boleh berisi @everyone atau @here.');
    if (type === 'command' && value.startsWith('!')) {
        // Store command names without the default prefix; runtime prefix is server-configurable.
        return { type, value: value.slice(1).trim() };
    }
    return { type, value };
}

function normalizeTemplate(template = {}) {
    const mode = MATCH_MODES.has(template.matchMode) ? template.matchMode : 'exact';
    const responseMode = RESPONSE_MODES.has(template.responseMode) ? template.responseMode : 'text';
    const triggers = [];
    const seen = new Set();
    for (const raw of Array.isArray(template.triggers) ? template.triggers : []) {
        const trigger = normalizeTrigger(raw);
        if (!trigger?.value) continue;
        const key = trigger.type + ':' + trigger.value.toLocaleLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            triggers.push(trigger);
        }
    }
    const rawEmbed = template.embed && typeof template.embed === 'object' ? template.embed : {};
    const cooldownRaw = Number(template.cooldownSeconds);
    const cooldownSeconds = COOLDOWNS.has(cooldownRaw) ? cooldownRaw : 5;
    const excludedChannels = [...new Set((Array.isArray(template.excludedChannels) ? template.excludedChannels : [])
        .map(value => String(value)).filter(value => /^\d{17,20}$/.test(value)))].slice(0, 25);
    return {
        id: cleanString(template.id, 40) || randomUUID().replaceAll('-', '').slice(0, 16),
        name: cleanString(template.name, 80),
        triggers,
        matchMode: mode,
        responseMode,
        textResponse: cleanString(template.textResponse, 1800),
        embed: {
            title: cleanString(rawEmbed.title, 256),
            description: cleanString(rawEmbed.description, 4000),
            color: /^#?[0-9a-f]{6}$/i.test(cleanString(rawEmbed.color, 7)) ? cleanString(rawEmbed.color, 7).replace(/^#?/, '#').toUpperCase() : '#2563EB',
            imageUrl: normalizeUrl(rawEmbed.imageUrl),
            thumbnailUrl: normalizeUrl(rawEmbed.thumbnailUrl),
            footer: cleanString(rawEmbed.footer, 2048),
        },
        excludedChannels,
        cooldownSeconds,
        enabled: template.enabled === true,
        createdAt: template.createdAt || new Date().toISOString(),
        updatedAt: template.updatedAt || null,
        updatedBy: template.updatedBy ? String(template.updatedBy) : null,
    };
}

export function normalizeAutoResponderConfig(input = {}) {
    const templates = [];
    const seenIds = new Set();
    for (const raw of Array.isArray(input.templates) ? input.templates : []) {
        const template = normalizeTemplate(raw);
        if (!template.name || seenIds.has(template.id)) continue;
        seenIds.add(template.id);
        templates.push(template);
    }
    return {
        enabled: input.enabled !== false,
        prefix: normalizeAutoResponderPrefix(input.prefix || '!'),
        templates: templates.slice(0, 500),
        updatedAt: input.updatedAt || null,
        updatedBy: input.updatedBy ? String(input.updatedBy) : null,
    };
}

export async function getAutoResponderConfig(client, guildId) {
    if (!guildId) throw new Error('Guild ID wajib diisi.');
    if (!client?.db) return normalizeAutoResponderConfig({});
    const stored = await client.db.get(CONFIG_KEY(guildId), {});
    return normalizeAutoResponderConfig(stored || {});
}

export async function saveAutoResponderConfig(client, guildId, config, updatedBy = null) {
    if (!client?.db) throw new Error('Database belum siap. Auto Responder membutuhkan penyimpanan aktif.');
    const normalized = normalizeAutoResponderConfig({
        ...config,
        updatedAt: new Date().toISOString(),
        updatedBy: updatedBy || config?.updatedBy || null,
    });
    await client.db.set(CONFIG_KEY(guildId), normalized);
    return normalized;
}

export function getAutoResponderTemplate(config, templateId) {
    return (config?.templates || []).find(template => String(template.id) === String(templateId)) || null;
}

export function isAutoResponderTemplateReady(template) {
    if (!template || !Array.isArray(template.triggers) || template.triggers.length === 0) return false;
    const textReady = Boolean(String(template.textResponse || '').trim());
    const embedReady = Boolean(String(template.embed?.title || '').trim() || String(template.embed?.description || '').trim());
    if (template.responseMode === 'text') return textReady;
    if (template.responseMode === 'embed') return embedReady;
    return textReady && embedReady;
}

function validateUniqueTriggers(templates) {
    const owners = new Map();
    for (const template of templates) {
        for (const trigger of template.triggers) {
            const key = trigger.type + ':' + trigger.value.toLocaleLowerCase();
            const owner = owners.get(key);
            if (owner && owner !== template.id) {
                throw new Error('Trigger "' + trigger.value + '" sudah digunakan oleh template lain dengan jenis trigger yang sama.');
            }
            owners.set(key, template.id);
        }
    }
}

export async function upsertAutoResponderTemplate(client, guildId, templateInput, updatedBy = null) {
    const config = await getAutoResponderConfig(client, guildId);
    const existingIndex = config.templates.findIndex(item => item.id === String(templateInput.id || ''));
    const existing = existingIndex >= 0 ? config.templates[existingIndex] : null;
    const now = new Date().toISOString();
    const candidate = normalizeTemplate({
        ...(existing || {}),
        ...templateInput,
        id: existing?.id || templateInput.id || randomUUID().replaceAll('-', '').slice(0, 16),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        updatedBy: updatedBy || null,
    });
    if (!candidate.name) throw new Error('Nama template wajib diisi.');
    if (candidate.triggers.length === 0) throw new Error('Tambahkan minimal satu trigger keyword atau command teks.');
    const duplicateName = config.templates.find(item => item.id !== candidate.id && item.name.toLocaleLowerCase() === candidate.name.toLocaleLowerCase());
    if (duplicateName) throw new Error('Nama template sudah digunakan. Pilih nama lain.');

    const nextTemplates = [...config.templates];
    if (existingIndex >= 0) nextTemplates[existingIndex] = candidate;
    else {
        if (nextTemplates.length >= 500) throw new Error('Batas 500 template sudah tercapai.');
        nextTemplates.push(candidate);
    }
    validateUniqueTriggers(nextTemplates);
    const savedConfig = await saveAutoResponderConfig(client, guildId, { ...config, templates: nextTemplates }, updatedBy);
    return { config: savedConfig, template: getAutoResponderTemplate(savedConfig, candidate.id) };
}

export async function deleteAutoResponderTemplate(client, guildId, templateId, updatedBy = null) {
    const config = await getAutoResponderConfig(client, guildId);
    const template = getAutoResponderTemplate(config, templateId);
    if (!template) throw new Error('Template tidak ditemukan.');
    const next = await saveAutoResponderConfig(client, guildId, {
        ...config,
        templates: config.templates.filter(item => item.id !== template.id),
    }, updatedBy);
    return { config: next, template };
}

export async function setAutoResponderTemplateEnabled(client, guildId, templateId, enabled, updatedBy = null) {
    const config = await getAutoResponderConfig(client, guildId);
    const template = getAutoResponderTemplate(config, templateId);
    if (!template) throw new Error('Template tidak ditemukan.');
    if (enabled && !isAutoResponderTemplateReady(template)) {
        throw new Error('Lengkapi Response terlebih dahulu sebelum mengaktifkan template.');
    }
    const templates = config.templates.map(item => item.id === template.id
        ? { ...item, enabled: Boolean(enabled), updatedAt: new Date().toISOString(), updatedBy: updatedBy ? String(updatedBy) : null }
        : item);
    const saved = await saveAutoResponderConfig(client, guildId, { ...config, templates }, updatedBy);
    return { config: saved, template: getAutoResponderTemplate(saved, template.id) };
}

export async function setAutoResponderPrefix(client, guildId, prefix, updatedBy = null) {
    const config = await getAutoResponderConfig(client, guildId);
    const saved = await saveAutoResponderConfig(client, guildId, { ...config, prefix: normalizeAutoResponderPrefix(prefix) }, updatedBy);
    return saved;
}

export function normalizeMessageForMatch(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function containsWholePhrase(content, phrase) {
    const escaped = phrase.replace(/[.*+?^()|[\]\\{}$]/g, '\\$&');
    const pattern = new RegExp('(^|[^\\p{L}\\p{N}_])' + escaped + '($|[^\\p{L}\\p{N}_])', 'iu');
    return pattern.test(content);
}

function matchTrigger(trigger, content, config) {
    const normalizedContent = normalizeMessageForMatch(content);
    const prefix = config.prefix || '!';
    let triggerContent = normalizedContent;
    if (trigger.type === 'command') {
        if (!String(content ?? '').trim().startsWith(prefix)) return null;
        const raw = String(content ?? '').trim().slice(prefix.length).trim();
        triggerContent = normalizeMessageForMatch(raw);
        if (!triggerContent) return null;
    }
    const triggerValue = normalizeMessageForMatch(trigger.value);
    if (!triggerValue) return null;
    if (triggerContent === triggerValue) return { exact: true, length: triggerValue.length };
    if (trigger.matchMode === 'contains') return containsWholePhrase(triggerContent, triggerValue)
        ? { exact: false, length: triggerValue.length } : null;
    return null;
}

export function findAutoResponderMatch(config, content, channelId = null) {
    const candidates = [];
    for (const template of config?.templates || []) {
        if (!template.enabled || !isAutoResponderTemplateReady(template)) continue;
        if (channelId && template.excludedChannels.includes(String(channelId))) continue;
        for (const rawTrigger of template.triggers) {
            const trigger = { ...rawTrigger, matchMode: template.matchMode };
            const match = matchTrigger(trigger, content, config);
            if (!match) continue;
            candidates.push({ template, trigger, exact: match.exact, length: match.length });
        }
    }
    candidates.sort((a, b) => Number(b.exact) - Number(a.exact)
        || b.length - a.length
        || String(a.template.createdAt || '').localeCompare(String(b.template.createdAt || '')));
    return candidates[0] || null;
}

function renderPlaceholders(value, message) {
    return String(value ?? '')
        .replaceAll('{user}', String(message.member?.displayName || message.author?.username || 'Member'))
        .replaceAll('{mention}', '<@' + String(message.author?.id || '') + '>')
        .replaceAll('{server}', String(message.guild?.name || 'Server'))
        .replaceAll('{channel}', String(message.channel?.name || 'channel'));
}

export function buildAutoResponderPayload(template, message = null) {
    const render = value => renderPlaceholders(value, message || {});
    const payload = { allowedMentions: { parse: [] } };
    if (['text', 'both'].includes(template.responseMode) && template.textResponse) {
        payload.content = render(template.textResponse);
    }
    if (['embed', 'both'].includes(template.responseMode)) {
        const data = template.embed || {};
        const embed = new EmbedBuilder().setColor(parseInt(String(data.color || '#2563EB').replace('#', ''), 16));
        if (data.title) embed.setTitle(render(data.title));
        if (data.description) embed.setDescription(render(data.description));
        if (data.imageUrl) embed.setImage(data.imageUrl);
        if (data.thumbnailUrl) embed.setThumbnail(data.thumbnailUrl);
        if (data.footer) embed.setFooter({ text: render(data.footer) });
        payload.embeds = [embed];
    }
    if (!payload.content && (!payload.embeds || payload.embeds.length === 0)) {
        throw new Error('Response template belum memiliki isi yang dapat dikirim.');
    }
    return payload;
}

function getCooldownExpiry(key) {
    const value = cooldowns.get(key) || 0;
    if (value <= Date.now()) {
        cooldowns.delete(key);
        return 0;
    }
    return value;
}

export function isAutoResponderCooldownActive(key, now = Date.now()) {
    const expiry = cooldowns.get(key) || 0;
    if (expiry <= now) {
        cooldowns.delete(key);
        return false;
    }
    return true;
}

export function resetAutoResponderCooldownsForTests() {
    cooldowns.clear();
}

export async function dispatchAutoResponderMessage(message, client) {
    if (!message || message.author?.bot || !message.guild || !message.channel?.isTextBased?.()) return false;
    try {
        const config = await getAutoResponderConfig(client, message.guild.id);
        if (!config.enabled) return false;
        const match = findAutoResponderMatch(config, message.content, message.channel.id);
        if (!match) return false;
        const cooldownKey = String(message.guild.id) + ':' + match.template.id + ':' + String(message.author.id);
        if (getCooldownExpiry(cooldownKey)) return false;

        const payload = buildAutoResponderPayload(match.template, message);
        await message.channel.send(payload);
        if (match.template.cooldownSeconds > 0) {
            cooldowns.set(cooldownKey, Date.now() + match.template.cooldownSeconds * 1000);
        }
        await message.delete().catch(error => {
            console.warn('[Auto Responder] Response was sent, but the trigger message could not be deleted:', error?.message || error);
        });
        return true;
    } catch (error) {
        console.error('[Auto Responder] Could not dispatch response:', error?.message || error);
        return false;
    }
}

export function canManageAutoResponder(memberPermissions) {
    return Boolean(memberPermissions?.has?.(PermissionFlagsBits.ManageGuild) || memberPermissions?.has?.(PermissionFlagsBits.Administrator));
}
