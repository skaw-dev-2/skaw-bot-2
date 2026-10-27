import { AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import {
    EMPLOYEE_LOG_TYPES,
    getEmployeeAutoRoleConfig,
    sendEmployeeLog,
} from './employeeLogsService.js';
import {
    BASE_EMPLOYEE_ROLE,
    getEmployeeRoleRegistry,
    employeeRoleToCatalogEntry,
    createEmployeeExitReview,
    cancelPendingEmployeeExitReviews,
} from './employeeRoleRegistryService.js';
import { getEmployeeDirectoryRecord } from './employeeDirectoryService.js';

const DEDUPE_KEY = guildId => `guild:${guildId}:employee_logs:auto_role_dedupe`;
const DEDUPE_WINDOW_MS = 15_000;
const DEDUPE_STORE_WINDOW_MS = 10 * 60_000;
const recentInProcess = new Map();

/**
 * SKAW role catalogue. IDs are the values supplied by Management.
 * `active` means this role identifies a current employee/partner position.
 * `position` excludes non-positional/access roles from rank classification.
 */
export const SKAW_EMPLOYEE_ROLE_CATALOG = Object.freeze({
    '1432365826136080625': { name: 'Chief Executive Officer | SKAW', domain: 'management', level: 6, kind: 'position', active: true, position: true },
    '1432366070911598794': { name: 'Chief Operation Officer | SKAW', domain: 'management', level: 6, kind: 'position', active: true, position: true },
    '1432367796515373056': { name: 'Chief Financial Officer | SKAW', domain: 'management', level: 6, kind: 'position', active: true, position: true },
    '1466364388117315665': { name: 'Chief Marketing Officer | SKAW', domain: 'management', level: 6, kind: 'position', active: true, position: true },
    '1432367493242032309': { name: 'Human Resources Officer | SKAW', domain: 'management', level: 5, kind: 'position', active: true, position: true },
    '1471649299967512587': { name: 'Chief Creative Officer | SKAW', domain: 'management', level: 6, kind: 'position', active: true, position: true },
    '1466363836951957801': { name: 'Chief Mechanic Officer | SKAW', domain: 'mechanic', level: 5, kind: 'position', active: true, position: true },
    '1466364144180527241': { name: 'Chief Builder Officer | SKAW', domain: 'builder', level: 5, kind: 'position', active: true, position: true },
    '1466364014606159934': { name: 'Chief Trucker Officer | SKAW', domain: 'trucker', level: 5, kind: 'position', active: true, position: true },

    '1466084643001602081': { name: 'Deputy Operation Officer | SKAW', domain: 'management', level: 4, kind: 'position', active: true, position: true },
    '1466363661621792823': { name: 'Deputy Financial Officer | SKAW', domain: 'management', level: 4, kind: 'position', active: true, position: true },
    '1466375043138191380': { name: 'Deputy Marketing Officer | SKAW', domain: 'management', level: 4, kind: 'position', active: true, position: true },
    '1466365041468117083': { name: 'Deputy Mechanic Officer | SKAW', domain: 'mechanic', level: 4, kind: 'position', active: true, position: true },
    '1466364841282506783': { name: 'Deputy Trucker Officer | SKAW', domain: 'trucker', level: 4, kind: 'position', active: true, position: true },
    '1466365148708081859': { name: 'Deputy Builder Officer | SKAW', domain: 'builder', level: 4, kind: 'position', active: true, position: true },
    '1432368240012689559': { name: 'Executive Workshop', domain: 'mechanic', level: 4, kind: 'position', active: true, position: true },
    '1432368698664161300': { name: 'Executive Trucker', domain: 'trucker', level: 4, kind: 'position', active: true, position: true },
    '1414623053471547474': { name: 'Management Company | SKAW', domain: 'management', level: 4, kind: 'position', active: true, position: true },

    '1414623346452336823': { name: 'Partnership Company | SKAW', domain: 'partner', level: 1, kind: 'position', active: true, position: true },

    '1414623229288513586': { name: 'Mechanic Division | SKAW', domain: 'mechanic', level: 0, kind: 'division', active: true, position: true },
    '1414629366574354512': { name: 'Mechanic Senior | SKAW', domain: 'mechanic', level: 3, kind: 'rank', active: true, position: true },
    '1414629274282885120': { name: 'Mechanic Junior | SKAW', domain: 'mechanic', level: 2, kind: 'rank', active: true, position: true },
    '1414629137389322244': { name: 'Mechanic Traine | SKAW', domain: 'mechanic', level: 1, kind: 'rank', active: true, position: true },

    '1414623154151882882': { name: 'Trucker Division | SKAW', domain: 'trucker', level: 0, kind: 'division', active: true, position: true },
    '1414629871774076938': { name: 'Trucker Senior | SKAW', domain: 'trucker', level: 3, kind: 'rank', active: true, position: true },
    '1414629772218339480': { name: 'Trucker Junior | SKAW', domain: 'trucker', level: 2, kind: 'rank', active: true, position: true },
    '1414629606849511545': { name: 'Trucker Traine | SKAW', domain: 'trucker', level: 1, kind: 'rank', active: true, position: true },

    '1521028847380992021': { name: 'Taxi Division | SKAW', domain: 'taxi', level: 0, kind: 'division', active: true, position: true },
    '1521029918635458771': { name: 'Taxi Senior | SKAW', domain: 'taxi', level: 3, kind: 'rank', active: true, position: true },
    '1521029700703752293': { name: 'Taxi Junior | SKAW', domain: 'taxi', level: 2, kind: 'rank', active: true, position: true },
    '1521029569174311124': { name: 'Taxi Traine | SKAW', domain: 'taxi', level: 1, kind: 'rank', active: true, position: true },

    '1456912660510543945': { name: 'Builder 👷 | SKAW', domain: 'builder', level: 1, kind: 'position', active: true, position: true },

    '1429470453575061515': { name: 'Warning (1/2) | SKAW', kind: 'warning', warn: '1/2', active: false, position: false },
    '1429470577286189176': { name: 'Warning (2/2) | SKAW', kind: 'warning', warn: '2/2', active: false, position: false },
    '1414628838557614222': { name: 'Blacklist', kind: 'blacklist', active: false, position: false },
    '1429469335654633593': { name: 'Retired Employe | SKAW', kind: 'retired', active: false, position: false },
    '1415329997396119603': { name: 'Civilian | SKAW', kind: 'civilian', active: false, position: false },
});

function normalizeIds(input) {
    if (!input) return [];
    if (Array.isArray(input)) return input.map(String);
    if (input instanceof Set) return [...input].map(String);
    if (typeof input.values === 'function') {
        return [...input.values()].map(item => String(item?.id || item));
    }
    return [];
}

function activeRoleIds(roleIds, catalog = SKAW_EMPLOYEE_ROLE_CATALOG) {
    return roleIds.filter(id => catalog[id]?.active === true);
}

function bestPositionRole(roleIds, catalog = SKAW_EMPLOYEE_ROLE_CATALOG) {
    const candidates = roleIds
        .map(id => ({ id, meta: catalog[id] }))
        .filter(item => item.meta?.active && item.meta.position !== false)
        .sort((a, b) => (b.meta.level ?? 0) - (a.meta.level ?? 0));
    return candidates[0] ? { id: candidates[0].id, ...candidates[0].meta } : null;
}

function classifyPositionTransition(previous, next) {
    if (!previous || !next || previous.id === next.id) return null;
    // A division marker is a department membership role, not a rank itself.
    // Division <-> first rank changes can happen in separate Discord updates;
    // don't mislabel either direction as Promotion/Demotion. The coalescer below
    // handles quick multi-role assignments as one transition where possible.
    if (previous.domain === next.domain
        && (previous.kind === 'division' || next.kind === 'division')) return null;
    if (previous.domain === next.domain) {
        if ((next.level ?? 0) > (previous.level ?? 0)) return 'promotion';
        if ((next.level ?? 0) < (previous.level ?? 0)) return 'demote';
        return 'mutation';
    }
    // Cross-department changes are Mutation except transitions into/out of the
    // general Management ladder, where rank level determines the result.
    if (next.domain === 'management' && previous.domain !== 'management') {
        return (next.level ?? 0) >= (previous.level ?? 0) ? 'promotion' : 'demote';
    }
    if (previous.domain === 'management' && next.domain !== 'management') {
        return (next.level ?? 0) < (previous.level ?? 0) ? 'demote' : 'mutation';
    }
    return 'mutation';
}

/**
 * Pure classifier used by the GuildMemberUpdate listener and automated tests.
 * A single update may legitimately issue a Warning/Blacklist and a career log.
 */
export function classifyEmployeeRoleChange(oldRoleIdsInput, newRoleIdsInput, userId = '0', catalog = SKAW_EMPLOYEE_ROLE_CATALOG) {
    const oldRoleIds = normalizeIds(oldRoleIdsInput);
    const newRoleIds = normalizeIds(newRoleIdsInput);
    const oldSet = new Set(oldRoleIds);
    const newSet = new Set(newRoleIds);
    const addedIds = [...newSet].filter(id => !oldSet.has(id));
    const removedIds = [...oldSet].filter(id => !newSet.has(id));
    if (!addedIds.length && !removedIds.length) return [];

    const decisions = [];
    const addedBlacklist = addedIds.some(id => catalog[id]?.kind === 'blacklist');
    if (addedBlacklist) {
        const oldPosition = bestPositionRole(oldRoleIds, catalog);
        const newPosition = bestPositionRole(newRoleIds, catalog);
        decisions.push({
            type: 'blacklist',
            data: { userId, position: oldPosition?.id || newPosition?.id || '', reason: '', notes: '' },
        });
    }

    const addedWarnings = addedIds
        .map(id => ({ id, meta: catalog[id] }))
        .filter(item => item.meta?.kind === 'warning')
        .sort((a, b) => Number(b.meta.warn.split('/')[0]) - Number(a.meta.warn.split('/')[0]));
    if (addedWarnings.length) {
        const warning = addedWarnings[0];
        const position = bestPositionRole(newRoleIds, catalog) || bestPositionRole(oldRoleIds, catalog);
        decisions.push({
            type: 'warning',
            data: { userId, position: position?.id || '', warn: warning.meta.warn, reason: '', notes: '' },
        });
    }

    const oldActive = activeRoleIds(oldRoleIds, catalog);
    const newActive = activeRoleIds(newRoleIds, catalog);
    if (oldActive.length === 0 && newActive.length > 0) {
        const position = bestPositionRole(newRoleIds, catalog) || bestPositionRole(newActive, catalog);
        decisions.push({ type: 'sign_in', data: { userId, position: position?.id || '', reason: '', notes: '' } });
        return decisions;
    }
    const isExitRoleAdded = addedIds.some(id => ['retired', 'civilian'].includes(catalog[id]?.kind));
    const activeRoleRemoved = removedIds.some(id => catalog[id]?.active === true);
    if (oldActive.length > 0 && (
        newActive.length === 0 || (isExitRoleAdded && activeRoleRemoved)
    )) {
        // Retired/Civilian is an explicit exit transition per SKAW's workflow.
        // Don't require every stale rank marker to have been removed in the same
        // gateway payload before producing Sign-Out.
        const position = bestPositionRole(oldRoleIds, catalog) || bestPositionRole(oldActive, catalog);
        decisions.push({ type: 'sign_out', data: { userId, position: position?.id || '', reason: '', notes: '' } });
        return decisions;
    }

    if (oldActive.length > 0 && newActive.length > 0) {
        const oldPosition = bestPositionRole(oldRoleIds, catalog);
        const newPosition = bestPositionRole(newRoleIds, catalog);
        const changedPositionIds = [...addedIds, ...removedIds].filter(id => {
            const meta = catalog[id];
            return meta?.active && meta.position !== false;
        });
        const positionChanged = changedPositionIds.length > 0 && oldPosition && newPosition && oldPosition.id !== newPosition.id;
        if (positionChanged) {
            const type = classifyPositionTransition(oldPosition, newPosition);
            if (type && EMPLOYEE_LOG_TYPES[type]) {
                const data = { userId, reason: '', notes: '' };
                if (type === 'promotion' || type === 'demote') {
                    data.previousRank = oldPosition.id;
                    data.newRank = newPosition.id;
                } else if (type === 'mutation') {
                    data.fromRole = oldPosition.id;
                    data.toRole = newPosition.id;
                    data.position = newPosition.id;
                }
                decisions.push({ type, data });
            }
        }
    }
    return decisions;
}

function diffRoleIds(oldRoleIds, newRoleIds) {
    const oldSet = new Set(oldRoleIds);
    const newSet = new Set(newRoleIds);
    return {
        added: [...newSet].filter(id => !oldSet.has(id)).sort(),
        removed: [...oldSet].filter(id => !newSet.has(id)).sort(),
    };
}

function signatureFor(guildId, memberId, added, removed) {
    return `${guildId}:${memberId}:A[${added.join(',')}]:R[${removed.join(',')}]`;
}

async function wasRecentlyProcessed(client, guildId, signature) {
    const now = Date.now();
    const localTime = recentInProcess.get(signature);
    if (localTime && now - localTime < DEDUPE_WINDOW_MS) return true;
    recentInProcess.set(signature, now);
    if (recentInProcess.size > 1000) {
        for (const [key, timestamp] of recentInProcess) {
            if (now - timestamp > DEDUPE_STORE_WINDOW_MS) recentInProcess.delete(key);
        }
    }

    try {
        const raw = await client.db.get(DEDUPE_KEY(guildId), {});
        const map = raw && typeof raw === 'object' ? raw : {};
        if (map[signature] && now - Number(map[signature]) < DEDUPE_WINDOW_MS) return true;
    } catch (error) {
        console.warn('[Employee Auto Logs] Could not read duplicate-event state:', error?.message || error);
    }
    return false;
}

async function markProcessed(client, guildId, signature) {
    try {
        const now = Date.now();
        const raw = await client.db.get(DEDUPE_KEY(guildId), {});
        const map = raw && typeof raw === 'object' ? raw : {};
        for (const [key, timestamp] of Object.entries(map)) {
            if (now - Number(timestamp) > DEDUPE_STORE_WINDOW_MS) delete map[key];
        }
        map[signature] = now;
        const entries = Object.entries(map).sort((a, b) => Number(a[1]) - Number(b[1]));
        await client.db.set(DEDUPE_KEY(guildId), Object.fromEntries(entries.slice(-300)));
    } catch (error) {
        console.warn('[Employee Auto Logs] Could not persist duplicate-event state:', error?.message || error);
    }
}

async function findAuditActor(guild, memberId, addedIds, removedIds) {
    try {
        const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
        if (!me?.permissions?.has(PermissionFlagsBits.ViewAuditLog)) return null;
        const audit = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 8 });
        const now = Date.now();
        for (const entry of audit.entries.values()) {
            const targetId = String(entry.targetId || entry.target?.id || '');
            if (targetId !== String(memberId) || now - entry.createdTimestamp > 15_000) continue;
            const changes = Array.isArray(entry.changes) ? entry.changes : [];
            const auditAdded = new Set();
            const auditRemoved = new Set();
            for (const change of changes) {
                const source = change.key === '$add'
                    ? change.new
                    : change.key === '$remove'
                        ? change.old
                        : (Array.isArray(change.new) ? change.new : change.old);
                const ids = (Array.isArray(source) ? source : [])
                    .map(item => String(item?.id || item))
                    .filter(id => /^\d{17,20}$/.test(id));
                if (change.key === '$add') ids.forEach(id => auditAdded.add(id));
                if (change.key === '$remove') ids.forEach(id => auditRemoved.add(id));
            }
            const overlap = addedIds.some(id => auditAdded.has(id)) || removedIds.some(id => auditRemoved.has(id));
            // Only attribute an actor when audit log changes match at least one role
            // from this gateway update. This avoids guessing from a nearby audit entry.
            if (!overlap) continue;
            if (entry.executorId && /^\d{17,20}$/.test(String(entry.executorId))) return String(entry.executorId);
        }
    } catch {
        // View Audit Log is optional. The Employee Log still works and attributes
        // the record to SKAW Bot when the executor cannot be determined reliably.
    }
    return null;
}

const pendingRoleChanges = new Map();
const ROLE_CHANGE_COALESCE_MS = 1_200;

async function processEmployeeLogsRoleSnapshot(client, guild, memberId, oldRoleIds, newRoleIds, displayName = '') {
    if (!client?.db || !guild || !memberId) return { skipped: 'missing-context' };
    const autoConfig = await getEmployeeAutoRoleConfig(client, guild.id);
    // Re-check at flush time so disabling Auto Role cancels pending publications.
    if (!autoConfig.enabled) return { skipped: 'disabled' };

    const { added, removed } = diffRoleIds(oldRoleIds, newRoleIds);
    if (!added.length && !removed.length) return { skipped: 'no-role-change' };

    const registry = await getEmployeeRoleRegistry(client, guild.id);
    const dynamicCatalog = Object.fromEntries(registry.roles
        .filter(role => role.active)
        .map(role => [role.id, employeeRoleToCatalogEntry(role)])
        .filter(([, value]) => value));
    const catalog = {
        ...SKAW_EMPLOYEE_ROLE_CATALOG,
        ...dynamicCatalog,
        [BASE_EMPLOYEE_ROLE.id]: {
            name: BASE_EMPLOYEE_ROLE.name,
            domain: 'company',
            level: 0,
            kind: 'membership',
            active: false,
            position: false,
        },
    };
    const hadMembership = oldRoleIds.includes(BASE_EMPLOYEE_ROLE.id);
    const hasMembership = newRoleIds.includes(BASE_EMPLOYEE_ROLE.id);
    const signature = signatureFor(guild.id, memberId, added, removed);
    if (await wasRecentlyProcessed(client, guild.id, signature)) return { skipped: 'duplicate-event' };

    // Company Staff is the source of truth for membership. Its removal creates a
    // review item; Management decides whether the exit is Sign Out, Resignation,
    // or Dismissal. Do not publish three competing exit records.
    if (hadMembership && !hasMembership) {
        const existingProfile = await getEmployeeDirectoryRecord(client, guild.id, memberId).catch(() => null);
        const hasRecentExitRecord = existingProfile?.status === 'former'
            && ['sign_out', 'resignation', 'dismissal'].includes(existingProfile.lastExitType);
        if (hasRecentExitRecord) {
            await markProcessed(client, guild.id, signature);
            return { skipped: 'exit-already-recorded' };
        }
        const oldPosition = bestPositionRole(oldRoleIds, catalog);
        const actorId = await findAuditActor(guild, memberId, added, removed);
        const review = await createEmployeeExitReview(client, guild.id, {
            userId: memberId,
            displayName,
            formerPositionId: oldPosition?.id || '',
            formerPositionName: oldPosition?.name || '',
            detectedBy: actorId || '',
        });
        await markProcessed(client, guild.id, signature);
        return { queuedReview: true, reviewId: review.reviewId, duplicateReview: review.duplicate === true };
    }

    let decisions = [];
    if (!hadMembership && hasMembership) {
        const cancelledReviews = await cancelPendingEmployeeExitReviews(client, guild.id, memberId);
        if (cancelledReviews.length) {
            // The member returned before Management finalized the exit. This was
            // not a completed departure, so cancel the pending review without
            // publishing a fake Sign-In/Sign-Out pair.
            await markProcessed(client, guild.id, signature);
            return { skipped: 'exit-review-cancelled', cancelledReview: true };
        }
        const position = bestPositionRole(newRoleIds, catalog);
        decisions = [{
            type: 'sign_in',
            data: { userId: memberId, position: position?.id || '', reason: '', notes: '' },
        }];
    } else if (hadMembership && hasMembership) {
        decisions = classifyEmployeeRoleChange(oldRoleIds, newRoleIds, memberId, catalog)
            .filter(decision => decision.type !== 'sign_in' && decision.type !== 'sign_out');
    } else {
        // Backward-compatible mode for role changes while the base membership
        // role is not yet assigned to a legacy employee.
        decisions = classifyEmployeeRoleChange(oldRoleIds, newRoleIds, memberId, catalog)
            .filter(decision => decision.type !== 'sign_in' && decision.type !== 'sign_out');
    }

    if (!decisions.length) {
        // Keep the role event recorded as processed to avoid repeated gateway work.
        await markProcessed(client, guild.id, signature);
        return { skipped: 'no-mapped-activity' };
    }

    const actorId = await findAuditActor(guild, memberId, added, removed);
    const results = [];
    for (const decision of decisions) {
        try {
            const payload = {
                ...decision.data,
                userId: memberId,
                displayName: displayName || '',
                recordedBy: actorId || '',
                automatic: true,
                recordId: undefined,
                recordedAt: undefined,
            };
            const result = await sendEmployeeLog(client, guild, decision.type, payload);
            results.push({ type: decision.type, recordId: result.recordId, messageId: result.message.id });
        } catch (error) {
            console.error(`[Employee Auto Logs] Failed to publish ${decision.type} for ${memberId}:`, error?.message || error);
        }
    }
    if (results.length || !decisions.length) await markProcessed(client, guild.id, signature);
    else recentInProcess.delete(signature);
    return { processed: results.length > 0, results };
}
/**
 * Collects quick role updates for one member into a single transition.
 * Discord emits guildMemberUpdate for every role mutation; a short coalescing
 * window avoids false intermediate demotions/promotions when a bot assigns the
 * department role and rank in separate API calls.
 */
export async function handleEmployeeLogsRoleUpdate(oldMember, newMember, explicitClient = null) {
    const client = explicitClient || newMember?.client;
    const guild = newMember?.guild;
    if (!client?.db || !guild || !oldMember || !newMember) return { skipped: 'missing-context' };
    if (newMember.user?.bot || newMember.id !== oldMember.id) return { skipped: 'not-a-human-member' };

    const autoConfig = await getEmployeeAutoRoleConfig(client, guild.id);
    if (!autoConfig.enabled) return { skipped: 'disabled' };

    const oldRoleIds = normalizeIds(oldMember.roles?.cache);
    const newRoleIds = normalizeIds(newMember.roles?.cache);
    if (!diffRoleIds(oldRoleIds, newRoleIds).added.length && !diffRoleIds(oldRoleIds, newRoleIds).removed.length) {
        return { skipped: 'no-role-change' };
    }

    const key = `${guild.id}:${newMember.id}`;
    const previous = pendingRoleChanges.get(key);
    if (previous?.timer) clearTimeout(previous.timer);

    const pending = {
        client,
        guild,
        memberId: String(newMember.id),
        displayName: String(newMember.displayName || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100),
        // Preserve the state before the first quick change and the latest state after it.
        oldRoleIds: previous?.oldRoleIds || oldRoleIds,
        newRoleIds,
        timer: null,
    };
    pending.timer = setTimeout(() => {
        pendingRoleChanges.delete(key);
        processEmployeeLogsRoleSnapshot(
            pending.client,
            pending.guild,
            pending.memberId,
            pending.oldRoleIds,
            pending.newRoleIds,
            pending.displayName,
        ).catch(error => {
            console.error('[Employee Auto Logs] Failed to process coalesced role update:', error?.stack || error);
        });
    }, ROLE_CHANGE_COALESCE_MS);
    pending.timer.unref?.();
    pendingRoleChanges.set(key, pending);
    return { queued: true, coalesceMs: ROLE_CHANGE_COALESCE_MS };
}
