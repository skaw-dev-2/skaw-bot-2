import { randomUUID } from 'node:crypto';

const REGISTRY_KEY = guildId => `guild:${guildId}:employee_logs:role_registry`;
const EXIT_REVIEW_KEY = guildId => `guild:${guildId}:employee_logs:exit_reviews`;
const SNOWFLAKE_RE = /^\d{17,20}$/;
const ROLE_CATEGORIES = new Set(['rank', 'division', 'warning', 'blacklist', 'retired', 'civilian', 'other']);

export const BASE_EMPLOYEE_ROLE = Object.freeze({
    id: '1564660065783390371',
    name: 'Company Staff | SKAW',
    category: 'membership',
    department: 'company',
    level: 0,
    active: true,
    builtIn: true,
});

function cleanText(value, maxLength = 100) {
    return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeRole(role) {
    const id = String(role?.id ?? '');
    if (!SNOWFLAKE_RE.test(id) || id === BASE_EMPLOYEE_ROLE.id) return null;
    const category = String(role?.category || '');
    if (!ROLE_CATEGORIES.has(category)) return null;
    const level = Number(role?.level);
    const warn = cleanText(role?.warn, 10);
    const department = cleanText(role?.department, 50).toLocaleLowerCase('en-US').replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
    if ((category === 'rank' || category === 'division') && !department) return null;
    if (category === 'rank' && (!Number.isInteger(level) || level < 1 || level > 100)) return null;
    if (category === 'warning' && !/^([1-9]\d?)\/([1-9]\d?)$/.test(warn)) return null;
    if (category === 'warning') {
        const [current, maximum] = warn.split('/').map(Number);
        if (current > maximum) return null;
    }
    return {
        id,
        name: cleanText(role?.name, 100) || `Role ${id}`,
        category,
        department: department || null,
        level: category === 'rank' ? level : (category === 'division' ? 0 : null),
        warn: category === 'warning' ? warn : null,
        note: cleanText(role?.note, 300),
        active: role?.active !== false,
        createdAt: role?.createdAt || new Date().toISOString(),
        createdBy: SNOWFLAKE_RE.test(String(role?.createdBy || '')) ? String(role.createdBy) : null,
        updatedAt: role?.updatedAt || null,
        updatedBy: SNOWFLAKE_RE.test(String(role?.updatedBy || '')) ? String(role.updatedBy) : null,
        disabledAt: role?.disabledAt || null,
        disabledBy: SNOWFLAKE_RE.test(String(role?.disabledBy || '')) ? String(role.disabledBy) : null,
    };
}

function normalizeRegistry(raw) {
    const rolesById = {};
    const values = Array.isArray(raw?.roles) ? raw.roles : Object.values(raw?.roles || {});
    for (const value of values) {
        const role = normalizeRole(value);
        if (role) rolesById[role.id] = role;
    }
    return {
        schemaVersion: 1,
        baseEmployeeRole: { ...BASE_EMPLOYEE_ROLE },
        roles: Object.values(rolesById).sort((a, b) => {
            return String(a.department || '').localeCompare(String(b.department || ''))
                || (Number(a.level) || 0) - (Number(b.level) || 0)
                || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
        }),
        updatedAt: raw?.updatedAt || null,
        updatedBy: raw?.updatedBy || null,
    };
}

async function requireDatabase(client) {
    if (!client?.db) throw new Error('Employee Role Registry membutuhkan database yang aktif.');
}

export async function getEmployeeRoleRegistry(client, guildId) {
    if (!client?.db || !guildId) {
        return { schemaVersion: 1, baseEmployeeRole: { ...BASE_EMPLOYEE_ROLE }, roles: [], updatedAt: null, updatedBy: null };
    }
    const raw = await client.db.get(REGISTRY_KEY(guildId), {});
    return normalizeRegistry(raw);
}

async function saveRegistry(client, guildId, registry, updatedBy = null) {
    await requireDatabase(client);
    const next = {
        ...normalizeRegistry(registry),
        updatedAt: new Date().toISOString(),
        updatedBy: SNOWFLAKE_RE.test(String(updatedBy || '')) ? String(updatedBy) : null,
    };
    await client.db.set(REGISTRY_KEY(guildId), next);
    return next;
}

export async function registerEmployeeRole(client, guildId, input, updatedBy = null) {
    await requireDatabase(client);
    const roleId = String(input?.id || '');
    if (!SNOWFLAKE_RE.test(roleId)) throw new Error('Discord Role ID tidak valid.');
    if (roleId === BASE_EMPLOYEE_ROLE.id) {
        throw new Error('Company Staff | SKAW merupakan Base Employee Role bawaan dan tidak perlu didaftarkan ulang.');
    }
    if (!ROLE_CATEGORIES.has(String(input?.category || ''))) throw new Error('Kategori role tidak valid.');
    const now = new Date().toISOString();
    const registry = await getEmployeeRoleRegistry(client, guildId);
    const existing = registry.roles.find(role => role.id === roleId);
    const role = normalizeRole({
        ...existing,
        ...input,
        id: roleId,
        name: cleanText(input?.name, 100),
        createdAt: existing?.createdAt || now,
        createdBy: existing?.createdBy || updatedBy,
        updatedAt: now,
        updatedBy,
        active: true,
        disabledAt: null,
        disabledBy: null,
    });
    if (!role) {
        throw new Error('Konfigurasi role tidak valid. Rank membutuhkan divisi dan level 1–100; Division membutuhkan nama divisi; Warning membutuhkan level valid seperti 1/2.');
    }
    const next = {
        ...registry,
        roles: [...registry.roles.filter(item => item.id !== roleId), role],
    };
    const saved = await saveRegistry(client, guildId, next, updatedBy);
    return saved.roles.find(item => item.id === roleId);
}

export async function disableEmployeeRole(client, guildId, roleId, updatedBy = null) {
    await requireDatabase(client);
    const id = String(roleId || '');
    if (!SNOWFLAKE_RE.test(id)) throw new Error('Discord Role ID tidak valid.');
    if (id === BASE_EMPLOYEE_ROLE.id) throw new Error('Base Employee Role tidak dapat dinonaktifkan melalui Role Registry.');
    const registry = await getEmployeeRoleRegistry(client, guildId);
    const existing = registry.roles.find(role => role.id === id);
    if (!existing) throw new Error('Role belum terdaftar di Employee Role Registry.');
    const now = new Date().toISOString();
    const nextRole = {
        ...existing,
        active: false,
        disabledAt: now,
        disabledBy: SNOWFLAKE_RE.test(String(updatedBy || '')) ? String(updatedBy) : null,
        updatedAt: now,
        updatedBy: SNOWFLAKE_RE.test(String(updatedBy || '')) ? String(updatedBy) : null,
    };
    await saveRegistry(client, guildId, {
        ...registry,
        roles: registry.roles.map(role => role.id === id ? nextRole : role),
    }, updatedBy);
    return nextRole;
}

export async function getEmployeeRoleById(client, guildId, roleId) {
    const id = String(roleId || '');
    if (id === BASE_EMPLOYEE_ROLE.id) return { ...BASE_EMPLOYEE_ROLE };
    const registry = await getEmployeeRoleRegistry(client, guildId);
    return registry.roles.find(role => role.id === id) || null;
}

export function employeeRoleToCatalogEntry(role) {
    if (!role || !SNOWFLAKE_RE.test(String(role.id || ''))) return null;
    if (role.category === 'membership') {
        return { name: role.name, domain: 'company', level: 0, kind: 'membership', active: false, position: false };
    }
    if (role.category === 'rank') {
        return { name: role.name, domain: role.department, level: Number(role.level) || 1, kind: 'rank', active: role.active !== false, position: true };
    }
    if (role.category === 'division') {
        return { name: role.name, domain: role.department, level: 0, kind: 'division', active: role.active !== false, position: true };
    }
    if (role.category === 'warning') {
        return { name: role.name, kind: 'warning', warn: role.warn, active: false, position: false };
    }
    if (role.category === 'blacklist') {
        return { name: role.name, kind: 'blacklist', active: false, position: false };
    }
    if (role.category === 'retired') {
        return { name: role.name, kind: 'retired', active: false, position: false };
    }
    if (role.category === 'civilian') {
        return { name: role.name, kind: 'civilian', active: false, position: false };
    }
    return { name: role.name, kind: 'other', active: false, position: false };
}

function normalizeReview(input) {
    if (!input || !/^[A-Z0-9_-]{8,40}$/.test(String(input.reviewId || ''))) return null;
    if (!SNOWFLAKE_RE.test(String(input.userId || ''))) return null;
    const allowedStatuses = new Set(['pending', 'processing', 'resolved', 'cancelled']);
    const status = allowedStatuses.has(input.status) ? input.status : 'pending';
    return {
        reviewId: String(input.reviewId),
        userId: String(input.userId),
        displayName: cleanText(input.displayName, 100) || 'Unknown member',
        formerPositionId: SNOWFLAKE_RE.test(String(input.formerPositionId || '')) ? String(input.formerPositionId) : '',
        formerPositionName: cleanText(input.formerPositionName, 100),
        detectedAt: input.detectedAt || new Date().toISOString(),
        detectedBy: SNOWFLAKE_RE.test(String(input.detectedBy || '')) ? String(input.detectedBy) : null,
        status,
        outcome: ['sign_out', 'resignation', 'dismissal'].includes(input.outcome) ? input.outcome : null,
        reason: cleanText(input.reason, 900),
        recordId: cleanText(input.recordId, 64),
        resolvedAt: input.resolvedAt || null,
        resolvedBy: SNOWFLAKE_RE.test(String(input.resolvedBy || '')) ? String(input.resolvedBy) : null,
        claimedAt: input.claimedAt || null,
        claimedBy: SNOWFLAKE_RE.test(String(input.claimedBy || '')) ? String(input.claimedBy) : null,
    };
}

async function readReviews(client, guildId) {
    if (!client?.db || !guildId) return [];
    const raw = await client.db.get(EXIT_REVIEW_KEY(guildId), []);
    return (Array.isArray(raw) ? raw : []).map(normalizeReview).filter(Boolean);
}

async function writeReviews(client, guildId, reviews) {
    await requireDatabase(client);
    // Keep all unresolved reviews and the latest 500 resolved items for auditability.
    const unresolved = reviews.filter(item => item.status !== 'resolved' && item.status !== 'cancelled');
    const terminal = reviews.filter(item => item.status === 'resolved' || item.status === 'cancelled').slice(-500);
    await client.db.set(EXIT_REVIEW_KEY(guildId), [...unresolved, ...terminal]);
}

function makeReviewId() {
    const date = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const fields = Object.fromEntries(date.map(part => [part.type, part.value]));
    const day = `${fields.year}${fields.month}${fields.day}`;
    return `ELX-${day}-${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
}

export async function createEmployeeExitReview(client, guildId, input) {
    await requireDatabase(client);
    const userId = String(input?.userId || '');
    if (!SNOWFLAKE_RE.test(userId)) throw new Error('Employee ID tidak valid untuk Exit Review.');
    const reviews = await readReviews(client, guildId);
    const existing = reviews.find(item => item.userId === userId && ['pending', 'processing'].includes(item.status));
    if (existing) return { ...existing, duplicate: true };
    const review = normalizeReview({
        reviewId: makeReviewId(),
        userId,
        displayName: input?.displayName,
        formerPositionId: input?.formerPositionId,
        formerPositionName: input?.formerPositionName,
        detectedAt: new Date().toISOString(),
        detectedBy: input?.detectedBy,
        status: 'pending',
    });
    if (!review) throw new Error('Exit Review tidak dapat dibuat dari data yang diberikan.');
    reviews.push(review);
    await writeReviews(client, guildId, reviews);
    return review;
}

export async function listEmployeeExitReviews(client, guildId, { status = 'pending', limit = 25 } = {}) {
    const reviews = await readReviews(client, guildId);
    const filtered = status === 'all' ? reviews : reviews.filter(item => item.status === status);
    return filtered
        .sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime())
        .slice(0, Math.max(1, Math.min(100, Number(limit) || 25)));
}

export async function getEmployeeExitReview(client, guildId, reviewId) {
    const reviews = await readReviews(client, guildId);
    return reviews.find(item => item.reviewId === String(reviewId)) || null;
}

export async function cancelPendingEmployeeExitReviews(client, guildId, userId) {
    await requireDatabase(client);
    const id = String(userId || '');
    if (!SNOWFLAKE_RE.test(id)) return [];
    const reviews = await readReviews(client, guildId);
    const now = new Date().toISOString();
    const cancelled = [];
    const next = reviews.map(review => {
        if (review.userId !== id || !['pending', 'processing'].includes(review.status)) return review;
        const value = { ...review, status: 'cancelled', resolvedAt: now, resolvedBy: null, reason: 'Membership role was restored before Management finalized the exit review.', claimedAt: null, claimedBy: null };
        cancelled.push(value);
        return value;
    });
    if (cancelled.length) await writeReviews(client, guildId, next);
    return cancelled;
}

export async function claimEmployeeExitReview(client, guildId, reviewId, claimedBy) {
    await requireDatabase(client);
    const reviews = await readReviews(client, guildId);
    const index = reviews.findIndex(item => item.reviewId === String(reviewId));
    if (index < 0) throw new Error('Exit Review tidak ditemukan.');
    const existing = reviews[index];
    const staleProcessing = existing.status === 'processing'
        && Date.now() - new Date(existing.claimedAt || 0).getTime() > 5 * 60_000;
    if (existing.status === 'resolved') throw new Error('Exit Review ini sudah diselesaikan.');
    if (existing.status === 'processing' && !staleProcessing) throw new Error('Exit Review ini sedang diproses oleh Management lain.');
    reviews[index] = {
        ...existing,
        status: 'processing',
        claimedAt: new Date().toISOString(),
        claimedBy: SNOWFLAKE_RE.test(String(claimedBy || '')) ? String(claimedBy) : null,
    };
    await writeReviews(client, guildId, reviews);
    return reviews[index];
}

export async function releaseEmployeeExitReview(client, guildId, reviewId) {
    await requireDatabase(client);
    const reviews = await readReviews(client, guildId);
    const index = reviews.findIndex(item => item.reviewId === String(reviewId));
    if (index < 0 || reviews[index].status !== 'processing') return null;
    reviews[index] = { ...reviews[index], status: 'pending', claimedAt: null, claimedBy: null };
    await writeReviews(client, guildId, reviews);
    return reviews[index];
}

export async function completeEmployeeExitReview(client, guildId, reviewId, { outcome, reason = '', recordId, resolvedBy } = {}) {
    await requireDatabase(client);
    if (!['sign_out', 'resignation', 'dismissal'].includes(outcome)) throw new Error('Klasifikasi keluar tidak valid.');
    const reviews = await readReviews(client, guildId);
    const index = reviews.findIndex(item => item.reviewId === String(reviewId));
    if (index < 0) throw new Error('Exit Review tidak ditemukan.');
    if (reviews[index].status !== 'processing') throw new Error('Exit Review belum diklaim untuk diproses.');
    reviews[index] = {
        ...reviews[index],
        status: 'resolved',
        outcome,
        reason: cleanText(reason, 900),
        recordId: cleanText(recordId, 64),
        resolvedAt: new Date().toISOString(),
        resolvedBy: SNOWFLAKE_RE.test(String(resolvedBy || '')) ? String(resolvedBy) : null,
        claimedAt: null,
        claimedBy: null,
    };
    await writeReviews(client, guildId, reviews);
    return reviews[index];
}
