import { AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import {
    EMPLOYEE_LOG_TYPES,
    getEmployeeAutoRoleConfig,
    getEmployeeLogRecord,
    updateEmployeeLogRecord,
    sendEmployeeLog,
} from './employeeLogsService.js';
import {
    BASE_EMPLOYEE_ROLE,
    getEmployeeRoleRegistry,
    employeeRoleToCatalogEntry,
} from './employeeRoleRegistryService.js';
import { getEmployeeDirectoryRecord } from './employeeDirectoryService.js';

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
        .filter(item => item.meta?.active && item.meta.position !== false && item.meta.kind !== 'division')
        .sort((a, b) => (b.meta.level ?? 0) - (a.meta.level ?? 0));
    return candidates[0] ? { id: candidates[0].id, ...candidates[0].meta } : null;
}

function bestDivisionRole(roleIds, catalog = SKAW_EMPLOYEE_ROLE_CATALOG) {
    const candidates = roleIds
        .map(id => ({ id, meta: catalog[id] }))
        .filter(item => item.meta?.active && item.meta.kind === 'division')
        .sort((a, b) => (b.meta.level ?? 0) - (a.meta.level ?? 0));
    return candidates[0] ? { id: candidates[0].id, ...candidates[0].meta } : null;
}

function classifyPositionTransition(previous, next) {
    if (!previous || !next || previous.id === next.id) return null;
    // A division marker is a department membership role, not a rank itself.
    // Division <-> first rank changes are not Promotion/Demotion events.
    // The persisted directory position detects the eventual rank transition when
    // the new rank is assigned in a separate Discord event.
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

function directoryPositionRole(profile, catalog) {
    const position = profile?.currentPosition;
    const id = String(position?.id || '');
    if (!/^\d{17,20}$/.test(id)) return null;
    const metadata = catalog[id] || {
        name: position?.name || 'Previous Position',
        domain: 'unknown',
        level: 0,
        kind: 'position',
        active: true,
        position: true,
    };
    if (metadata.kind === 'division' || metadata.position === false) return null;
    return { id, ...metadata };
}

async function readSignInContext(client, guildId, profile) {
    const recordId = String(profile?.lastSignInRecordId || '');
    if (!recordId) return null;
    const record = await getEmployeeLogRecord(client, guildId, recordId).catch(() => null);
    return record?.type === 'sign_in' ? record : null;
}

/**
 * When Company Staff is assigned before Division/Position, enrich the same
 * automatic Sign-In record once the roles arrive. Never turn the initial
 * placement into a second Sign-In or a false Promotion.
 */
async function syncInitialSignInContext(client, guild, memberId, roleIds, catalog, profile) {
    if (!profile || profile.status !== 'active' || !profile.lastSignInRecordId) return false;
    if (profile.lastPositionRecordId && profile.lastPositionRecordId !== profile.lastSignInRecordId) return false;

    const record = await readSignInContext(client, guild.id, profile);
    if (!record || record.automatic !== true) return false;

    const division = bestDivisionRole(roleIds, catalog);
    const position = bestPositionRole(roleIds, catalog);
    const savedDivision = String(record.data?.division || '');
    const savedPosition = String(record.data?.position || '');
    const nextDivision = savedDivision || division?.id || '';
    let nextPosition = savedPosition;
    if (!savedPosition && !profile.currentPosition) nextPosition = position?.id || '';

    if (nextDivision === savedDivision && nextPosition === savedPosition) return false;
    await updateEmployeeLogRecord(client, guild.id, record.recordId, {
        reason: record.data?.reason || '',
        notes: record.data?.notes || '',
        reasonCategory: record.data?.reasonCategory || '',
        division: nextDivision,
        position: nextPosition,
    }, null);
    return true;
}

async function getExitContext(client, guild, profile, oldRoleIds, catalog) {
    let division = bestDivisionRole(oldRoleIds, catalog)?.id || '';
    let position = bestPositionRole(oldRoleIds, catalog)?.id || String(profile?.currentPosition?.id || '');
    const signInRecord = await readSignInContext(client, guild.id, profile);
    if (!division) division = String(signInRecord?.data?.division || '');
    if (!position) position = String(signInRecord?.data?.position || '');
    return { division, position };
}

function makeCareerDecision(previous, next, memberId) {
    if (!previous || !next || previous.id === next.id) return null;
    const type = classifyPositionTransition(previous, next);
    if (!type) return null;
    const data = { userId: memberId, reason: '', notes: '' };
    if (type === 'promotion' || type === 'demote') {
        data.previousRank = previous.id;
        data.newRank = next.id;
    } else if (type === 'mutation') {
        data.fromRole = previous.id;
        data.toRole = next.id;
        data.position = next.id;
    }
    return EMPLOYEE_LOG_TYPES[type] ? { type, data } : null;
}

async function processEmployeeLogsRoleSnapshot(client, guild, memberId, oldRoleIds, newRoleIds, displayName = '') {
    if (!client?.db || !guild || !memberId) return { skipped: 'missing-context' };
    const autoConfig = await getEmployeeAutoRoleConfig(client, guild.id);
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
    const profile = await getEmployeeDirectoryRecord(client, guild.id, memberId).catch(() => null);
    const isBlacklisted = [...oldRoleIds, ...newRoleIds].some(id => catalog[id]?.kind === 'blacklist');

    let decisions = [];
    let updatedSignInContext = false;

    // Company Staff is the membership switch. Removing it publishes Sign-Out
    // immediately; Management can edit its category later without a review queue.
    if (hadMembership && !hasMembership) {
        const context = await getExitContext(client, guild, profile, oldRoleIds, catalog);
        decisions.push({
            type: 'sign_out',
            data: {
                userId: memberId,
                division: context.division,
                position: context.position,
                reasonCategory: isBlacklisted ? 'blacklist' : '',
                reason: '',
                notes: '',
            },
        });
        // Blacklist/Warning remain independent logs, even when Sign-Out happens
        // in the same role update. This deliberately allows two messages.
        decisions.push(...classifyEmployeeRoleChange(oldRoleIds, newRoleIds, memberId, catalog)
            .filter(decision => ['blacklist', 'warning'].includes(decision.type)));
    } else if (!hadMembership && hasMembership) {
        const position = bestPositionRole(newRoleIds, catalog);
        const division = bestDivisionRole(newRoleIds, catalog);
        decisions.push({
            type: 'sign_in',
            data: { userId: memberId, division: division?.id || '', position: position?.id || '', reason: '', notes: '' },
        });
        // If a warning/blacklist role was added in this same update, keep its
        // own log alongside Sign-In.
        decisions.push(...classifyEmployeeRoleChange(oldRoleIds, newRoleIds, memberId, catalog)
            .filter(decision => ['blacklist', 'warning'].includes(decision.type)));
    } else if (hadMembership && hasMembership) {
        decisions.push(...classifyEmployeeRoleChange(oldRoleIds, newRoleIds, memberId, catalog)
            .filter(decision => ['blacklist', 'warning'].includes(decision.type)));

        const previousPosition = directoryPositionRole(profile, catalog);
        const newPosition = bestPositionRole(newRoleIds, catalog);
        const changedPositionRole = [...added, ...removed].some(id =>
            catalog[id]?.active && catalog[id]?.position !== false && catalog[id]?.kind !== 'division');
        if (changedPositionRole && profile?.status === 'active' && previousPosition && newPosition) {
            const career = makeCareerDecision(previousPosition, newPosition, memberId);
            if (career) decisions.push(career);
        }
        if (!decisions.some(decision => ['promotion', 'demote', 'mutation'].includes(decision.type))) {
            updatedSignInContext = await syncInitialSignInContext(client, guild, memberId, newRoleIds, catalog, profile)
                .catch(error => {
                    console.warn('[Employee Auto Logs] Could not update initial Sign-In context:', error?.message || error);
                    return false;
                });
        }
    } else {
        // Division and Position roles assigned before Company Staff are context
        // only. They are included in Sign-In when the membership role is added.
        // Warning and Blacklist still log independently when assigned.
        decisions.push(...classifyEmployeeRoleChange(oldRoleIds, newRoleIds, memberId, catalog)
            .filter(decision => ['blacklist', 'warning'].includes(decision.type)));
    }

    if (!decisions.length) {
        return { skipped: updatedSignInContext ? 'sign-in-context-updated' : 'no-mapped-activity', updatedSignInContext };
    }

    const actorId = await findAuditActor(guild, memberId, added, removed);
    const results = [];
    // Publish sequentially so a Sign-Out and its independent Blacklist record
    // both appear in the correct configured channels.
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
    return { processed: results.length > 0, updatedSignInContext, results };
}

const memberProcessingQueue = new Map();

/**
 * Process every real GuildMemberUpdate immediately, serializing updates per
 * employee. The old 1.2s debounce and 15s persisted dedupe dropped valid repeated
 * role changes and hid logs during rapid testing.
 */
export async function handleEmployeeLogsRoleUpdate(oldMember, newMember, explicitClient = null) {
    const client = explicitClient || newMember?.client;
    const guild = newMember?.guild;
    if (!client?.db || !guild || !oldMember || !newMember) return { skipped: 'missing-context' };
    if (newMember.user?.bot || newMember.id !== oldMember.id) return { skipped: 'not-a-human-member' };

    // Queue immediately after capturing the old/new snapshots. Checking config
    // before queueing would allow two overlapping gateway updates to enqueue out
    // of order when database reads complete at different times.
    const oldRoleIds = normalizeIds(oldMember.roles?.cache);
    const newRoleIds = normalizeIds(newMember.roles?.cache);
    const { added, removed } = diffRoleIds(oldRoleIds, newRoleIds);
    if (!added.length && !removed.length) return { skipped: 'no-role-change' };

    const key = `${guild.id}:${newMember.id}`;
    const previous = memberProcessingQueue.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => processEmployeeLogsRoleSnapshot(
        client,
        guild,
        String(newMember.id),
        oldRoleIds,
        newRoleIds,
        String(newMember.displayName || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100),
    ));
    memberProcessingQueue.set(key, operation);
    try {
        return await operation;
    } finally {
        if (memberProcessingQueue.get(key) === operation) memberProcessingQueue.delete(key);
    }
}
