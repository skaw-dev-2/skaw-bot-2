import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildEmbedCreateModal,
    getModalInputMaxLength,
} from '../commands/Utility/message.js';

test('Discord modal text inputs are capped at the API maximum of 4000', () => {
    assert.equal(getModalInputMaxLength(4096), 4000);
    assert.equal(getModalInputMaxLength(4000), 4000);
    assert.equal(getModalInputMaxLength(2000), 2000);
    assert.equal(getModalInputMaxLength(0), 1);
    assert.equal(getModalInputMaxLength(Number.NaN), 1);
});

test('Embed creation modal serializes with valid Discord component lengths', () => {
    const modal = buildEmbedCreateModal({
        token: 'test-session',
        channelId: '',
        embed: {
            title: '',
            description: '',
            color: '#1500FF',
        },
    });

    const json = modal.toJSON();

    assert.equal(json.title, 'Create Embed Message');
    assert.equal(json.components.length, 4);

    const inputComponents = json.components
        .map(label => label.component)
        .filter(component => component?.type === 4);

    assert.equal(inputComponents.length, 3);
    assert.ok(inputComponents.every(component => component.max_length <= 4000));
    assert.equal(inputComponents.find(component => component.custom_id === 'mm_embed_description')?.max_length, 4000);
});
