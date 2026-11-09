import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildAutoMessagePayload,
    getGuildAutoMessages,
    isAutoMessageSchedulerRunning,
    mutateGuildAutoMessages,
    runAutoMessages,
    saveGuildAutoMessages,
    startAutoMessageScheduler,
    stopAutoMessageScheduler,
} from '../services/autoMessageService.js';

const AUTO_MESSAGE_KEY = 'guild:guild-1:auto_messages';

function createSchedule(overrides = {}) {
    const now = Date.now();
    return {
        id: 'am_test_schedule',
        guildId: 'guild-1',
        channelId: 'channel-1',
        message: 'Scheduled SKAW message',
        messageType: 'text',
        embed: null,
        timezone: 'Asia/Jakarta',
        scheduleType: 'interval',
        intervalMs: 60 * 60 * 1000,
        startAt: now - 60_000,
        endAt: null,
        nextRunAt: now - 1_000,
        lastRunAt: null,
        enabled: true,
        runCount: 0,
        failureCount: 0,
        lastFailureAt: null,
        lastError: null,
        inFlight: null,
        deliveryUncertain: false,
        deliveryUncertainAt: null,
        createdAt: new Date(now - 60_000).toISOString(),
        createdBy: 'admin-1',
        ...overrides,
    };
}

function createClient(schedule, sendMessage = async () => ({ id: 'sent-message-1' }), options = {}) {
    const store = new Map([
        [AUTO_MESSAGE_KEY, { [schedule.id]: structuredClone(schedule) }],
    ]);
    let writeCount = 0;

    const channel = {
        isTextBased: () => true,
        send: sendMessage,
    };

    const guild = {
        id: 'guild-1',
        channels: {
            fetch: async () => channel,
        },
    };

    const client = {
        db: {
            get: async (key, fallback = {}) => {
                if (options.readError) throw options.readError;
                return structuredClone(store.has(key) ? store.get(key) : fallback);
            },
            set: async (key, value) => {
                writeCount += 1;
                if (options.failWriteAt === writeCount || options.alwaysFailWrite) return false;
                store.set(key, structuredClone(value));
                return true;
            },
        },
        guilds: {
            cache: {
                values: () => [guild].values(),
            },
        },
    };

    return {
        client,
        store,
        readSchedule: () => structuredClone(store.get(AUTO_MESSAGE_KEY)?.[schedule.id]),
        readSchedules: () => structuredClone(store.get(AUTO_MESSAGE_KEY) || {}),
        writeSchedule: async value => {
            store.set(AUTO_MESSAGE_KEY, { [schedule.id]: structuredClone(value) });
        },
        get writeCount() { return writeCount; },
    };
}

test('429 delivery errors remain enabled and persist an exponential retry', async () => {
    const harness = createClient(createSchedule(), async () => {
        const error = new Error('Rate limited');
        error.status = 429;
        error.retry_after = 2;
        throw error;
    });

    await runAutoMessages(harness.client);

    const saved = harness.readSchedule();
    assert.equal(saved.enabled, true);
    assert.equal(saved.runCount, 0);
    assert.equal(saved.failureCount, 1);
    assert.match(saved.lastError, /Rate limited/);
    assert.equal(saved.inFlight, null);
    assert.ok(saved.lastFailureAt);
    assert.ok(saved.nextRunAt >= Date.now() + 55_000);
    assert.ok(saved.nextRunAt <= Date.now() + 65_000);
});

test('definitive permission rejection disables the schedule with a visible error', async () => {
    const harness = createClient(createSchedule(), async () => {
        const error = new Error('Missing Permissions');
        error.status = 403;
        error.code = 50013;
        throw error;
    });

    await runAutoMessages(harness.client);

    const saved = harness.readSchedule();
    assert.equal(saved.enabled, false);
    assert.equal(saved.nextRunAt, null);
    assert.equal(saved.failureCount, 1);
    assert.match(saved.lastError, /Missing Permissions/);
    assert.equal(saved.inFlight, null);
});

test('a successful retry clears previous errors and advances the schedule', async () => {
    let attempts = 0;
    const harness = createClient(
        createSchedule({ failureCount: 1, lastError: 'Temporary Discord rate limit' }),
        async () => {
            attempts += 1;
            if (attempts === 1) {
                const error = new Error('Temporary Discord rate limit');
                error.status = 429;
                throw error;
            }
            return { id: 'sent-message-1' };
        },
    );

    await runAutoMessages(harness.client);
    const failed = harness.readSchedule();
    assert.equal(failed.failureCount, 2);
    assert.equal(failed.enabled, true);

    await harness.writeSchedule({ ...failed, nextRunAt: Date.now() - 1_000 });
    await runAutoMessages(harness.client);

    const recovered = harness.readSchedule();
    assert.equal(attempts, 2);
    assert.equal(recovered.enabled, true);
    assert.equal(recovered.runCount, 1);
    assert.equal(recovered.failureCount, 0);
    assert.equal(recovered.lastError, null);
    assert.equal(recovered.lastFailureAt, null);
    assert.equal(recovered.inFlight, null);
    assert.equal(recovered.deliveryUncertain, false);
    assert.ok(recovered.lastRunAt);
    assert.ok(recovered.nextRunAt > Date.now());
});

test('the durable in-flight claim exists before Discord receives the message', async () => {
    let harness;
    let observedClaim = null;
    harness = createClient(createSchedule(), async () => {
        observedClaim = harness.readSchedule().inFlight;
        return { id: 'sent-message-claim-test' };
    });

    await runAutoMessages(harness.client);

    assert.ok(observedClaim?.id);
    assert.ok(observedClaim?.claimedAt);
    assert.ok(observedClaim?.scheduledFor);
    assert.equal(harness.readSchedule().inFlight, null);
});

test('an interrupted one-time delivery is marked uncertain and is not resent automatically', async () => {
    let sends = 0;
    const schedule = createSchedule({
        scheduleType: 'once',
        intervalMs: null,
        inFlight: {
            id: 'am_previous_attempt',
            claimedAt: Date.now() - 10_000,
            scheduledFor: Date.now() - 10_000,
        },
    });
    const harness = createClient(schedule, async () => {
        sends += 1;
        return { id: 'unexpected-resend' };
    });

    await runAutoMessages(harness.client);

    const saved = harness.readSchedule();
    assert.equal(sends, 0);
    assert.equal(saved.enabled, false);
    assert.equal(saved.nextRunAt, null);
    assert.equal(saved.inFlight, null);
    assert.equal(saved.deliveryUncertain, true);
    assert.match(saved.lastError, /skipped to prevent duplicate messages/i);
});

test('if the final state write fails after delivery, restart recovery prevents duplicate delivery', async () => {
    let sends = 0;
    const harness = createClient(createSchedule(), async () => {
        sends += 1;
        return { id: 'sent-before-write-failure' };
    }, { failWriteAt: 2 });

    await runAutoMessages(harness.client);
    assert.equal(sends, 1);
    assert.ok(harness.readSchedule().inFlight, 'the successful pre-send claim must remain durable');

    await runAutoMessages(harness.client);
    assert.equal(sends, 1, 'uncertain occurrence must not be automatically sent again');
    assert.equal(harness.readSchedule().deliveryUncertain, true);
});

test('a failed pre-send claim prevents the message from being sent', async () => {
    let sends = 0;
    const harness = createClient(createSchedule(), async () => {
        sends += 1;
        return { id: 'must-not-send' };
    }, { failWriteAt: 1 });

    await runAutoMessages(harness.client);

    assert.equal(sends, 0);
    assert.equal(harness.readSchedule().inFlight, null);
});

test('failed Auto Message persistence is surfaced instead of reported as success', async () => {
    const harness = createClient(createSchedule(), async () => ({ id: 'unused' }), { alwaysFailWrite: true });
    await assert.rejects(
        saveGuildAutoMessages(harness.client, 'guild-1', [createSchedule()]),
        /rejected the Auto Message schedule update/i,
    );
});

test('database read errors are propagated and do not look like an empty schedule list', async () => {
    const harness = createClient(createSchedule(), async () => ({ id: 'unused' }), {
        readError: new Error('PostgreSQL read failed'),
    });
    await assert.rejects(getGuildAutoMessages(harness.client, 'guild-1'), /PostgreSQL read failed/);
});

test('concurrent guild mutations are serialized and do not lose newly added schedules', async () => {
    const harness = createClient(createSchedule());
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
        mutateGuildAutoMessages(harness.client, 'guild-1', schedules => {
            schedules.push(createSchedule({ id: 'am_parallel_' + index, nextRunAt: Date.now() + 60_000 }));
        }),
    ));

    const saved = harness.readSchedules();
    assert.equal(Object.keys(saved).length, 9);
    for (let index = 0; index < 8; index += 1) {
        assert.ok(saved['am_parallel_' + index]);
    }
});

test('embed validation enforces the combined 6,000-character limit', () => {
    assert.throws(() => buildAutoMessagePayload({
        messageType: 'embed',
        message: 'Description',
        embed: {
            title: 'T'.repeat(256),
            description: 'D'.repeat(4096),
            footer: 'F'.repeat(2048),
            color: '#0A5EA8',
            imageUrl: '',
        },
    }), /6,000-character combined limit/);
});

test('custom emoji expansion is checked against Discord message length', () => {
    const guild = {
        emojis: {
            cache: {
                find: predicate => [{ name: 'skaw', id: '1234567890123456', animated: false }].find(predicate),
            },
        },
    };
    const schedule = { messageType: 'text', message: 'x'.repeat(1990) + ' :skaw:' };
    assert.throws(() => buildAutoMessagePayload(schedule, guild), /after custom emoji conversion/);
});

test('PostgreSQL storage path performs reads and writes under a guild advisory lock', async () => {
    const pgStore = new Map([
        [AUTO_MESSAGE_KEY, { [createSchedule().id]: createSchedule() }],
    ]);
    const lockStatements = [];
    const pool = {
        query: async (sql, params) => {
            if (sql.startsWith('SELECT value FROM')) {
                const value = pgStore.get(params[0]);
                return { rows: value === undefined ? [] : [{ value: structuredClone(value) }] };
            }
            if (sql.startsWith('INSERT INTO')) {
                pgStore.set(params[0], JSON.parse(params[1]));
                return { rows: [], rowCount: 1 };
            }
            throw new Error('Unexpected PostgreSQL query: ' + sql);
        },
        connect: async () => ({
            query: async sql => {
                lockStatements.push(sql);
                if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
                return { rows: [] };
            },
            release: () => {},
        }),
    };
    const client = {
        db: {
            db: { pool },
            isAvailable: () => true,
            isDegraded: () => false,
        },
    };

    await mutateGuildAutoMessages(client, 'guild-1', schedules => {
        schedules.push(createSchedule({ id: 'am_postgres_added' }));
    });

    assert.ok(pgStore.get(AUTO_MESSAGE_KEY).am_postgres_added);
    assert.ok(lockStatements.some(sql => sql.includes('pg_advisory_lock')));
    assert.ok(lockStatements.some(sql => sql.includes('pg_advisory_unlock')));
});

test('Auto Message scheduler starts idempotently and stops cleanly', () => {
    const client = {
        db: {
            get: async (_key, fallback = {}) => fallback,
            set: async () => true,
        },
        guilds: { cache: { values: () => [][Symbol.iterator]() } },
    };

    assert.equal(isAutoMessageSchedulerRunning(client), false);
    assert.equal(startAutoMessageScheduler(client), true);
    assert.equal(isAutoMessageSchedulerRunning(client), true);
    assert.equal(startAutoMessageScheduler(client), true);
    assert.equal(stopAutoMessageScheduler(client), true);
    assert.equal(isAutoMessageSchedulerRunning(client), false);
    assert.equal(stopAutoMessageScheduler(client), false);
});
