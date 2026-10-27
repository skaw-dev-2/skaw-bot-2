const INDEX_KEY = guildId => `guild:${guildId}:employee_directory:index`;
const ENTRY_KEY = (guildId, userId) => `guild:${guildId}:employee_directory:member:${userId}`;
const SNOWFLAKE_RE = /^\d{17,20}$/;
const HISTORY_LIMIT = 100;
const writeQueues = new Map();

function clean(value, maxLength = 1000) {
    return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanId(value) {
    const id = String(value ?? '');
    return SNOWFLAKE_RE.test(id) ? id : '';
}

function queueWrite(key, task) {
    const previous = writeQueues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    writeQueues.set(key, current);
    return current.finally(() => {
        if (writeQueues.get(key) === current) writeQueues.delete(key);
    });
}

function emptyEntry(guildId, userId, displayName, at) {
    return {
        schemaVersion: 1,
        guildId: String(guildId),
        userId: String(userId),
        displayName: clean(displayName, 100) || 'Unknown member',
        status: 'unknown',
        currentPosition: null,
        lastKnownPosition: null,
        firstSignInAt: null,
        firstSignInRecordId: null,
        lastSignInAt: null,
        lastSignInRecordId: null,
        lastSignOutAt: null,
        lastSignOutRecordId: null,
        lastSignOutReason: '',
        lastExitType: null,
        lastPositionRecordId: null,
        latestStateEventAt: null,
        everBlacklisted: false,
        lastBlacklistAt: null,
        lastBlacklistRecordId: null,
        lastBlacklistReason: '',
        lastWarningAt: null,
        history: [],
        createdAt: at,
        updatedAt: at,
    };
}

function snapshotRole(guild, roleId, fallbackName = '') {
    const id = cleanId(roleId);
    if (!id) return null;
    const role = guild?.roles?.cache?.get?.(id) || null;
    const name = clean(role?.name || fallbackName, 100) || `<@&${id}>`;
    return { id, name };
}

function eventPositions(record, guild, previousEntry) {
    const data = record.data || {};
    const current = previousEntry?.currentPosition || null;
    let beforeId = '';
    let afterId = '';

    if (record.type === 'promotion' || record.type === 'demote') {
        beforeId = data.previousRank;
        afterId = data.newRank;
    } else if (record.type === 'mutation') {
        beforeId = data.fromRole;
        afterId = data.toRole;
    } else {
        afterId = data.position;
    }

    const before = snapshotRole(guild, beforeId, beforeId && current?.id === String(beforeId) ? current.name : '');
    const after = snapshotRole(guild, afterId,
        afterId && current?.id === String(afterId) ? current.name : '');
    return { before: before || (beforeId ? current : null), after };
}

function buildHistoryEvent(record, positions, previousEvent = null) {
    const data = record.data || {};
    return {
        recordId: String(record.recordId),
        type: String(record.type),
        publishedAt: record.publishedAt || data.recordedAt || record.createdAt || new Date().toISOString(),
        displayName: clean(data.displayName, 100),
        positionBefore: positions.before || previousEvent?.positionBefore || null,
        positionAfter: positions.after || previousEvent?.positionAfter || null,
        reason: clean(data.reason, 900),
        warningLevel: clean(data.warn, 10),
        automatic: record.automatic === true,
    };
}

function updateSummaryFromEvent(entry, event, isNewEvent) {
    const at = event.publishedAt;
    const atMs = new Date(at).getTime();
    const after = event.positionAfter;
    const before = event.positionBefore;

    if (event.displayName) entry.displayName = event.displayName;

    if (!isNewEvent) {
        // Edits may change Reason after publication. Only update summary fields
        // when this exact record is still the source of the displayed summary.
        if (entry.lastSignOutRecordId === event.recordId) entry.lastSignOutReason = event.reason;
        if (entry.lastBlacklistRecordId === event.recordId) entry.lastBlacklistReason = event.reason;
        return;
    }

    const firstSignInMs = entry.firstSignInAt ? new Date(entry.firstSignInAt).getTime() : NaN;
    const lastSignInMs = entry.lastSignInAt ? new Date(entry.lastSignInAt).getTime() : NaN;
    const lastSignOutMs = entry.lastSignOutAt ? new Date(entry.lastSignOutAt).getTime() : NaN;
    const latestStateMs = entry.latestStateEventAt ? new Date(entry.latestStateEventAt).getTime() : NaN;
    const isLatestState = !Number.isFinite(latestStateMs) || !Number.isFinite(atMs) || atMs >= latestStateMs;

    // Keep the earliest known join time and latest sign-in/out times even when
    // one-time backfill discovers older events after a newer record is indexed.
    if (event.type === 'sign_in') {
        if (!Number.isFinite(firstSignInMs) || (Number.isFinite(atMs) && atMs < firstSignInMs)) {
            entry.firstSignInAt = at;
            entry.firstSignInRecordId = event.recordId;
        }
        if (!Number.isFinite(lastSignInMs) || (Number.isFinite(atMs) && atMs >= lastSignInMs)) {
            entry.lastSignInAt = at;
            entry.lastSignInRecordId = event.recordId;
        }
    }

    if (event.type === 'sign_out' || event.type === 'resignation' || event.type === 'dismissal') {
        if (!Number.isFinite(lastSignOutMs) || (Number.isFinite(atMs) && atMs >= lastSignOutMs)) {
            entry.lastSignOutAt = at;
            entry.lastSignOutRecordId = event.recordId;
            entry.lastSignOutReason = event.reason;
            entry.lastExitType = event.type;
        }
    }

    if (isLatestState) entry.latestStateEventAt = at;

    switch (event.type) {
        case 'sign_in':
            if (isLatestState) {
                entry.status = 'active';
                entry.currentPosition = after || entry.currentPosition || null;
                entry.lastKnownPosition = entry.currentPosition || entry.lastKnownPosition || null;
                entry.lastPositionRecordId = event.recordId;
            }
            break;
        case 'sign_out':
        case 'resignation':
        case 'dismissal':
            if (isLatestState) {
                entry.status = 'former';
                entry.lastKnownPosition = before || after || entry.currentPosition || entry.lastKnownPosition || null;
                entry.currentPosition = null;
                entry.lastPositionRecordId = event.recordId;
            }
            break;
        case 'promotion':
        case 'demote':
        case 'mutation':
            if (isLatestState) {
                entry.lastKnownPosition = after || entry.currentPosition || entry.lastKnownPosition || null;
                if (entry.status === 'active') entry.currentPosition = after || entry.currentPosition || null;
                entry.lastPositionRecordId = event.recordId;
            }
            break;
        case 'blacklist':
            entry.everBlacklisted = true;
            if (!entry.lastBlacklistAt || !Number.isFinite(new Date(entry.lastBlacklistAt).getTime())
                || (Number.isFinite(atMs) && atMs >= new Date(entry.lastBlacklistAt).getTime())) {
                entry.lastBlacklistAt = at;
                entry.lastBlacklistRecordId = event.recordId;
                entry.lastBlacklistReason = event.reason;
            }
            if (!entry.lastKnownPosition && (after || before)) entry.lastKnownPosition = after || before;
            break;
        case 'warning':
            if (!entry.lastWarningAt || !Number.isFinite(new Date(entry.lastWarningAt).getTime())
                || (Number.isFinite(atMs) && atMs >= new Date(entry.lastWarningAt).getTime())) {
                entry.lastWarningAt = at;
            }
            break;
        default:
            break;
    }
}
export async function getEmployeeDirectoryIndex(client, guildId) {
    if (!client?.db || !guildId) return [];
    const raw = await client.db.get(INDEX_KEY(guildId), []);
    return Array.isArray(raw) ? raw.filter(item => cleanId(item?.userId)) : [];
}

export async function getEmployeeDirectoryRecord(client, guildId, userId) {
    const id = cleanId(userId);
    if (!client?.db || !guildId || !id) return null;
    const raw = await client.db.get(ENTRY_KEY(guildId, id), null);
    if (!raw || String(raw.guildId) !== String(guildId) || String(raw.userId) !== id) return null;
    return raw;
}

export async function refreshEmployeeDirectoryDisplayName(client, guildId, userId, displayName) {
    const id = cleanId(userId);
    const nextName = clean(displayName, 100);
    if (!client?.db || !guildId || !id || !nextName) return null;
    return queueWrite(`${guildId}:${id}`, async () => {
        const entry = await getEmployeeDirectoryRecord(client, guildId, id);
        if (!entry || entry.displayName === nextName) return entry;
        entry.displayName = nextName;
        entry.updatedAt = new Date().toISOString();
        await client.db.set(ENTRY_KEY(guildId, id), entry);
        await queueWrite(`${guildId}:directory-index`, async () => {
            const index = await getEmployeeDirectoryIndex(client, guildId);
            const existingIndex = index.findIndex(item => String(item.userId) === id);
            if (existingIndex < 0) index.push({ userId: id, displayName: nextName, status: entry.status, updatedAt: entry.updatedAt });
            else index[existingIndex] = { ...index[existingIndex], displayName: nextName, status: entry.status, updatedAt: entry.updatedAt };
            index.sort((a, b) => String(a.displayName).localeCompare(String(b.displayName), 'en', { sensitivity: 'base' }));
            await client.db.set(INDEX_KEY(guildId), index);
        });
        return entry;
    });
}

/**
 * Synchronizes one successfully published Employee Log into the searchable
 * directory. This function intentionally does not throw into log publication:
 * the source log remains authoritative if a directory write fails.
 */
export async function upsertEmployeeDirectoryFromLog(client, guild, record) {
    const guildId = String(record?.guildId || guild?.id || '');
    const userId = cleanId(record?.data?.userId);
    if (!client?.db || !guildId || !userId || !record?.recordId || !record?.type) {
        return { skipped: 'missing-context' };
    }

    return queueWrite(`${guildId}:${userId}`, async () => {
        const publishedAt = record.publishedAt || record.data?.recordedAt || new Date().toISOString();
        const old = await getEmployeeDirectoryRecord(client, guildId, userId);
        const liveMember = guild?.members?.cache?.get?.(userId) || null;
        const entry = old || emptyEntry(guildId, userId, record.data?.displayName || liveMember?.displayName, publishedAt);
        entry.displayName = clean(record.data?.displayName || liveMember?.displayName || entry.displayName, 100) || 'Unknown member';
        if (!Array.isArray(entry.history)) entry.history = [];
        entry.updatedAt = new Date().toISOString();
        const positions = eventPositions(record, guild, entry);
        const previousIndex = entry.history.findIndex(item => item.recordId === String(record.recordId));
        const isNewEvent = previousIndex < 0;
        const oldEvent = isNewEvent ? null : entry.history[previousIndex];
        const event = buildHistoryEvent(record, positions, oldEvent);
        if (previousIndex >= 0) entry.history[previousIndex] = event;
        else entry.history.push(event);
        entry.history.sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());
        if (entry.history.length > HISTORY_LIMIT) entry.history = entry.history.slice(-HISTORY_LIMIT);
        updateSummaryFromEvent(entry, event, isNewEvent);

        // Directory profile saved before index: direct-ID lookups can still work
        // if the secondary name index write fails.
        await client.db.set(ENTRY_KEY(guildId, userId), entry);
        await queueWrite(`${guildId}:directory-index`, async () => {
            const index = await getEmployeeDirectoryIndex(client, guildId);
            const summary = {
                userId,
                displayName: entry.displayName,
                status: entry.status,
                updatedAt: entry.updatedAt,
            };
            const existingIndex = index.findIndex(item => String(item.userId) === userId);
            const existingSummary = existingIndex >= 0 ? index[existingIndex] : null;
            const indexChanged = !existingSummary
                || existingSummary.displayName !== summary.displayName
                || existingSummary.status !== summary.status;
            if (existingIndex >= 0 && indexChanged) index[existingIndex] = summary;
            else if (existingIndex < 0) index.push(summary);
            if (indexChanged) {
                index.sort((a, b) => String(a.displayName).localeCompare(String(b.displayName), 'en', { sensitivity: 'base' }));
                await client.db.set(INDEX_KEY(guildId), index);
            }
        });
        return entry;
    });
}

function normalizeQuery(value) {
    return clean(value, 100).toLocaleLowerCase('en-US').normalize('NFKC');
}

export function parseDiscordUserId(value) {
    const input = String(value ?? '').trim();
    const mention = input.match(/^<@!?([0-9]{17,20})>$/);
    const id = mention?.[1] || input;
    return cleanId(id);
}

export async function searchEmployeeDirectory(client, guildId, query, { limit = 25 } = {}) {
    if (!client?.db) throw new Error('Employee directory database is not ready.');
    const directId = parseDiscordUserId(query);
    if (directId) {
        const record = await getEmployeeDirectoryRecord(client, guildId, directId);
        return record ? [record] : [];
    }

    const needle = normalizeQuery(query);
    if (!needle) return [];
    const index = await getEmployeeDirectoryIndex(client, guildId);
    const matching = index.filter(item => normalizeQuery(item.displayName).includes(needle));
    matching.sort((a, b) => {
        const aExact = normalizeQuery(a.displayName) === needle ? 0 : 1;
        const bExact = normalizeQuery(b.displayName) === needle ? 0 : 1;
        return aExact - bExact || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
    const candidates = matching.slice(0, Math.max(1, Math.min(25, Number(limit) || 25)));
    const records = await Promise.all(candidates.map(item => getEmployeeDirectoryRecord(client, guildId, item.userId)));
    return records.filter(Boolean);
}

export function formatDirectoryTimestamp(value) {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Not recorded';
    const datePart = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric',
    }).format(date);
    const timePart = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(date);
    return `${datePart} · ${timePart} WIB`;
}

export function getEmployeeDirectoryKeysForTests(guildId, userId) {
    return { index: INDEX_KEY(guildId), entry: ENTRY_KEY(guildId, userId) };
}


/**
 * Initialize the directory from members currently holding the Company's base
 * employee role. This deliberately creates no Sign-In records: existing staff
 * should be synced during rollout without a mass notification or false history.
 */
export async function syncEmployeeDirectoryMembership(client, guild, {
    baseEmployeeRoleId = '1564660065783390371',
} = {}) {
    if (!client?.db) throw new Error('Employee directory database is not ready.');
    if (!guild?.id || !guild?.members) throw new Error('Guild member data is not available.');
    const roleId = cleanId(baseEmployeeRoleId);
    if (!roleId) throw new Error('Base Employee Role ID is invalid.');

    let fetchedMembers = null;
    if (typeof guild.members.fetch === 'function') {
        try {
            fetchedMembers = await guild.members.fetch();
        } catch (error) {
            if (!guild.members.cache?.size) {
                throw new Error('Could not load server members for the initial Employee Directory sync.');
            }
        }
    }
    const source = fetchedMembers?.values
        ? [...fetchedMembers.values()]
        : [...(guild.members.cache?.values?.() || [])];
    const matched = source.filter(member => !member.user?.bot && member.roles?.cache?.has?.(roleId));

    let created = 0;
    let activated = 0;
    let unchanged = 0;
    const at = new Date().toISOString();
    const summaries = [];

    for (const member of matched) {
        const userId = cleanId(member.id);
        if (!userId) continue;
        const summary = await queueWrite(`${guild.id}:${userId}`, async () => {
            const existing = await getEmployeeDirectoryRecord(client, guild.id, userId);
            const entry = existing || emptyEntry(guild.id, userId, member.displayName, at);
            const wasActive = entry.status === 'active';
            const name = clean(member.displayName || entry.displayName, 100) || 'Unknown member';
            const changed = !existing || !wasActive || entry.displayName !== name;
            entry.displayName = name;
            entry.status = 'active';
            entry.updatedAt = at;
            // This is a snapshot initialization, not a fabricated log event.
            // It prevents old backfilled records from reverting current membership.
            if (!entry.latestStateEventAt || !wasActive) entry.latestStateEventAt = at;
            if (!entry.currentPosition && entry.lastKnownPosition && wasActive) {
                entry.currentPosition = entry.lastKnownPosition;
            }
            entry.lastKnownPosition = entry.currentPosition || entry.lastKnownPosition || null;
            if (!Array.isArray(entry.history)) entry.history = [];
            await client.db.set(ENTRY_KEY(guild.id, userId), entry);
            return {
                userId,
                displayName: entry.displayName,
                status: entry.status,
                updatedAt: entry.updatedAt,
                created: !existing,
                activated: Boolean(existing && !wasActive),
                changed,
            };
        });
        if (summary.created) created += 1;
        else if (summary.activated) activated += 1;
        else if (!summary.changed) unchanged += 1;
        summaries.push(summary);
    }

    await queueWrite(`${guild.id}:directory-index`, async () => {
        const index = await getEmployeeDirectoryIndex(client, guild.id);
        const byId = new Map(index.map(item => [String(item.userId), item]));
        for (const summary of summaries) {
            byId.set(summary.userId, {
                userId: summary.userId,
                displayName: summary.displayName,
                status: 'active',
                updatedAt: summary.updatedAt,
            });
        }
        const nextIndex = [...byId.values()].sort((a, b) =>
            String(a.displayName).localeCompare(String(b.displayName), 'en', { sensitivity: 'base' }),
        );
        await client.db.set(INDEX_KEY(guild.id), nextIndex);
    });

    return {
        scanned: source.length,
        matched: matched.length,
        created,
        activated,
        unchanged,
        signInLogsCreated: 0,
    };
}
