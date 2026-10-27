import test from 'node:test';
import assert from 'node:assert/strict';
import { handleEmployeeLogsRoleUpdate } from '../services/employeeLogsAutoRoleService.js';

const GUILD_ID = '77777777777777777';
const BOT_ID = '99999999999999999';
const MEMBER_ID = '12345678901234567';
const CHANNEL_ID = '88888888888888888';

function createRuntime() {
    const store = new Map();
    const publishedMessages = [];
    const client = {
        user: { id: BOT_ID },
        db: {
            async get(key, fallback = null) {
                return store.has(key) ? structuredClone(store.get(key)) : fallback;
            },
            async set(key, value) { store.set(key, structuredClone(value)); },
            async delete(key) { store.delete(key); },
        },
        channels: { async fetch() { return channel; } },
    };
    const channel = {
        id: CHANNEL_ID,
        guildId: GUILD_ID,
        isTextBased: () => true,
        isDMBased: () => false,
        permissionsFor: () => ({ has: () => true }),
        messages: { async fetch(id) { return publishedMessages.find(message => message.id === id) || null; } },
        async send(payload) {
            const message = {
                id: String(66666666666666666n + BigInt(publishedMessages.length)),
                author: client.user,
                payload,
                async edit(nextPayload) { this.payload = { ...this.payload, ...nextPayload }; return this; },
                async delete() { this.deleted = true; return this; },
            };
            publishedMessages.push(message);
            return message;
        },
    };
    const guild = {
        id: GUILD_ID,
        members: { me: { permissions: { has: () => false } } },
    };
    const channels = Object.fromEntries([
        'sign_in', 'sign_out', 'promotion', 'demote', 'mutation', 'warning', 'blacklist',
    ].map(type => [type, CHANNEL_ID]));
    store.set(`guild:${GUILD_ID}:employee_logs`, { channels, bannerUrl: null, banners: {}, stickers: {} });
    store.set(`guild:${GUILD_ID}:employee_logs:auto_role`, { enabled: true, updatedAt: null, updatedBy: null });
    return { client, guild, store, publishedMessages };
}

test('role event is coalesced and publishes one editable automatic Sign-In record', async () => {
    const { client, guild, store, publishedMessages } = createRuntime();
    const oldMember = {
        id: MEMBER_ID,
        user: { id: MEMBER_ID, bot: false },
        guild,
        roles: { cache: new Set(['1415329997396119603']) },
    };
    const newMember = {
        id: MEMBER_ID,
        user: { id: MEMBER_ID, bot: false },
        displayName: 'Kevin Monterrey',
        guild,
        client,
        roles: { cache: new Set(['1564660065783390371', '1414623229288513586', '1414629137389322244']) },
    };

    const queued = await handleEmployeeLogsRoleUpdate(oldMember, newMember, client);
    assert.equal(queued.queued, true);
    assert.equal(publishedMessages.length, 0, 'record should wait for the brief coalescing window');
    await new Promise(resolve => setTimeout(resolve, queued.coalesceMs + 250));

    assert.equal(publishedMessages.length, 1);
    const message = publishedMessages[0];
    const description = message.payload.embeds[0].description;
    assert.match(description, /^## EMPLOYEE SIGN-IN/m);
    assert.match(description, new RegExp(`\\*\\*Employee:\\*\\* Kevin Monterrey \\(\\*\\*<@${MEMBER_ID}>\\*\\*\\)`));
    assert.match(description, /\*\*Position:\*\* <@&1414629137389322244>/);
    assert.match(description, /Recorded by SKAW Bot/);
    assert.equal(message.payload.components[0].components[0].label, 'Edit');
    const records = [...store.entries()].filter(([key]) => key.startsWith(`guild:${GUILD_ID}:employee_logs:record:`));
    assert.equal(records.length, 1);
    assert.equal(records[0][1].automatic, true);
});


test('removing Company Staff queues an exit review instead of publishing a guessed exit log', async () => {
    const { client, guild, store, publishedMessages } = createRuntime();
    const oldMember = {
        id: MEMBER_ID,
        user: { id: MEMBER_ID, bot: false },
        displayName: 'Kevin Monterrey',
        guild,
        roles: { cache: new Set(['1564660065783390371', '1414623229288513586', '1414629137389322244']) },
    };
    const newMember = {
        id: MEMBER_ID,
        user: { id: MEMBER_ID, bot: false },
        displayName: 'Kevin Monterrey',
        guild,
        client,
        roles: { cache: new Set(['1414623229288513586', '1414629137389322244']) },
    };

    const queued = await handleEmployeeLogsRoleUpdate(oldMember, newMember, client);
    assert.equal(queued.queued, true);
    await new Promise(resolve => setTimeout(resolve, queued.coalesceMs + 250));

    assert.equal(publishedMessages.length, 0, 'the bot should not guess Sign Out, Resignation or Dismissal');
    const reviews = store.get(`guild:${GUILD_ID}:employee_logs:exit_reviews`);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].status, 'pending');
    assert.equal(reviews[0].userId, MEMBER_ID);
    assert.equal(reviews[0].formerPositionId, '1414629137389322244');
});

test('restoring Company Staff cancels a pending exit review and records a new Sign-In', async () => {
    const { client, guild, store, publishedMessages } = createRuntime();
    const oldMember = {
        id: MEMBER_ID,
        user: { id: MEMBER_ID, bot: false },
        displayName: 'Kevin Monterrey',
        guild,
        roles: { cache: new Set(['1564660065783390371', '1414623229288513586', '1414629137389322244']) },
    };
    const removedMember = {
        id: MEMBER_ID,
        user: { id: MEMBER_ID, bot: false },
        displayName: 'Kevin Monterrey',
        guild,
        client,
        roles: { cache: new Set(['1414623229288513586', '1414629137389322244']) },
    };

    const exitQueued = await handleEmployeeLogsRoleUpdate(oldMember, removedMember, client);
    await new Promise(resolve => setTimeout(resolve, exitQueued.coalesceMs + 250));
    const beforeRestore = store.get(`guild:${GUILD_ID}:employee_logs:exit_reviews`);
    assert.equal(beforeRestore[0].status, 'pending');

    const restoredMember = {
        ...removedMember,
        roles: { cache: new Set(['1564660065783390371', '1414623229288513586', '1414629137389322244']) },
    };
    const rejoinQueued = await handleEmployeeLogsRoleUpdate(removedMember, restoredMember, client);
    await new Promise(resolve => setTimeout(resolve, rejoinQueued.coalesceMs + 250));

    const reviews = store.get(`guild:${GUILD_ID}:employee_logs:exit_reviews`);
    assert.equal(reviews[0].status, 'cancelled');
    assert.equal(publishedMessages.length, 0, 'restoring membership before exit review resolution should not fabricate a Sign-In');

});
