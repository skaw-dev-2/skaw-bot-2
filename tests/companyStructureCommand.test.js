import test from 'node:test';
import assert from 'node:assert/strict';
import command from '../src/commands/Utility/cs.js';

test('/cs command registers the compact update, category add, and manage workflow', () => {
  const schema = command.data.toJSON();
  assert.equal(schema.name, 'cs');

  const update = schema.options.find(option => option.type === 1 && option.name === 'update');
  const category = schema.options.find(option => option.type === 2 && option.name === 'category');
  const manage = schema.options.find(option => option.type === 1 && option.name === 'manage');

  assert.ok(update, '/cs update is present');
  assert.ok(category, '/cs category is present');
  assert.ok(manage, '/cs manage is present');

  const add = category.options.find(option => option.type === 1 && option.name === 'add');
  assert.ok(add, '/cs category add is present');
  assert.deepEqual(
    add.options.map(option => option.name).sort(),
    ['name', 'role', 'section'],
  );
});

test('/cs update is configured with the management-first preview workflow', () => {
  const schema = command.data.toJSON();
  const update = schema.options.find(option => option.type === 1 && option.name === 'update');
  assert.ok(update);
  assert.equal(update.options?.length ?? 0, 0, 'update does not require extra arguments');
});
