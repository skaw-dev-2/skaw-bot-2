import test from 'node:test';
import assert from 'node:assert/strict';
import roleCommand from '../commands/Utility/role.js';
import {
  buildRoleAssignmentPlan, canManageRoleTemplates, createRoleTemplate, getRoleHierarchyViolations,
  getRoleTemplateConfig, normalizeRoleTemplateConfig, setRoleTemplateEnabled, setRoleTemplateRoles,
} from '../services/roleTemplateService.js';

const GUILD_ID = '77777777777777777';
const ACTOR_ID = '12345678901234567';
const TARGET_ID = '12345678901234568';
const ROLE_A = '22345678901234567';
const ROLE_B = '32345678901234567';
const WORKSHOP_ROLE = '42345678901234568';

function makeClient(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    db: {
      async get(key, fallback = null) { return store.has(key) ? structuredClone(store.get(key)) : fallback; },
      async set(key, value) { store.set(key, structuredClone(value)); },
    },
  };
}
function makeRole(id, name, position, overrides = {}) {
  return {
    id, name, position, managed: false, editable: true,
    comparePositionTo(other) { return this.position - other.position; },
    ...overrides,
  };
}
function makeAssignmentRuntime({ actorPosition = 5, rolePosition = 2, workshopPosition = 2, workshopRoleSelected = false, existingRoleIds = [] } = {}) {
  const store = new Map();
  store.set('guild:' + GUILD_ID + ':role_templates:v1', {
    version: 1,
    templates: [{
      id: 'template1234567890', name: 'Mechanic', slug: 'mechanic',
      roleIds: [ROLE_A, ROLE_B], enabled: true,
      createdAt: '2026-10-28T00:00:00.000Z', createdBy: ACTOR_ID,
    }],
  });
  const lowRole = makeRole(ROLE_A, 'Mechanic Division', rolePosition);
  const secondRole = makeRole(ROLE_B, 'Company Staff', 1);
  const workshopRole = makeRole(WORKSHOP_ROLE, 'Workshop WS3', workshopPosition);
  const roleCache = new Map([[ROLE_A, lowRole], [ROLE_B, secondRole], [WORKSHOP_ROLE, workshopRole]]);
  const targetRoles = {
    cache: new Map(existingRoleIds.map(id => [id, roleCache.get(id)]).filter(([, role]) => role)),
    added: [],
    async add(ids) { this.added.push(...ids); },
  };
  const target = { id: TARGET_ID, user: { id: TARGET_ID, tag: 'Kings#0001' }, roles: targetRoles };
  const actor = {
    id: ACTOR_ID,
    roles: { highest: makeRole('42345678901234567', 'Deputy Mechanic', actorPosition) },
  };
  const botMember = { permissions: { has: permission => permission === 268435456n || permission?.bitfield === 268435456n } };
  const guild = {
    id: GUILD_ID, ownerId: '52345678901234567',
    roles: {
      cache: roleCache,
      async fetch(id) { return id ? roleCache.get(String(id)) || null : roleCache; },
    },
    members: {
      me: botMember,
      async fetchMe() { return botMember; },
      async fetch(id) { return id === ACTOR_ID ? actor : id === TARGET_ID ? target : null; },
    },
  };
  const replyCalls = [];
  const client = {
    db: {
      async get(key, fallback = null) { return store.has(key) ? structuredClone(store.get(key)) : fallback; },
      async set(key, value) { store.set(key, structuredClone(value)); },
    },
  };
  const interaction = {
    guild, guildId: GUILD_ID, user: { id: ACTOR_ID, tag: 'Deputy#0001' },
    memberPermissions: { has: () => true },
    options: {
      getString: () => 'mechanic',
      getUser: () => ({ id: TARGET_ID, tag: 'Kings#0001' }),
      getRole: () => workshopRoleSelected ? workshopRole : null,
    },
    async reply(payload) { replyCalls.push(payload); },
    async followUp(payload) { replyCalls.push(payload); },
  };
  return { client, interaction, target, replyCalls, roleCache, store };
}

test('role template names normalize whitespace and role IDs are validated', () => {
  const config = normalizeRoleTemplateConfig({ templates: [{
    id: 'one', name: '  Mechanic    Division  ', slug: 'Mechanic Division',
    roleIds: [ROLE_A, ROLE_A, 'bad-id'], enabled: true,
  }] });
  assert.equal(config.templates[0].name, 'Mechanic Division');
  assert.equal(config.templates[0].slug, 'mechanic-division');
  assert.deepEqual(config.templates[0].roleIds, [ROLE_A]);
  assert.equal(config.templates[0].enabled, true);
});

test('draft templates persist, role lists deduplicate, and enabling requires roles', async () => {
  const client = makeClient();
  const created = await createRoleTemplate(client, GUILD_ID, '  Mechanic   ', ACTOR_ID);
  assert.equal(created.template.name, 'Mechanic');
  assert.equal(created.template.enabled, false);
  await assert.rejects(setRoleTemplateEnabled(client, GUILD_ID, created.template.id, true), /at least one role/i);
  const saved = await setRoleTemplateRoles(client, GUILD_ID, created.template.id, [ROLE_A, ROLE_A, ROLE_B], ACTOR_ID);
  assert.deepEqual(saved.template.roleIds, [ROLE_A, ROLE_B]);
  await setRoleTemplateEnabled(client, GUILD_ID, created.template.id, true, ACTOR_ID);
  const loaded = await getRoleTemplateConfig(client, GUILD_ID);
  assert.equal(loaded.templates[0].enabled, true);
  assert.deepEqual(loaded.templates[0].roleIds, [ROLE_A, ROLE_B]);
});

test('role management accepts Administrator or Manage Server only', () => {
  assert.equal(canManageRoleTemplates({ has: permission => permission === 8n }), true);
  assert.equal(canManageRoleTemplates({ has: permission => permission === 32n }), true);
  assert.equal(canManageRoleTemplates({ has: () => false }), false);
});

test('rank hierarchy allows lower roles and blocks equal or higher roles, with owner exemption', () => {
  const highest = makeRole('42345678901234567', 'Deputy Mechanic', 10);
  const actor = { id: ACTOR_ID, guild: { ownerId: 'owner' }, roles: { highest } };
  const lower = makeRole(ROLE_A, 'Mechanic Trainee', 2);
  const equal = makeRole(ROLE_B, 'Deputy Mechanic', 10);
  const higher = makeRole('62345678901234567', 'Chief Executive', 20);
  assert.deepEqual(getRoleHierarchyViolations(actor, [lower]), []);
  assert.deepEqual(getRoleHierarchyViolations(actor, [equal, higher]).map(role => role.name), ['Deputy Mechanic', 'Chief Executive']);
  assert.deepEqual(getRoleHierarchyViolations({ ...actor, id: 'owner' }, [higher], 'owner'), []);
});

test('assignment plan only adds missing roles and never schedules removal', () => {
  const roles = new Map([
    [ROLE_A, makeRole(ROLE_A, 'Mechanic Division', 2)],
    [ROLE_B, makeRole(ROLE_B, 'Company Staff', 1)],
  ]);
  const plan = buildRoleAssignmentPlan({ roleIds: [ROLE_A, ROLE_B] }, roles, [ROLE_A], GUILD_ID);
  assert.deepEqual(plan.toAdd.map(role => role.id), [ROLE_B]);
  assert.deepEqual(plan.alreadyHad.map(role => role.id), [ROLE_A]);
  assert.deepEqual(plan.unavailable, []);
  assert.equal(Object.hasOwn(plan, 'toRemove'), false);
});

test('/role rejects higher-ranked roles before making any changes', async () => {
  const runtime = makeAssignmentRuntime({ actorPosition: 1, rolePosition: 10 });
  await roleCommand.execute(runtime.interaction, null, runtime.client);
  assert.deepEqual(runtime.target.roles.added, []);
  assert.match(runtime.replyCalls[0].content, /Rank protection blocked/);
  assert.match(runtime.replyCalls[0].content, /No roles were changed/);
});

test('/role adds an optional workshop placement separately from template roles', async () => {
  const runtime = makeAssignmentRuntime({
    actorPosition: 20, rolePosition: 2, workshopPosition: 3,
    workshopRoleSelected: true, existingRoleIds: [ROLE_A],
  });
  await roleCommand.execute(runtime.interaction, null, runtime.client);
  assert.deepEqual(runtime.target.roles.added, [ROLE_B, WORKSHOP_ROLE]);
  assert.equal(runtime.replyCalls.length, 1);
  assert.equal(runtime.replyCalls[0].flags, 64);
  assert.match(runtime.replyCalls[0].content, /Workshop placement: \\*\\*Workshop WS3\\*\\* \\(added\\)/);
  assert.match(runtime.replyCalls[0].content, /No existing roles were removed/);
});

test('/role rank protection includes the selected workshop placement role', async () => {
  const runtime = makeAssignmentRuntime({
    actorPosition: 5, rolePosition: 2, workshopPosition: 10, workshopRoleSelected: true,
  });
  await roleCommand.execute(runtime.interaction, null, runtime.client);
  assert.deepEqual(runtime.target.roles.added, []);
  assert.match(runtime.replyCalls[0].content, /Rank protection blocked/);
  assert.match(runtime.replyCalls[0].content, /Workshop WS3/);
});
