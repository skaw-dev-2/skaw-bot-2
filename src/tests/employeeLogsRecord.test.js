import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getEmployeeLogRecord,
    sendEmployeeLog,
    updateEmployeeLogRecord,
} from '../services/employeeLogsService.js';

function createMockRuntime() {
    const store = new Map();
    const client = {
        user: { id: '99999999999999999' },
        db: {
            async get(key, fallback = null) { return store.has(key) ? structuredClone(store.get(key)) : fallback; },
            async set(key, value) { store.set(key, structuredClone(value)); },
        },
        channels: { async fetch() { return channel; } },
    };
    const channel = {
        id: '88888888888888888',
        guildId: '77777777777777777',
        isTextBased: () => true,
        isDMBased: () => false,
        permissionsFor: () => ({ has: () => true }),
        messages: { async fetch() { return message; } },
        async send(payload) { message.payload = payload; return message; },
    };
    const message = {
        id: '66666666666666666',
        author: client.user,
        payload: null,
        async edit(payload) { this.payload = { ...(this.payload || {}), ...payload }; return this; },
    };
    const guild = {
        id: '77777777777777777',
        members: {
            me: { id: client.user.id },
            async fetch() {
                return { id: '12345678901234567', displayName: 'Kevin Monterrey', user: { username: 'Kevin_Monterrey' } };
            },
        },
    };
    store.set('guild:77777777777777777:employee_logs', {
        channels: { sign_in: channel.id },
        bannerUrl: null,
        banners: {},
        stickers: {},
    });
    return { client, channel, message, guild, store };
}

test('publishing saves a durable record and attaches the Edit button', async () => {
    const { client, channel, message, guild } = createMockRuntime();
    const result = await sendEmployeeLog(client, guild, 'sign_in', {
        userId: '12345678901234567',
        displayName: 'Kevin Monterrey',
        position: '1414629137389322244',
        recordedBy: '12345678901234567',
    });
    assert.equal(result.editButtonAttached, true);
    assert.match((message.payload.embeds[0]?.data?.description ?? message.payload.embeds[0]?.description), /\*\*Employee:\*\* Kevin Monterrey \(\*\*<@12345678901234567>\*\*\)/);
    assert.equal(message.payload.components[0].components[0].label, 'Edit');
    assert.equal(message.payload.components[0].components[0].emoji, '✏️');
    const record = await getEmployeeLogRecord(client, guild.id, result.recordId);
    assert.equal(record.messageId, message.id);
    assert.equal(record.channelId, channel.id);
});


test('publishing resolves the server display name rather than the Discord username when not supplied', async () => {
    const { client, message, guild } = createMockRuntime();
    await sendEmployeeLog(client, guild, 'sign_in', {
        userId: '12345678901234567',
        position: '1414629137389322244',
        recordedBy: '12345678901234567',
    });
    const description = (message.payload.embeds[0]?.data?.description ?? message.payload.embeds[0]?.description);
    assert.match(description, /\*\*Employee:\*\* Kevin Monterrey \(\*\*<@12345678901234567>\*\*\)/);
    assert.doesNotMatch(description, /Kevin_Monterrey/);
});

test('editing Reason and Additional Notes updates the same message and keeps Record ID', async () => {
    const { client, message, guild } = createMockRuntime();
    const result = await sendEmployeeLog(client, guild, 'sign_in', {
        userId: '12345678901234567',
        displayName: 'Kevin Monterrey',
        position: '1414629137389322244',
        recordedBy: '12345678901234567',
    });
    await updateEmployeeLogRecord(client, guild.id, result.recordId, {
        reason: 'New employee assignment.',
        notes: 'Documents verified.',
    }, '12345678901234567');
    const description = (message.payload.embeds[0]?.data?.description ?? message.payload.embeds[0]?.description);
    assert.match(description, /\*\*Reason:\*\* New employee assignment\./);
    assert.match(description, /\*\*ADDITIONAL NOTES\*\*/);
    assert.match(description, /Documents verified\./);
    assert.match(description, new RegExp(`Record ID: ${result.recordId}`));
    assert.equal(message.payload.components[0].components[0].label, 'Edit');
    const saved = await getEmployeeLogRecord(client, guild.id, result.recordId);
    assert.equal(saved.data.reason, 'New employee assignment.');
    assert.equal(saved.data.notes, 'Documents verified.');
});
