import test from 'node:test';
import assert from 'node:assert/strict';

import {
    MESSAGE_MANAGER_DEFAULT_EMBED_COLOR,
    buildManagedEmbed,
    buildManagedMessagePayload,
    memberHasAnyAllowedRole,
    normalizeMessageRecord,
    validateEmbedData,
    validateHexColor,
    validateOptionalHttpUrl,
    validateRegularMessage,
} from '../services/messageManagerService.js';

const MESSAGE_ID = '123456789012345678';
const CHANNEL_ID = '123456789012345679';
const USER_ID = '123456789012345680';

test('regular messages require non-empty content and enforce Discord length', () => {
    assert.equal(validateRegularMessage('  Hello SKAW  '), '  Hello SKAW  ');
    assert.throws(() => validateRegularMessage('   '), /cannot be empty/i);
    assert.throws(() => validateRegularMessage('x'.repeat(2001)), /2000 characters/i);
});

test('embed color defaults to SKAW blue and accepts a custom HEX color', () => {
    const normalized = validateEmbedData({ description: 'Hello' });
    assert.equal(normalized.color, MESSAGE_MANAGER_DEFAULT_EMBED_COLOR);
    assert.equal(validateHexColor('#abcdef'), '#ABCDEF');
    assert.throws(() => validateHexColor('blue'), /6-digit HEX/i);
});

test('embed URL fields only accept HTTP and HTTPS URLs', () => {
    assert.equal(validateOptionalHttpUrl('https://example.com/image.png', 'Image URL'), 'https://example.com/image.png');
    assert.equal(validateOptionalHttpUrl('', 'Image URL'), '');
    assert.throws(() => validateOptionalHttpUrl('javascript:alert(1)', 'Image URL'), /HTTP or HTTPS/i);
    assert.throws(() => validateOptionalHttpUrl('not-a-url', 'Image URL'), /valid HTTP or HTTPS URL/i);
});

test('embed validation enforces description and dependent author/footer fields', () => {
    assert.throws(() => validateEmbedData({}), /description is required/i);
    assert.throws(() => validateEmbedData({
        description: 'Description',
        authorIconUrl: 'https://example.com/icon.png',
    }), /Author Name/i);
    assert.throws(() => validateEmbedData({
        description: 'Description',
        footerIconUrl: 'https://example.com/icon.png',
    }), /Footer Text/i);
});

test('embed builder applies color, title, author, footer and media', () => {
    const embed = buildManagedEmbed({
        title: 'SKAW News',
        description: 'Important update.',
        color: '#1500FF',
        authorName: 'SKAW GROUP',
        authorUrl: 'https://example.com',
        authorIconUrl: 'https://example.com/author.png',
        footerText: 'Right Solution, Great Quality',
        footerIconUrl: 'https://example.com/footer.png',
        thumbnailUrl: 'https://example.com/thumb.png',
        imageUrl: 'https://example.com/image.png',
    }).toJSON();

    assert.equal(embed.title, 'SKAW News');
    assert.equal(embed.description, 'Important update.');
    assert.equal(embed.color, 0x1500FF);
    assert.equal(embed.author.name, 'SKAW GROUP');
    assert.equal(embed.footer.text, 'Right Solution, Great Quality');
    assert.equal(embed.thumbnail.url, 'https://example.com/thumb.png');
    assert.equal(embed.image.url, 'https://example.com/image.png');
});

test('managed regular message payload attaches the Edit button and disables automatic mentions', () => {
    const record = normalizeMessageRecord({
        messageId: MESSAGE_ID,
        channelId: CHANNEL_ID,
        type: 'regular',
        content: 'Hello Kings!',
        createdBy: USER_ID,
    });

    const payload = buildManagedMessagePayload(record);
    assert.equal(payload.content, 'Hello Kings!');
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.equal(payload.components.length, 1);
    assert.equal(payload.components[0].components[0].data.custom_id, 'skaw_mm_v1_public_edit');
    assert.equal(payload.components[0].components[0].data.label, 'Edit');
});

test('managed embed message payload preserves the configured embed color', () => {
    const record = normalizeMessageRecord({
        messageId: MESSAGE_ID,
        channelId: CHANNEL_ID,
        type: 'embed',
        embed: {
            title: 'SKAW Announcement',
            description: 'Welcome to SKAW.',
            color: '#1500FF',
        },
        createdBy: USER_ID,
    });

    const payload = buildManagedMessagePayload(record);
    assert.equal(payload.embeds.length, 1);
    assert.equal(payload.embeds[0].data.color, 0x1500FF);
    assert.equal(payload.components[0].components[0].data.label, 'Edit');
});

test('role access follows OR logic and an empty role list grants no role-based access', () => {
    const member = {
        roles: {
            cache: {
                some: callback => ['111111111111111111', '222222222222222222']
                    .map(id => ({ id }))
                    .some(callback),
            },
        },
    };

    assert.equal(memberHasAnyAllowedRole(member, ['222222222222222222', '333333333333333333']), true);
    assert.equal(memberHasAnyAllowedRole(member, ['333333333333333333']), false);
    assert.equal(memberHasAnyAllowedRole(member, []), false);
});
