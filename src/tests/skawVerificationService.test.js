import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import {
  buildICNickname,
  buildVerificationPanelPayload,
  normalizeICNameKey,
  registerSkawMember,
  validateICNamePart,
} from '../services/skawVerificationService.js';

function createFixture({ failDataWrite = false } = {}) {
  const guildId = '44444444444444444';
  const verifiedRole = { id: '55555555555555555', name: 'Verified', position: 2, managed: false, editable: true };
  const unverifiedRole = { id: '66666666666666666', name: 'Unverified', position: 1, managed: false, editable: true };
  const roles = new Map([[verifiedRole.id, verifiedRole], [unverifiedRole.id, unverifiedRole]]);
  const store = new Map();
  store.set('guild:' + guildId + ':skaw_verification:config:v1', {
    enabled: true,
    verifiedRoleId: verifiedRole.id,
    unverifiedRoleId: unverifiedRole.id,
    logChannelId: null,
  });
  const db = {
    isDegraded: () => false,
    getStatus: () => ({ isDegraded: false, isAvailable: true }),
    async get(key, fallback = null) {
      return store.has(key) ? store.get(key) : fallback;
    },
    async set(key, value) {
      if (failDataWrite && key.endsWith(':skaw_verification:data:v1')) return false;
      store.set(key, value);
      return true;
    },
  };
  const client = { db };
  const botMember = {
    permissions: {
      has(flag) {
        return flag === PermissionFlagsBits.ManageRoles ||
          flag === PermissionFlagsBits.ManageNicknames;
      },
    },
    roles: { highest: { position: 10 } },
  };
  const guild = {
    id: guildId,
    ownerId: '99999999999999999',
    roles: { cache: roles },
    members: { me: botMember, async fetchMe() { return botMember; } },
    channels: { cache: new Map() },
  };

  function makeMember(id) {
    const member = {
      id,
      guild,
      user: { tag: 'tester#0001', username: 'tester' },
      displayName: 'tester',
      nickname: null,
      manageable: true,
      roles: {
        cache: new Map([[unverifiedRole.id, unverifiedRole]]),
        highest: { position: 1 },
        async add(roleId) { this.cache.set(String(roleId), roles.get(String(roleId))); },
        async remove(roleId) { this.cache.delete(String(roleId)); },
      },
      async setNickname(value) { this.nickname = value; },
    };
    return member;
  }

  return { client, guild, store, verifiedRole, unverifiedRole, makeMember };
}

test('IC name parts accept letters and Unicode marks only', () => {
  assert.equal(validateICNamePart('  Vicenzo  '), 'Vicenzo');
  assert.equal(validateICNamePart('Álejandro'), 'Álejandro');
  assert.throws(() => validateICNamePart('John2'), /hanya boleh berisi huruf/);
  assert.throws(() => validateICNamePart('John Smith'), /hanya boleh berisi huruf/);
  assert.throws(() => validateICNamePart(''), /wajib diisi/);
});

test('nickname uses underscore and enforces Discord length limit', () => {
  assert.equal(buildICNickname('Vicenzo', 'Alejandro'), 'Vicenzo_Alejandro');
  assert.throws(() => buildICNickname('A'.repeat(20), 'B'.repeat(12)), /32 karakter/);
});

test('IC duplicate key comparison ignores case and Unicode normalization differences', () => {
  assert.equal(normalizeICNameKey('VICENZO', 'ALEJANDRO'), normalizeICNameKey('Vicenzo', 'Alejandro'));
  assert.equal(normalizeICNameKey('Jose\u0301', 'Diaz'), normalizeICNameKey('José', 'Diaz'));
});

test('verification panel exposes unique persistent Register and Guide buttons', () => {
  const payload = buildVerificationPanelPayload({
    panelTitle: 'SKAW Member Verification',
    panelDescription: 'Register your IC name.',
    imageUrl: null,
  });
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.components.length, 1);
  const components = payload.components[0].toJSON().components;
  assert.deepEqual(components.map(item => item.custom_id), ['skaw_vf_register', 'skaw_vf_guide']);
});

test('registration assigns Verified, removes Unverified, updates nickname, and records history', async () => {
  const fixture = createFixture();
  const member = fixture.makeMember('11111111111111111');
  const result = await registerSkawMember(
    fixture.client,
    fixture.guild,
    member,
    { firstName: 'Vicenzo', lastName: 'Alejandro' },
    { source: 'self-service', actorId: member.id },
  );

  assert.equal(member.nickname, 'Vicenzo_Alejandro');
  assert.equal(member.roles.cache.has(fixture.verifiedRole.id), true);
  assert.equal(member.roles.cache.has(fixture.unverifiedRole.id), false);
  assert.equal(result.record.status, 'verified');
  assert.equal(result.duplicateWarning, false);

  const data = fixture.store.get('guild:' + fixture.guild.id + ':skaw_verification:data:v1');
  assert.equal(data.members[member.id].icName, 'Vicenzo Alejandro');
  assert.equal(data.logs[0].action, 'registration_created');
});

test('duplicate IC names produce a warning but do not block registration', async () => {
  const fixture = createFixture();
  const first = fixture.makeMember('11111111111111111');
  const second = fixture.makeMember('22222222222222222');

  await registerSkawMember(fixture.client, fixture.guild, first, {
    firstName: 'Vicenzo', lastName: 'Alejandro',
  });
  const result = await registerSkawMember(fixture.client, fixture.guild, second, {
    firstName: 'Vicenzo', lastName: 'Alejandro',
  });

  assert.equal(result.duplicateWarning, true);
  assert.deepEqual(result.duplicateUserIds, [first.id]);
  assert.equal(result.record.status, 'verified');
  assert.equal(second.roles.cache.has(fixture.verifiedRole.id), true);
});

test('re-registration updates the IC name without duplicating the old name index', async () => {
  const fixture = createFixture();
  const member = fixture.makeMember('11111111111111111');

  await registerSkawMember(fixture.client, fixture.guild, member, {
    firstName: 'Vicenzo', lastName: 'Alejandro',
  });
  const result = await registerSkawMember(fixture.client, fixture.guild, member, {
    firstName: 'Marco', lastName: 'Rossi',
  });

  const data = fixture.store.get('guild:' + fixture.guild.id + ':skaw_verification:data:v1');
  assert.equal(result.updated, true);
  assert.equal(member.nickname, 'Marco_Rossi');
  assert.equal(data.members[member.id].registrationCount, 2);
  assert.equal(data.nameIndex[normalizeICNameKey('Vicenzo', 'Alejandro')], undefined);
  assert.deepEqual(data.nameIndex[normalizeICNameKey('Marco', 'Rossi')], [member.id]);
});

test('failed persistent write rolls nickname and role changes back', async () => {
  const fixture = createFixture({ failDataWrite: true });
  const member = fixture.makeMember('11111111111111111');

  await assert.rejects(
    registerSkawMember(fixture.client, fixture.guild, member, {
      firstName: 'Vicenzo', lastName: 'Alejandro',
    }),
    /PostgreSQL menolak penyimpanan/,
  );
  assert.equal(member.nickname, null);
  assert.equal(member.roles.cache.has(fixture.verifiedRole.id), false);
  assert.equal(member.roles.cache.has(fixture.unverifiedRole.id), true);
});
