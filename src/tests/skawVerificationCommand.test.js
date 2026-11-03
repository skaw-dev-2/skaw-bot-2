import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import verificationCommand from '../commands/Utility/verification.js';

test('verification command exposes the approved administration workflow', () => {
  const command = verificationCommand.data.toJSON();
  assert.equal(command.name, 'verification');
  assert.equal(command.default_member_permissions, PermissionFlagsBits.ManageGuild.toString());

  const names = command.options.map(option => option.name);
  assert.deepEqual(names, ['setup', 'publish', 'status', 'logs', 'manual', 'reset']);

  const setup = command.options.find(option => option.name === 'setup');
  const setupOptionNames = setup.options.map(option => option.name);
  assert.deepEqual(setupOptionNames, [
    'verified-role',
    'unverified-role',
    'channel',
    'log-channel',
    'panel-title',
    'panel-description',
    'guide-text',
    'image-url',
  ]);
});
