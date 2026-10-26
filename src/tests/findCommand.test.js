import test from 'node:test';
import assert from 'node:assert/strict';
import findCommand from '../commands/Community/find.js';
import { upsertEmployeeDirectoryFromLog } from '../services/employeeDirectoryService.js';

const GUILD_ID = '77777777777777777';
const USER_ID = '12345678901234567';
const ROLE_ID = '1414629274282885120';
const RETIRED_ROLE_ID = '1429469335654633593';
const BLACKLIST_ROLE_ID = '1414628838557614222';

const roleDefinitions = new Map([
    [ROLE_ID, { id: ROLE_ID, name: 'Mechanic Junior | SKAW' }],
    [RETIRED_ROLE_ID, { id: RETIRED_ROLE_ID, name: 'Retired Employe | SKAW' }],
    [BLACKLIST_ROLE_ID, { id: BLACKLIST_ROLE_ID, name: 'Blacklist' }],
]);

function runtime({ hasRecord = true, selectedUser = null, employeeQuery, roleIds = [ROLE_ID] } = {}) {
    const store = new Map();
    const client = {
        db: {
            async get(key, fallback = null) { return store.has(key) ? structuredClone(store.get(key)) : fallback; },
            async set(key, value) { store.set(key, structuredClone(value)); },
        },
        guilds: { cache: new Map() },
    };
    const memberRoleCache = new Map(roleIds.map(id => [id, roleDefinitions.get(id) || { id, name: `Role ${id}` }]));
    const guild = {
        id: GUILD_ID,
        roles: { cache: new Map([...roleDefinitions.entries()]) },
        members: { cache: new Map() },
    };
    const member = {
        id: USER_ID,
        displayName: 'Kevin Monterrey',
        guild,
        roles: { cache: memberRoleCache },
    };
    guild.members.cache.set(USER_ID, member);
    guild.members.fetch = async id => String(id) === USER_ID ? member : null;
    client.guilds.cache.set(GUILD_ID, guild);

    const interaction = {
        client,
        guild,
        guildId: GUILD_ID,
        inGuild: () => true,
        options: {
            getString: () => employeeQuery !== undefined
                ? employeeQuery
                : selectedUser ? null : hasRecord ? USER_ID : 'Unknown Person',
            getUser: () => selectedUser,
            getFocused: () => String(employeeQuery ?? ''),
        },
        async deferReply(payload) { this.deferredPayload = payload; },
        async editReply(payload) { this.resultPayload = payload; return payload; },
        async reply(payload) { this.resultPayload = payload; return payload; },
    };
    return { client, guild, member, interaction, store };
}

function profileFields(interaction) {
    return interaction.resultPayload.embeds[0].toJSON().fields;
}

test('/find exposes optional employee autocomplete and optional Discord user picker options', () => {
    const schema = findCommand.data.toJSON();
    const employeeOption = schema.options.find(option => option.name === 'employee');
    const userOption = schema.options.find(option => option.name === 'user');

    assert.ok(employeeOption, 'employee text option exists');
    assert.equal(employeeOption.type, 3, 'employee is a STRING option');
    assert.equal(employeeOption.required, false, 'employee is optional so user can be used alone');
    assert.equal(employeeOption.autocomplete, true, 'employee name autocomplete stays enabled');
    assert.ok(userOption, 'user picker option exists');
    assert.equal(userOption.type, 6, 'user uses the Discord USER option type');
    assert.equal(userOption.required, false, 'user picker is optional so employee can be used alone');
});

test('/find returns an ephemeral profile with live server display name and status', async () => {
    const { client, guild, interaction } = runtime();
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

test('/find accepts a selected Discord user through the dedicated user option', async () => {
    const selectedUser = { id: USER_ID, username: 'kevin' };
    const { client, guild, interaction } = runtime({ selectedUser });
    await upsertEmployeeDirectoryFromLog(client, guild, {
        guildId: GUILD_ID,
        recordId: 'SKAW-EL-USER-PICKER',
        type: 'sign_in',
        publishedAt: '2026-10-26T06:00:00.000Z',
        data: { userId: USER_ID, displayName: 'Kevin Monterrey', position: ROLE_ID, recordedAt: '2026-10-26T06:00:00.000Z' },
    });

    await findCommand.execute(interaction);
    assert.equal(interaction.deferredPayload.flags, 64);
    const embed = interaction.resultPayload.embeds[0].toJSON();
    assert.equal(embed.title, 'SKAW EMPLOYEE PROFILE');
    assert.match(embed.description, /Kevin Monterrey \(\*\*<@12345678901234567>\*\*\)/);
});

test('/find rejects choosing both employee text and a user to avoid ambiguous input', async () => {
    const { interaction } = runtime({
        selectedUser: { id: USER_ID, username: 'kevin' },
        employeeQuery: 'Kevin Monterrey',
    });

    await findCommand.execute(interaction);
    assert.equal(interaction.deferredPayload, undefined);
    assert.equal(interaction.resultPayload.flags, 64);
    assert.match(interaction.resultPayload.content, /Please use only one search option/);
});

test('/find asks for a search input when neither option is supplied', async () => {
    const { interaction } = runtime({ employeeQuery: null, selectedUser: null });

    await findCommand.execute(interaction);
    assert.equal(interaction.deferredPayload, undefined);
    assert.equal(interaction.resultPayload.flags, 64);
    assert.match(interaction.resultPayload.content, /Choose a person/);
});

test('/find recognizes a former employee from Retired role when no old logs exist', async () => {
    const { interaction } = runtime({ hasRecord: false, employeeQuery: 'Kevin Monterrey', roleIds: [RETIRED_ROLE_ID] });

    // Name lookup with no directory entry; the live Retired role is the only source.
    await findCommand.execute(interaction);
    const embed = interaction.resultPayload.embeds[0].toJSON();
    assert.equal(embed.fields.find(field => field.name === 'EMPLOYMENT STATUS').value, 'FORMER EMPLOYEE');
    assert.equal(embed.fields.find(field => field.name === 'LAST KNOWN POSITION').value, 'Not recorded');
    assert.equal(embed.fields.find(field => field.name === 'LAST SIGN-OUT').value, 'Not recorded');
});

test('/find recognizes current Blacklist role when no Blacklist log exists', async () => {
    const { interaction } = runtime({ hasRecord: true, roleIds: [BLACKLIST_ROLE_ID] });

    await findCommand.execute(interaction);
    const fields = profileFields(interaction);
    assert.equal(fields.find(field => field.name === 'BLACKLIST STATUS').value, 'BLACKLISTED (current Discord role)');
    assert.equal(fields.find(field => field.name === 'EMPLOYMENT STATUS').value, 'INCOMPLETE RECORD');
});

test('/find current Retired role overrides a stale active directory status when no active position role is present', async () => {
    const { client, guild, interaction } = runtime({ roleIds: [RETIRED_ROLE_ID] });
    await upsertEmployeeDirectoryFromLog(client, guild, {
        guildId: GUILD_ID,
        recordId: 'SKAW-EL-STALE-ACTIVE',
        type: 'sign_in',
        publishedAt: '2026-10-20T06:00:00.000Z',
        data: { userId: USER_ID, displayName: 'Kevin Monterrey', position: ROLE_ID, recordedAt: '2026-10-20T06:00:00.000Z' },
    });

    await findCommand.execute(interaction);
    const fields = profileFields(interaction);
    assert.equal(fields.find(field => field.name === 'EMPLOYMENT STATUS').value, 'FORMER EMPLOYEE');
    assert.equal(fields.find(field => field.name === 'LAST KNOWN POSITION').value, 'Mechanic Junior | SKAW');
});


test('/find autocomplete labels a role-only Retired member as FORMER', async () => {
    const { interaction } = runtime({ hasRecord: false, employeeQuery: 'Kevin' , roleIds: [RETIRED_ROLE_ID] });
    interaction.options.getFocused = () => 'Kevin';
    interaction.respond = async choices => { interaction.autocompleteChoices = choices; return choices; };

    await findCommand.autocomplete(interaction);
    const retiredChoice = interaction.autocompleteChoices.find(choice => choice.value === USER_ID);
    assert.ok(retiredChoice, 'role-only retired employee appears in autocomplete');
    assert.match(retiredChoice.name, /FORMER/);
});
