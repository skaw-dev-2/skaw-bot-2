import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isAutoMessageSchedulerRunning,
    runAutoMessages,
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
        createdAt: new Date(now - 60_000).toISOString(),
        createdBy: 'admin-1',
        ...overrides,
    };
}

function createClient(schedule, sendMessage) {
    const store = new Map([
        [AUTO_MESSAGE_KEY, { [schedule.id]: structuredClone(schedule) }],
    ]);

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
            get: async (key, fallback = {}) => structuredClone(store.has(key) ? store.get(key) : fallback),
            set: async (key, value) => {
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
        readSchedule: () => structuredClone(store.get(AUTO_MESSAGE_KEY)?.[schedule.id]),
        writeSchedule: async value => {
            store.set(AUTO_MESSAGE_KEY, { [schedule.id]: structuredClone(value) });
        },
    };
}

test('failed Auto Message delivery remains enabled and receives a persisted retry time', async () => {
    const harness = createClient(
        createSchedule(),
        async () => {
            const error = new Error('Missing Permissions');
            error.code = 50013;
            throw error;
        },
    );

    await runAutoMessages(harness.client);

    const saved = harness.readSchedule();
    assert.equal(saved.enabled, true);
    assert.equal(saved.runCount, 0);
    assert.equal(saved.failureCount, 1);
    assert.match(saved.lastError, /Missing Permissions/);
    assert.ok(saved.lastFailureAt);
    assert.ok(saved.nextRunAt > Date.now());
    assert.ok(saved.nextRunAt <= Date.now() + 65_000);
});

test('successful retry clears the previous delivery error and advances the schedule', async () => {
    let attempts = 0;
    const harness = createClient(
        createSchedule({ failureCount: 1, lastError: 'Temporary Discord error' }),
        async () => {
            attempts += 1;
            if (attempts === 1) throw new Error('Temporary Discord error');
            return { id: 'sent-message-1' };
        },
    );

    await runAutoMessages(harness.client);
    const failed = harness.readSchedule();
    assert.equal(failed.failureCount, 2);
    assert.equal(failed.enabled, true);

    await harness.writeSchedule({
        ...failed,
        nextRunAt: Date.now() - 1_000,
    });

    await runAutoMessages(harness.client);

    const recovered = harness.readSchedule();
    assert.equal(attempts, 2);
    assert.equal(recovered.enabled, true);
    assert.equal(recovered.runCount, 1);
    assert.equal(recovered.failureCount, 0);
    assert.equal(recovered.lastError, null);
    assert.equal(recovered.lastFailureAt, null);
    assert.ok(recovered.lastRunAt);
    assert.ok(recovered.nextRunAt > Date.now());
});

test('Auto Message scheduler can be started idempotently and stopped cleanly', () => {
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
