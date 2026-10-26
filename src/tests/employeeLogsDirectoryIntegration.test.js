import test from 'node:test';
import assert from 'node:assert/strict';
import { getEmployeeDirectoryRecord } from '../services/employeeDirectoryService.js';
import { sendEmployeeLog, updateEmployeeLogRecord } from '../services/employeeLogsService.js';

const GUILD_ID = '77777777777777777';
const BOT_ID = '99999999999999999';
const USER_ID = '12345678901234567';
const CHANNEL_ID = '88888888888888888';
const POSITION_ID = '1414629274282885120';

function createRuntime() {
    const store = new Map();
    const messages = [];
    const role = { id: POSITION_ID, name: 'Mechanic Junior | SKAW' };
    const client = {
        user: { id: BOT_ID },
        db: {
            async get(key, fallback = null) { return store.has(key) ? structuredClone(store.get(key)) : fallback; },
            async set(key, value) { store.set(key, structuredClone(value)); },
        },
        guilds: { cache: new Map() },
        channels: { async fetch() { return channel; } },
    };
    const channel = {
        id: CHANNEL_ID,
        guildId: GUILD_ID,
        isTextBased: () => true,
        isDMBased: () => false,
        permissionsFor: () => ({ has: () => true }),
        messages: { async fetch(id) { return messages.find(item => item.id === id) || null; } },
        async send(payload) {
            const message = {
                id: String(66666666666666666n + BigInt(messages.length)),
                author: client.user,
                payload,
                async edit(nextPayload) { this.payload = { ...this.payload, ...nextPayload }; return this; },
                async delete() { this.deleted = true; return this; },
            };
            messages.push(message);
            return message;
        },
    };
    const guild = {
        id: GUILD_ID,
        roles: { cache: new Map([[POSITION_ID, role]]) },
        members: {
            me: { id: BOT_ID },
            cache: new Map(),
            async fetch() { return { id: USER_ID, displayName: 'Kevin Monterrey' }; },
        },
    };
    client.guilds.cache.set(GUILD_ID, guild);
    store.set(`guild:${GUILD_ID}:employee_logs`, { channels: { sign_in: CHANNEL_ID, sign_out: CHANNEL_ID }, bannerUrl: null, banners: {}, stickers: {} });
    return { client, guild, store };
}

test('published manual and automatic-style records feed /find directory, and Edit refreshes exit reason', async () => {
    const { client, guild } = createRuntime();
    const signIn = await sendEmployeeLog(client, guild, 'sign_in', {
        userId: USER_ID,
        displayName: 'Kevin Monterrey',
        position: POSITION_ID,
        recordedBy: USER_ID,
    });
    let directory = await getEmployeeDirectoryRecord(client, GUILD_ID, USER_ID);
    assert.equal(directory.status, 'active');
    assert.equal(directory.firstSignInAt, signIn.publishedAt.toISOString());
    assert.equal(directory.currentPosition.name, 'Mechanic Junior | SKAW');

    const signOut = await sendEmployeeLog(client, guild, 'sign_out', {
        userId: USER_ID,
        displayName: 'Kevin Monterrey',
        position: POSITION_ID,
        reason: 'Personal Resignation',
        recordedBy: USER_ID,
    });
    directory = await getEmployeeDirectoryRecord(client, GUILD_ID, USER_ID);
    assert.equal(directory.status, 'former');
    assert.equal(directory.lastSignOutAt, signOut.publishedAt.toISOString());
    assert.equal(directory.lastSignOutReason, 'Personal Resignation');

    await updateEmployeeLogRecord(client, GUILD_ID, signOut.recordId, {
        reason: 'Resigned for personal reasons',
        notes: 'Private internal note',
    }, USER_ID);
    directory = await getEmployeeDirectoryRecord(client, GUILD_ID, USER_ID);
    assert.equal(directory.lastSignOutReason, 'Resigned for personal reasons');
    assert.equal(directory.history.filter(item => item.recordId === signOut.recordId).length, 1);
});
