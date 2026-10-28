import { randomUUID } from 'node:crypto';
import { PermissionFlagsBits } from 'discord.js';

const key = guildId => 'guild:' + guildId + ':role_templates:v1';
export const ROLE_TEMPLATE_MAX_ROLES = 25;

export function canManageRoleTemplates(perms) {
    return Boolean(perms?.has?.(PermissionFlagsBits.Administrator) || perms?.has?.(PermissionFlagsBits.ManageGuild));
}

export function slugifyRoleTemplateName(value) {
    return String(value ?? '').toLowerCase().trim()
        .replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 32);
}

function normalizeTemplate(input) {
    const name = String(input?.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!name) return null;
    const roleIds = [...new Set((Array.isArray(input.roleIds) ? input.roleIds : []).map(String).filter(id => /^\d{17,20}$/.test(id)))].slice(0, ROLE_TEMPLATE_MAX_ROLES);
    return {
        id: String(input.id || randomUUID().replaceAll('-', '').slice(0, 16)),
        name,
        slug: slugifyRoleTemplateName(input.slug || name) || 'template',
        roleIds,
        enabled: input.enabled === true && roleIds.length > 0,
        createdAt: input.createdAt || new Date().toISOString(),
        updatedAt: input.updatedAt || null,
        createdBy: input.createdBy ? String(input.createdBy) : null,
        updatedBy: input.updatedBy ? String(input.updatedBy) : null,
    };
}

export function normalizeRoleTemplateConfig(raw = {}) {
    const list = [];
    const ids = new Set();
    const slugs = new Set();
    for (const item of Array.isArray(raw?.templates) ? raw.templates : []) {
        const template = normalizeTemplate(item);
        if (!template || ids.has(template.id)) continue;
        const base = template.slug;
        let slug = base, n = 2;
        while (slugs.has(slug)) slug = base.slice(0, 32 - String(n).length - 1) + '-' + n++;
        template.slug = slug;
        ids.add(template.id);
        slugs.add(slug);
        list.push(template);
    }
    return { version: 1, templates: list };
}

export async function getRoleTemplateConfig(client, guildId) {
    if (!client?.db?.get || !guildId) throw new Error('Database or server is not available.');
    return normalizeRoleTemplateConfig(await client.db.get(key(guildId), { templates: [] }));
}

async function save(client, guildId, config) {
    if (!client?.db?.set) throw new Error('Persistent database is not available.');
    const normalized = normalizeRoleTemplateConfig(config);
    await client.db.set(key(guildId), normalized);
    return normalized;
}

export function getRoleTemplateBySlug(config, slug) {
    return (config?.templates || []).find(item => item.slug === String(slug ?? '').toLowerCase()) || null;
}
export function getRoleTemplateById(config, id) {
    return (config?.templates || []).find(item => item.id === String(id)) || null;
}
