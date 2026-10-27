import test from 'node:test';
import assert from 'node:assert/strict';
import { handleEmployeeLogsRoleUpdate } from '../services/employeeLogsAutoRoleService.js';

const GUILD_ID = '77777777777777777';
const BOT_ID = '99999999999999999';
const MEMBER_ID = '12345678901234567';
const CHANNEL_ID = '88888888888888888';
const ROLE = {
    base: '1564660065783390371',
    civilian: '1415329997396119603',
    division: '1414623229288513586',
    trainee: '1414629137389322244',
    junior: '1414629274282885120',
    senior: '1414629366574354512',
    blacklist: '1414628838557614222',
    retired: '1429469335654633593',
};

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

function member(client, guild, roleIds, displayName = 'Kevin Monterrey', id = MEMBER_ID) {
    return {
        id,
        user: { id, bot: false },
        displayName,
        guild,
        client,
        roles: { cache: new Set(roleIds) },
    };
}
function description(message) {
    return message.payload.embeds[0]?.data?.description ?? message.payload.embeds[0]?.description ?? '';
}
function recordTypes(store) {
    return [...store.entries()]
        .filter(([key]) => key.startsWith(`guild:${GUILD_ID}:employee_logs:record:`))
        .map(([, record]) => record.type);
}

test('adding Company Staff immediately publishes an editable Sign-In with separate Division and Position', async () => {
    const { client, guild, store, publishedMessages } = createRuntime();
    const oldMember = member(client, guild, [ROLE.civilian]);
    const newMember = member(client, guild, [ROLE.base, ROLE.division, ROLE.trainee]);

    const result = await handleEmployeeLogsRoleUpdate(oldMember, newMember, client);
    assert.equal(result.processed, true);
    assert.equal(publishedMessages.length, 1);
    assert.match(description(publishedMessages[0]), /^## EMPLOYEE SIGN-IN/m);
    assert.match(description(publishedMessages[0]), new RegExp(`\\*\\*Division:\\*\\* <@&${ROLE.division}>`));
    assert.match(description(publishedMessages[0]), new RegExp(`\\*\\*Position:\\*\\* <@&${ROLE.trainee}>`));
    assert.equal(recordTypes(store).filter(type => type === 'sign_in').length, 1);
    assert.equal((publishedMessages[0].payload.components[0].components[0]?.data?.label ?? publishedMessages[0].payload.components[0].components[0]?.label), 'Edit');
});

test('assigning Company Staff first then Division and Position enriches the same Sign-In record', async () => {
    const { client, guild, store, publishedMessages } = createRuntime();
    const noRole = member(client, guild, [ROLE.civilian]);
    const staffOnly = member(client, guild, [ROLE.base]);
    const staffWithDivision = member(client, guild, [ROLE.base, ROLE.division]);
    const fullyAssigned = member(client, guild, [ROLE.base, ROLE.division, ROLE.trainee]);

    await handleEmployeeLogsRoleUpdate(noRole, staffOnly, client);
    const signInRecord = [...store.entries()].find(([key, value]) =>
        key.startsWith(`guild:${GUILD_ID}:employee_logs:record:`) && value.type === 'sign_in')?.[1];
    assert.ok(signInRecord);
    const originalRecordId = signInRecord.recordId;
    assert.equal(publishedMessages.length, 1);
    assert.ok(description(publishedMessages[0]).includes('**Division:** Belum ditetapkan'));
    assert.ok(description(publishedMessages[0]).includes('**Position:** Belum ditetapkan'));

    await handleEmployeeLogsRoleUpdate(staffOnly, staffWithDivision, client);
    await handleEmployeeLogsRoleUpdate(staffWithDivision, fullyAssigned, client);

    assert.equal(publishedMessages.length, 1, 'context updates must edit the original message rather than duplicate Sign-In');
    assert.match(description(publishedMessages[0]), new RegExp(`\\*\\*Division:\\*\\* <@&${ROLE.division}>`));
    assert.match(description(publishedMessages[0]), new RegExp(`\\*\\*Position:\\*\\* <@&${ROLE.trainee}>`));
    const saved = await client.db.get(`guild:${GUILD_ID}:employee_logs:record:${originalRecordId}`);
    assert.equal(saved.recordId, originalRecordId);
    assert.equal(saved.data.division, ROLE.division);
    assert.equal(saved.data.position, ROLE.trainee);
});

test('roles assigned before Company Staff are included in the first Sign-In', async () => {
    const { client, guild, publishedMessages } = createRuntime();
    const civilian = member(client, guild, [ROLE.civilian]);
    const rolesReady = member(client, guild, [ROLE.civilian, ROLE.division, ROLE.trainee]);
    const staffAdded = member(client, guild, [ROLE.base, ROLE.division, ROLE.trainee]);

    await handleEmployeeLogsRoleUpdate(civilian, rolesReady, client);
    assert.equal(publishedMessages.length, 0, 'Division/Position alone should not create a membership log');

    const result = await handleEmployeeLogsRoleUpdate(rolesReady, staffAdded, client);
    assert.equal(result.processed, true);
    assert.equal(publishedMessages.length, 1);
    assert.match(description(publishedMessages[0]), /^## EMPLOYEE SIGN-IN/m);
    assert.ok(description(publishedMessages[0]).includes(`**Division:** <@&${ROLE.division}>`));
    assert.ok(description(publishedMessages[0]).includes(`**Position:** <@&${ROLE.trainee}>`));
});

test('removing Company Staff immediately publishes Sign-Out with no review queue', async () => {
    const { client, guild, store, publishedMessages } = createRuntime();
    const oldMember = member(client, guild, [ROLE.base, ROLE.division, ROLE.trainee]);
    const newMember = member(client, guild, [ROLE.division, ROLE.trainee]);

    const result = await handleEmployeeLogsRoleUpdate(oldMember, newMember, client);
    assert.equal(result.processed, true);
    assert.equal(publishedMessages.length, 1);
    assert.match(description(publishedMessages[0]), /^## EMPLOYEE SIGN-OUT/m);
    assert.match(description(publishedMessages[0]), new RegExp(`\\*\\*Position:\\*\\* <@&${ROLE.trainee}>`));
    assert.match(description(publishedMessages[0]), /\*\*Reason:\*\* Belum ditentukan/);
    assert.equal(store.has(`guild:${GUILD_ID}:employee_logs:exit_reviews`), false);
});

test('a split rank replacement still publishes Demotion using the last known position', async () => {
    const { client, guild, publishedMessages } = createRuntime();
    const former = member(client, guild, [ROLE.civilian]);
    const senior = member(client, guild, [ROLE.base, ROLE.division, ROLE.senior]);
    const divisionOnly = member(client, guild, [ROLE.base, ROLE.division]);
    const junior = member(client, guild, [ROLE.base, ROLE.division, ROLE.junior]);

    await handleEmployeeLogsRoleUpdate(former, senior, client);
    await handleEmployeeLogsRoleUpdate(senior, divisionOnly, client);
    assert.equal(publishedMessages.length, 1, 'removing a rank temporarily should not invent a transition to Division');

    await handleEmployeeLogsRoleUpdate(divisionOnly, junior, client);
    assert.equal(publishedMessages.length, 2);
    assert.match(description(publishedMessages[1]), /^## EMPLOYEE DEMOTION/m);
    assert.match(description(publishedMessages[1]), new RegExp(`\\*\\*Previous Rank:\\*\\* <@&${ROLE.senior}>`));
    assert.match(description(publishedMessages[1]), new RegExp(`\\*\\*New Rank:\\*\\* <@&${ROLE.junior}>`));
});

test('Retired/Civilian plus position removal publishes Sign-Out once even if Company Staff is removed afterward', async () => {
    const { client, guild, store, publishedMessages } = createRuntime();
    const activeStaff = member(client, guild, [ROLE.base, ROLE.division, ROLE.senior]);
    const explicitlyRetired = member(client, guild, [ROLE.base, ROLE.division, ROLE.retired]);
    const baseRemoved = member(client, guild, [ROLE.division, ROLE.retired]);

    await handleEmployeeLogsRoleUpdate(activeStaff, explicitlyRetired, client);
    assert.equal(publishedMessages.length, 1);
    assert.match(description(publishedMessages[0]), /^## EMPLOYEE SIGN-OUT/m);
    assert.ok(description(publishedMessages[0]).includes(`**Position:** <@&${ROLE.senior}>`));

    await handleEmployeeLogsRoleUpdate(explicitlyRetired, baseRemoved, client);
    assert.equal(publishedMessages.length, 1, 'removing Company Staff after an explicit exit must not duplicate Sign-Out');
    assert.deepEqual(recordTypes(store), ['sign_out']);
});

test('Blacklisting while removing Company Staff publishes both Sign-Out and Blacklist logs', async () => {
    const { client, guild, store, publishedMessages } = createRuntime();
    const oldMember = member(client, guild, [ROLE.base, ROLE.division, ROLE.senior]);
    const newMember = member(client, guild, [ROLE.division, ROLE.senior, ROLE.blacklist]);

    const result = await handleEmployeeLogsRoleUpdate(oldMember, newMember, client);
    assert.equal(result.processed, true);
    assert.equal(publishedMessages.length, 2);
    assert.match(description(publishedMessages[0]), /^## EMPLOYEE SIGN-OUT/m);
    assert.match(description(publishedMessages[0]), /\*\*Reason:\*\* Blacklist/);
    assert.match(description(publishedMessages[1]), /^## PERSONNEL BLACKLIST/m);
    assert.deepEqual(recordTypes(store).sort(), ['blacklist', 'sign_out']);
});

test('restoring Company Staff after Sign-Out immediately creates a new Sign-In', async () => {
    const { client, guild, store, publishedMessages } = createRuntime();
    const former = member(client, guild, [ROLE.civilian]);
    const staff = member(client, guild, [ROLE.base, ROLE.division, ROLE.trainee]);
    const nonStaff = member(client, guild, [ROLE.division, ROLE.trainee]);

    await handleEmployeeLogsRoleUpdate(former, staff, client);
    await handleEmployeeLogsRoleUpdate(staff, nonStaff, client);
    await handleEmployeeLogsRoleUpdate(nonStaff, staff, client);

    assert.equal(publishedMessages.length, 3);
    assert.deepEqual(recordTypes(store), ['sign_in', 'sign_out', 'sign_in']);
    assert.match(description(publishedMessages[2]), /^## EMPLOYEE SIGN-IN/m);
});
