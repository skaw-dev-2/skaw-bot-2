import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getEmployeeDirectoryIndex,
    getEmployeeDirectoryRecord,
    parseDiscordUserId,
    searchEmployeeDirectory,
    upsertEmployeeDirectoryFromLog,
    syncEmployeeDirectoryMembership,
} from '../services/employeeDirectoryService.js';

const GUILD_ID = '77777777777777777';
const USER_ID = '12345678901234567';
const MECHANIC_TRAINEE = '1414629137389322244';
const MECHANIC_JUNIOR = '1414629274282885120';

function runtime() {
    const store = new Map();
    const client = {
        db: {
            async get(key, fallback = null) {
                return store.has(key) ? structuredClone(store.get(key)) : fallback;
            },
            async set(key, value) {
                store.set(key, structuredClone(value));
            },
        },
    };
    const roles = new Map([
        [MECHANIC_TRAINEE, { id: MECHANIC_TRAINEE, name: 'Mechanic Traine | SKAW' }],
        [MECHANIC_JUNIOR, { id: MECHANIC_JUNIOR, name: 'Mechanic Junior | SKAW' }],
    ]);
    const guild = {
        id: GUILD_ID,
        roles: { cache: { get: id => roles.get(id) || null } },
        members: { cache: new Map() },
    };
    return { client, guild, store };
}

function logRecord(type, publishedAt, data, recordId = `${type}-${publishedAt}`) {
    return {
        guildId: GUILD_ID,
        recordId,
        type,
        publishedAt,
        automatic: type === 'sign_in',
        data: { userId: USER_ID, displayName: 'Kevin Monterrey', ...data, recordedAt: publishedAt, recordId },
    };
}

test('directory creates an active profile from Sign-In and updates position through Promotion', async () => {
    const { client, guild } = runtime();
    await upsertEmployeeDirectoryFromLog(client, guild, logRecord('sign_in', '2026-10-10T07:00:00.000Z', { position: MECHANIC_TRAINEE }, 'signin-1'));
    await upsertEmployeeDirectoryFromLog(client, guild, logRecord('promotion', '2026-10-11T07:00:00.000Z', { previousRank: MECHANIC_TRAINEE, newRank: MECHANIC_JUNIOR }, 'promotion-1'));

    const entry = await getEmployeeDirectoryRecord(client, GUILD_ID, USER_ID);
    assert.equal(entry.status, 'active');
    assert.equal(entry.displayName, 'Kevin Monterrey');
    assert.equal(entry.firstSignInAt, '2026-10-10T07:00:00.000Z');
    assert.equal(entry.currentPosition.id, MECHANIC_JUNIOR);
    assert.equal(entry.currentPosition.name, 'Mechanic Junior | SKAW');
    assert.equal(entry.history.length, 2);
});

test('Sign-Out marks the profile former and stores reason and last position', async () => {
    const { client, guild } = runtime();
    await upsertEmployeeDirectoryFromLog(client, guild, logRecord('sign_in', '2026-10-10T07:00:00.000Z', { position: MECHANIC_JUNIOR }, 'signin-2'));
    await upsertEmployeeDirectoryFromLog(client, guild, logRecord('sign_out', '2026-10-20T10:30:00.000Z', { position: MECHANIC_JUNIOR, reason: 'Personal Resignation' }, 'signout-2'));

    const entry = await getEmployeeDirectoryRecord(client, GUILD_ID, USER_ID);
    assert.equal(entry.status, 'former');
    assert.equal(entry.lastSignOutAt, '2026-10-20T10:30:00.000Z');
    assert.equal(entry.lastSignOutReason, 'Personal Resignation');
    assert.equal(entry.lastKnownPosition.id, MECHANIC_JUNIOR);
    assert.equal(entry.currentPosition, null);
});

test('editing a published exit record refreshes directory reason without duplicating history', async () => {
    const { client, guild } = runtime();
    await upsertEmployeeDirectoryFromLog(client, guild, logRecord('sign_in', '2026-10-10T07:00:00.000Z', { position: MECHANIC_JUNIOR }, 'signin-3'));
    const exit = logRecord('resignation', '2026-10-20T10:30:00.000Z', { position: MECHANIC_JUNIOR, reason: '' }, 'exit-3');
    await upsertEmployeeDirectoryFromLog(client, guild, exit);
    await upsertEmployeeDirectoryFromLog(client, guild, { ...exit, data: { ...exit.data, reason: 'Personal Resignation' } });

    const entry = await getEmployeeDirectoryRecord(client, GUILD_ID, USER_ID);
    assert.equal(entry.lastExitType, 'resignation');
    assert.equal(entry.lastSignOutReason, 'Personal Resignation');
    assert.equal(entry.history.filter(item => item.recordId === 'exit-3').length, 1);
});

test('Blacklist event is retained as history and is searchable by display name', async () => {
    const { client, guild } = runtime();
    await upsertEmployeeDirectoryFromLog(client, guild, logRecord('blacklist', '2026-10-22T08:00:00.000Z', { position: MECHANIC_TRAINEE, reason: 'Policy violation' }, 'blacklist-4'));

    const matches = await searchEmployeeDirectory(client, GUILD_ID, 'kevin monterrey');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].everBlacklisted, true);
    assert.equal(matches[0].lastBlacklistReason, 'Policy violation');
    const index = await getEmployeeDirectoryIndex(client, GUILD_ID);
    assert.equal(index.length, 1);
    assert.equal(index[0].userId, USER_ID);
});

test('User ID and mention input are normalized safely', () => {
    assert.equal(parseDiscordUserId(USER_ID), USER_ID);
    assert.equal(parseDiscordUserId(`<@${USER_ID}>`), USER_ID);
    assert.equal(parseDiscordUserId(`<@!${USER_ID}>`), USER_ID);
    assert.equal(parseDiscordUserId('not-a-discord-id'), '');
});

test('backfilling an older exit after a newer re-sign-in does not revert current status', async () => {
    const { client, guild } = runtime();
    await upsertEmployeeDirectoryFromLog(client, guild, logRecord('sign_in', '2026-10-25T07:00:00.000Z', { position: MECHANIC_JUNIOR }, 'signin-newer'));
    await upsertEmployeeDirectoryFromLog(client, guild, logRecord('sign_out', '2026-10-20T10:30:00.000Z', { position: MECHANIC_TRAINEE, reason: 'Older exit' }, 'signout-older'));

    const entry = await getEmployeeDirectoryRecord(client, GUILD_ID, USER_ID);
    assert.equal(entry.status, 'active');
    assert.equal(entry.currentPosition.id, MECHANIC_JUNIOR);
    assert.equal(entry.lastSignOutAt, '2026-10-20T10:30:00.000Z');
    assert.equal(entry.lastSignOutReason, 'Older exit');
    assert.equal(entry.firstSignInAt, '2026-10-25T07:00:00.000Z');
});


test('initial Company Staff sync initializes existing employees without fabricating Sign-In history', async () => {
    const { client, guild } = runtime();
    const member = {
        id: USER_ID,
        user: { id: USER_ID, bot: false },
        displayName: 'Kevin Monterrey',
        roles: { cache: { has: roleId => String(roleId) === '1564660065783390371' } },
    };
    guild.members.cache.set(USER_ID, member);

    const first = await syncEmployeeDirectoryMembership(client, guild);
    assert.equal(first.scanned, 1);
    assert.equal(first.matched, 1);
    assert.equal(first.created, 1);
    assert.equal(first.signInLogsCreated, 0);

    const profile = await getEmployeeDirectoryRecord(client, GUILD_ID, USER_ID);
    assert.equal(profile.status, 'active');
    assert.equal(profile.displayName, 'Kevin Monterrey');
    assert.equal(profile.firstSignInAt, null);
    assert.equal(profile.history.length, 0);

    const second = await syncEmployeeDirectoryMembership(client, guild);
    assert.equal(second.created, 0);
    assert.equal(second.unchanged, 1);
    assert.equal(second.signInLogsCreated, 0);
});
