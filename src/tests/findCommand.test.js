import test from 'node:test';
import assert from 'node:assert/strict';
import findCommand from '../commands/Community/find.js';
import { upsertEmployeeDirectoryFromLog } from '../services/employeeDirectoryService.js';

const GUILD_ID = '77777777777777777';
const USER_ID = '12345678901234567';
const ROLE_ID = '1414629274282885120';

function runtime({ hasRecord = true } = {}) {
    const store = new Map();
    const client = {
        db: {
            async get(key, fallback = null) { return store.has(key) ? structuredClone(store.get(key)) : fallback; },
            async set(key, value) { store.set(key, structuredClone(value)); },
        },
        guilds: { cache: new Map() },
    };
    const role = { id: ROLE_ID, name: 'Mechanic Junior | SKAW' };
    const guild = {
        id: GUILD_ID,
        roles: { cache: new Map([[ROLE_ID, role]]) },
        members: { cache: new Map() },
    };
    const member = {
        id: USER_ID,
        displayName: 'Kevin Monterrey',
        guild,
        roles: { cache: new Map([[ROLE_ID, role]]) },
    };
    guild.members.cache.set(USER_ID, member);
    guild.members.fetch = async id => String(id) === USER_ID ? member : null;
    client.guilds.cache.set(GUILD_ID, guild);

    const interaction = {
        client,
        guild,
        guildId: GUILD_ID,
        inGuild: () => true,
        options: { getString: () => hasRecord ? USER_ID : 'Unknown Person' },
        async deferReply(payload) { this.deferredPayload = payload; },
        async editReply(payload) { this.resultPayload = payload; return payload; },
        async reply(payload) { this.resultPayload = payload; return payload; },
    };
    return { client, guild, member, interaction, store };
}

test('/find returns an ephemeral profile with live server display name and status', async () => {
    const { client, guild, member, interaction } = runtime();
    await upsertEmployeeDirectoryFromLog(client, guild, {
        guildId: GUILD_ID,
        recordId: 'SKAW-EL-TEST-SIGNIN',
        type: 'sign_in',
        publishedAt: '2026-10-26T06:00:00.000Z',
        data: { userId: USER_ID, displayName: 'Old Name', position: ROLE_ID, recordedAt: '2026-10-26T06:00:00.000Z' },
    });

    await findCommand.execute(interaction);
    assert.equal(interaction.deferredPayload.flags, 64);
    const embed = interaction.resultPayload.embeds[0].toJSON();
    assert.equal(embed.title, 'SKAW EMPLOYEE PROFILE');
    assert.match(embed.description, /Kevin Monterrey \(\*\*<@12345678901234567>\*\*\)/);
    assert.equal(embed.fields.find(field => field.name === 'EMPLOYMENT STATUS').value, 'ACTIVE');
    assert.equal(embed.fields.find(field => field.name === 'CURRENT POSITION').value, '<@&1414629274282885120>');
});

test('/find shows NOT REGISTERED for an unknown search without leaking a public reply', async () => {
    const { interaction } = runtime({ hasRecord: false });
    await findCommand.execute(interaction);
    assert.equal(interaction.deferredPayload.flags, 64);
    const embed = interaction.resultPayload.embeds[0].toJSON();
    assert.match(embed.description, /NOT REGISTERED/);
    assert.match(embed.description, /Unknown Person/);
});
