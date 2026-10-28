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


function uniqueSlug(name, templates, excludeId = null) {
    const base = slugifyRoleTemplateName(name) || 'template';
    const used = new Set((templates || []).filter(item => item.id !== excludeId).map(item => item.slug));
    if (!used.has(base)) return base;
    for (let n = 2; n < 10000; n++) {
        const suffix = '-' + n;
        const candidate = base.slice(0, 32 - suffix.length) + suffix;
        if (!used.has(candidate)) return candidate;
    }
    throw new Error('Could not create a unique template name.');
}

export async function createRoleTemplate(client, guildId, name, actorId) {
    const clean = String(name ?? '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    if (!clean) throw new Error('Template name cannot be empty.');
    const config = await getRoleTemplateConfig(client, guildId);
    if (config.templates.length >= 200) throw new Error('Maximum of 200 templates reached.');
    if (config.templates.some(item => item.name.toLowerCase() === clean.toLowerCase())) {
        throw new Error('A template with that name already exists.');
    }
    const draft = {
        id: randomUUID().replaceAll('-', '').slice(0, 16),
        name: clean,
        slug: uniqueSlug(clean, config.templates),
        roleIds: [],
        enabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: null,
        createdBy: actorId ? String(actorId) : null,
        updatedBy: null,
    };
    const next = await save(client, guildId, { ...config, templates: [...config.templates, draft] });
    return { config: next, template: getRoleTemplateById(next, draft.id) };
}

export async function renameRoleTemplate(client, guildId, templateId, name, actorId) {
    const clean = String(name ?? '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    if (!clean) throw new Error('Template name cannot be empty.');
    const config = await getRoleTemplateConfig(client, guildId);
    const old = getRoleTemplateById(config, templateId);
    if (!old) throw new Error('Template not found.');
    if (config.templates.some(item => item.id !== old.id && item.name.toLowerCase() === clean.toLowerCase())) {
        throw new Error('A template with that name already exists.');
    }
    const updated = {
        ...old,
        name: clean,
        slug: uniqueSlug(clean, config.templates, old.id),
        updatedAt: new Date().toISOString(),
        updatedBy: actorId ? String(actorId) : null,
    };
    const next = await save(client, guildId, { ...config, templates: config.templates.map(item => item.id === old.id ? updated : item) });
    return { config: next, template: getRoleTemplateById(next, old.id) };
}

export async function setRoleTemplateRoles(client, guildId, templateId, roleIds, actorId) {
    if (!Array.isArray(roleIds) || roleIds.length > ROLE_TEMPLATE_MAX_ROLES) {
        throw new Error('Select up to 25 roles for a template.');
    }
    const ids = [...new Set(roleIds.map(String))];
    if (ids.some(id => !/^\\d{17,20}$/.test(id))) throw new Error('Invalid Role ID.');
    const config = await getRoleTemplateConfig(client, guildId);
    const old = getRoleTemplateById(config, templateId);
    if (!old) throw new Error('Template not found.');
    const updated = { ...old, roleIds: ids, enabled: old.enabled && ids.length > 0, updatedAt: new Date().toISOString(), updatedBy: actorId ? String(actorId) : null };
    const next = await save(client, guildId, { ...config, templates: config.templates.map(item => item.id === old.id ? updated : item) });
    return { config: next, template: getRoleTemplateById(next, old.id) };
}

export async function setRoleTemplateEnabled(client, guildId, templateId, enabled, actorId) {
    const config = await getRoleTemplateConfig(client, guildId);
    const old = getRoleTemplateById(config, templateId);
    if (!old) throw new Error('Template not found.');
    if (enabled && !old.roleIds.length) throw new Error('Select at least one role before enabling this template.');
    const updated = { ...old, enabled: Boolean(enabled), updatedAt: new Date().toISOString(), updatedBy: actorId ? String(actorId) : null };
    const next = await save(client, guildId, { ...config, templates: config.templates.map(item => item.id === old.id ? updated : item) });
    return { config: next, template: getRoleTemplateById(next, old.id) };
}

export async function deleteRoleTemplate(client, guildId, templateId) {
    const config = await getRoleTemplateConfig(client, guildId);
    const old = getRoleTemplateById(config, templateId);
    if (!old) throw new Error('Template not found.');
    const next = await save(client, guildId, { ...config, templates: config.templates.filter(item => item.id !== old.id) });
    return { config: next, template: old };
}

/** Create a safe plan before changing any member roles. */
export function buildRoleAssignmentPlan(template, roleMap, existingRoleIds, everyoneRoleId = null) {
    const existing = new Set([...existingRoleIds].map(String));
    const plan = { toAdd: [], alreadyHad: [], unavailable: [] };
    for (const rawId of template?.roleIds || []) {
        const id = String(rawId);
        const role = roleMap?.get?.(id);
        if (!role) {
            plan.unavailable.push({ id, reason: 'missing' });
        } else if (id === String(everyoneRoleId || '') || role.managed || role.editable === false) {
            plan.unavailable.push({ id, role, reason: 'not_assignable' });
        } else if (existing.has(id)) {
            plan.alreadyHad.push(role);
        } else {
            plan.toAdd.push(role);
        }
    }
    return plan;
}
