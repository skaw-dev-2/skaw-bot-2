import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAutoResponderInteraction, handleAutoResponderMessage, openAutoResponderPanel } from '../services/autoResponderPanelService.js';
import {
    buildAutoResponderPayload,
    deleteAutoResponderTemplate,
    dispatchAutoResponderMessage,
    findAutoResponderMatch,
    getAutoResponderConfig,
    isAutoResponderCooldownActive,
    isAutoResponderTemplateReady,
    normalizeAutoResponderConfig,
    normalizeAutoResponderPrefix,
    resetAutoResponderCooldownsForTests,
    saveAutoResponderConfig,
    setAutoResponderTemplateEnabled,
    upsertAutoResponderTemplate,
} from '../services/autoResponderService.js';

const GUILD_ID = '77777777777777777';
const CHANNEL_ID = '88888888888888888';
const OTHER_CHANNEL_ID = '99999999999999999';

function template(overrides = {}) {
    return {
        id: 'template123',
        name: 'Partnership Information',
        triggers: [{ type: 'keyword', value: 'partnership' }],
        matchMode: 'exact',
        responseMode: 'text',
        textResponse: 'Hello {user}, welcome to {server}.',
        embed: { title: '', description: '', color: '#2563EB', imageUrl: '', thumbnailUrl: '', footer: '' },
        excludedChannels: [],
        cooldownSeconds: 5,
        enabled: true,
        createdAt: '2026-10-28T00:00:00.000Z',
        ...overrides,
    };
}

function runtime(config) {
    const store = new Map();
    const sends = [];
    const client = {
        user: { id: '99999999999999999' },
        db: {
            async get(key, fallback = null) { return store.has(key) ? structuredClone(store.get(key)) : fallback; },
            async set(key, value) { store.set(key, structuredClone(value)); },
            async delete(key) { store.delete(key); },
        },
    };
    store.set('guild:' + GUILD_ID + ':auto_responder:v1', structuredClone(config));
    function makeMessage(content, authorId = '12345678901234567', channelId = CHANNEL_ID, sendImpl = null) {
        const sent = [];
        const channel = {
            id: channelId,
            name: 'general',
            guildId: GUILD_ID,
            isTextBased: () => true,
            async send(payload) {
                if (sendImpl) return sendImpl(payload);
                sent.push(payload);
                sends.push(payload);
                return { id: String(66666666666666666n + BigInt(sends.length)) };
            },
        };
        return {
            content,
            author: { id: authorId, bot: false, username: 'Kings' },
            member: { displayName: 'Kings' },
            guild: { id: GUILD_ID, name: 'SKAW GROUP' },
            channel,
            sent,
            deleted: false,
            async delete() { this.deleted = true; return this; },
        };
    }
    return { client, store, sends, makeMessage };
}

test('default Auto Responder prefix is ! and custom prefixes are validated', () => {
    assert.equal(normalizeAutoResponderConfig({}).prefix, '!');
    assert.equal(normalizeAutoResponderPrefix('?'), '?');
    assert.throws(() => normalizeAutoResponderPrefix('bad prefix'), /tanpa spasi/);
    assert.throws(() => normalizeAutoResponderPrefix('/'), /tidak diperbolehkan/);
});

test('Exact Match ignores case and outer whitespace but rejects extra words and punctuation', () => {
    const config = normalizeAutoResponderConfig({ templates: [template()] });
    for (const message of ['Partnership', 'partnership', 'PARTNERSHIP', ' partnership ']) {
        assert.equal(findAutoResponderMatch(config, message, CHANNEL_ID)?.template.id, 'template123');
    }
    for (const message of ['kenapa partnership', 'info partnership dong', 'partnership?', 'partnerships']) {
        assert.equal(findAutoResponderMatch(config, message, CHANNEL_ID), null, message);
    }
});

test('Contains Match recognizes whole phrases but avoids partial-word matches', () => {
    const config = normalizeAutoResponderConfig({
        templates: [template({ matchMode: 'contains', triggers: [{ type: 'keyword', value: 'partnership' }] })],
    });
    assert.ok(findAutoResponderMatch(config, 'Need PARTNERSHIP info please', CHANNEL_ID));
    assert.equal(findAutoResponderMatch(config, 'partnerships are useful', CHANNEL_ID), null);
});

test('Exact matches outrank Contains matches and only one template is returned', () => {
    const config = normalizeAutoResponderConfig({
        templates: [
            template({ id: 'contains-template', name: 'Generic', matchMode: 'contains', triggers: [{ type: 'keyword', value: 'partnership' }], createdAt: '2026-10-28T00:00:00.000Z' }),
            template({ id: 'exact-template', name: 'Specific', matchMode: 'exact', triggers: [{ type: 'keyword', value: 'partnership info' }], createdAt: '2026-10-28T00:01:00.000Z' }),
        ],
    });
    assert.equal(findAutoResponderMatch(config, 'partnership info', CHANNEL_ID)?.template.id, 'exact-template');
});

test('text commands use the configured prefix and Exact Match rejects trailing arguments', () => {
    const config = normalizeAutoResponderConfig({
        prefix: '?',
        templates: [template({ triggers: [{ type: 'command', value: 'pricelist' }] })],
    });
    assert.equal(findAutoResponderMatch(config, '?pricelist', CHANNEL_ID)?.template.id, 'template123');
    assert.equal(findAutoResponderMatch(config, '!pricelist', CHANNEL_ID), null);
    assert.equal(findAutoResponderMatch(config, '?pricelist please', CHANNEL_ID), null);
});

test('excluded channels suppress one template without affecting other channels', () => {
    const config = normalizeAutoResponderConfig({
        templates: [template({ excludedChannels: [CHANNEL_ID] })],
    });
    assert.equal(findAutoResponderMatch(config, 'partnership', CHANNEL_ID), null);
    assert.equal(findAutoResponderMatch(config, 'partnership', OTHER_CHANNEL_ID)?.template.id, 'template123');
});

test('template readiness requires all selected response formats to be configured', () => {
    assert.equal(isAutoResponderTemplateReady(template()), true);
    assert.equal(isAutoResponderTemplateReady(template({ responseMode: 'text', textResponse: '' })), false);
    assert.equal(isAutoResponderTemplateReady(template({ responseMode: 'embed', textResponse: '', embed: { title: '', description: '' } })), false);
    assert.equal(isAutoResponderTemplateReady(template({ responseMode: 'both', embed: { title: 'Title', description: '' } })), true);
});

test('payload builder renders placeholders and includes Embed configuration', () => {
    const config = normalizeAutoResponderConfig({
        templates: [template({
            responseMode: 'both',
            textResponse: 'Hi {mention} from {server} in {channel}.',
            embed: { title: 'Welcome {user}', description: 'Welcome to {server}.', color: '#00AAFF', imageUrl: '', thumbnailUrl: '', footer: 'SKAW GROUP' },
        })],
    });
    const testMessage = {
        member: { displayName: 'Kings' },
        author: { id: '12345678901234567', username: 'Kings' },
        guild: { name: 'SKAW GROUP' },
        channel: { name: 'general' },
    };
    const payload = buildAutoResponderPayload(config.templates[0], testMessage);
    assert.equal(payload.content, 'Hi <@12345678901234567> from SKAW GROUP in general.');
    assert.equal(payload.allowedMentions.parse.length, 0);
    assert.equal(payload.embeds.length, 1);
    assert.equal(payload.embeds[0].data.title, 'Welcome Kings');
    assert.equal(payload.embeds[0].data.description, 'Welcome to SKAW GROUP.');
});

test('dispatch sends the response before deleting trigger and applies cooldown per member/template', async () => {
    resetAutoResponderCooldownsForTests();
    const { client, sends, makeMessage } = runtime({ templates: [template()] });
    const first = makeMessage('PARTNERSHIP', '12345678901234567');
    assert.equal(await dispatchAutoResponderMessage(first, client), true);
    assert.equal(sends.length, 1);
    assert.equal(first.deleted, true);
    assert.equal(sends[0].content, 'Hello Kings, welcome to SKAW GROUP.');

    const repeated = makeMessage('partnership', '12345678901234567');
    assert.equal(await dispatchAutoResponderMessage(repeated, client), false);
    assert.equal(repeated.deleted, false);
    assert.equal(sends.length, 1);

    const anotherMember = makeMessage('partnership', '12345678901234568');
    assert.equal(await dispatchAutoResponderMessage(anotherMember, client), true);
    assert.equal(anotherMember.deleted, true);
    assert.equal(sends.length, 2);
});

test('failed response send does not delete the trigger or start a cooldown', async () => {
    resetAutoResponderCooldownsForTests();
    const { client, makeMessage } = runtime({ templates: [template()] });
    const message = makeMessage('partnership', '12345678901234567', CHANNEL_ID, async () => { throw new Error('send failed'); });
    assert.equal(await dispatchAutoResponderMessage(message, client), false);
    assert.equal(message.deleted, false);
    assert.equal(isAutoResponderCooldownActive(GUILD_ID + ':template123:12345678901234567'), false);
});

test('config and template CRUD persist data and reject duplicate triggers', async () => {
    const { client } = runtime({});
    const created = await upsertAutoResponderTemplate(client, GUILD_ID, {
        name: 'Partnership',
        triggers: [{ type: 'keyword', value: 'partnership' }],
        matchMode: 'exact',
        responseMode: 'text',
        textResponse: 'This is the partnership information.',
        enabled: true,
    }, '12345678901234567');
    assert.ok(created.template.id);
    assert.equal(created.template.enabled, true);
    assert.equal((await getAutoResponderConfig(client, GUILD_ID)).templates.length, 1);

    await assert.rejects(
        upsertAutoResponderTemplate(client, GUILD_ID, {
            name: 'Another Partnership',
            triggers: [{ type: 'keyword', value: 'PARTNERSHIP' }],
            matchMode: 'exact',
            responseMode: 'text',
            textResponse: 'Different response.',
        }),
        /sudah digunakan/,
    );

    const disabled = await setAutoResponderTemplateEnabled(client, GUILD_ID, created.template.id, false);
    assert.equal(disabled.template.enabled, false);
    const removed = await deleteAutoResponderTemplate(client, GUILD_ID, created.template.id);
    assert.equal(removed.config.templates.length, 0);
});

test('enabling an incomplete draft is rejected', async () => {
    const { client } = runtime({});
    const created = await upsertAutoResponderTemplate(client, GUILD_ID, {
        name: 'Draft',
        triggers: [{ type: 'keyword', value: 'draft-keyword' }],
        responseMode: 'text',
        textResponse: '',
        enabled: false,
    });
    await assert.rejects(setAutoResponderTemplateEnabled(client, GUILD_ID, created.template.id, true), /Lengkapi Response/);
});

test('dispatch does not reply in DMs or to bot messages', async () => {
    const { client, makeMessage } = runtime({ templates: [template()] });
    const fromBot = makeMessage('partnership');
    fromBot.author.bot = true;
    assert.equal(await dispatchAutoResponderMessage(fromBot, client), false);
    const dm = makeMessage('partnership');
    dm.guild = null;
    assert.equal(await dispatchAutoResponderMessage(dm, client), false);
});

test('interactive panel entrypoints load and are exported', () => {
    assert.equal(typeof handleAutoResponderMessage, 'function');
    assert.equal(typeof handleAutoResponderInteraction, 'function');
    assert.equal(typeof openAutoResponderPanel, 'function');
});
