import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';

import rerollCommand from '../commands/Giveaway/greroll.js';
import { selectRerollWinners } from '../services/giveawayService.js';
import { InteractionHelper } from '../utils/interactionHelper.js';

test('reroll command exposes an optional winners count', () => {
    const winnersOption = rerollCommand.data.toJSON().options.find(
        option => option.name === 'winners'
    );

    assert.ok(winnersOption, 'winners option should be registered');
    assert.equal(winnersOption.type, 4);
    assert.equal(winnersOption.required, false);
    assert.equal(winnersOption.min_value, 1);
    assert.equal(winnersOption.max_value, 10);
});

test('reroll selects exactly the requested number of eligible winners', () => {
    const participants = Array.from({ length: 10 }, (_, index) => `user-${index + 1}`);
    const previousWinners = participants.slice(0, 8);

    const winners = selectRerollWinners(participants, 2, previousWinners);

    assert.equal(winners.length, 2);
    assert.deepEqual(new Set(winners), new Set(['user-9', 'user-10']));
    assert.ok(winners.every(userId => !previousWinners.includes(userId)));
});

test('reroll excludes winners selected in previous reroll rounds', () => {
    const participants = Array.from({ length: 8 }, (_, index) => `user-${index + 1}`);

    const firstRound = selectRerollWinners(participants, 2, ['user-1']);
    const secondRound = selectRerollWinners(participants, 2, ['user-1', ...firstRound]);

    assert.equal(firstRound.length, 2);
    assert.equal(secondRound.length, 2);
    assert.ok(secondRound.every(userId => !['user-1', ...firstRound].includes(userId)));
    assert.equal(new Set([...firstRound, ...secondRound]).size, 4);
});

test('reroll retains configured fixed winners when they are still eligible', () => {
    const winners = selectRerollWinners(
        ['user-1', 'user-2', 'user-3', 'user-4'],
        2,
        ['user-1'],
        ['user-3']
    );

    assert.equal(winners.length, 2);
    assert.ok(winners.includes('user-3'));
    assert.ok(!winners.includes('user-1'));
});

test('reroll rejects a requested count above the remaining eligible entries', () => {
    assert.throws(
        () => selectRerollWinners(['user-1', 'user-2', 'user-3'], 2, ['user-1', 'user-2']),
        /eligible participant/
    );
});

test('reroll rejects a winner count outside the configured range', () => {
    assert.throws(
        () => selectRerollWinners(['user-1', 'user-2'], 11, []),
        /Invalid winner count: 11/
    );
});


test('reroll interaction is deferred ephemerally and completes through editReply', async () => {
    const deferCalls = [];
    const editCalls = [];
    const interaction = {
        id: '1569369999999999999',
        user: { id: '123456789012345678' },
        deferred: false,
        replied: false,
        async deferReply(options) {
            deferCalls.push(options);
            this.deferred = true;
        },
        async editReply(options) {
            editCalls.push(options);
            this.replied = true;
            return options;
        },
    };

    assert.equal(
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral }),
        true
    );
    assert.deepEqual(deferCalls, [{ flags: MessageFlags.Ephemeral }]);

    assert.equal(
        await InteractionHelper.safeReply(interaction, { content: 'Reroll completed.' }),
        true
    );
    assert.deepEqual(editCalls, [{ content: 'Reroll completed.' }]);
});
