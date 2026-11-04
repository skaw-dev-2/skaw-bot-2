import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import verificationCommand from '../commands/Utility/verification.js';

test('verification command exposes only the single panel subcommand', () => {
  const command = verificationCommand.data.toJSON();
  assert.equal(command.name, 'verification');
  assert.equal(command.default_member_permissions, PermissionFlagsBits.ManageGuild.toString());
  assert.deepEqual(command.options.map(option => option.name), ['panel']);
});
