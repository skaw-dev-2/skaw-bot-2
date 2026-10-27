import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompanyStructureEmbeds, buildCompanyStructureSnapshot } from '../src/services/companyStructureService.js';

const ROLE = Object.freeze({
  ceo: '1432365826136080625',
  deputy: '1466084643001602081',
  executive: '1432368240012689559',
  managementCompany: '1414623053471547474',
  mechanicDivision: '1414623229288513586',
  workshop1: '1436228415492456448',
  mechanicSenior: '1414629366574354512',
  civilian: '1415329997396119603',
  partnership: '1414623346452336823',
});

const sections = [
  { key: 'ceo', title: 'Chief Executive Officer', roleId: ROLE.ceo, kind: 'management', order: 10, enabled: true },
  { key: 'deputy', title: 'Deputy Operation Officer', roleId: ROLE.deputy, kind: 'management', order: 110, enabled: true },
  { key: 'executive', title: 'Executive Workshop', roleId: ROLE.executive, kind: 'management', order: 170, enabled: true },
  { key: 'management-company', title: 'Management Company | SKAW', roleId: ROLE.managementCompany, kind: 'managementFallback', order: 190, enabled: true },
  { key: 'partnership', title: 'Partnership Company | SKAW', roleId: ROLE.partnership, kind: 'partner', order: 210, enabled: true },
  { key: 'mechanic-division', title: 'Mechanic Division | SKAW', roleId: ROLE.mechanicDivision, kind: 'division', order: 300, enabled: true },
  { key: 'workshop-1', title: 'Workshop 1', roleId: ROLE.workshop1, kind: 'workshop', order: 311, enabled: true },
];

function makeRuntime() {
  const roleIds = new Set(sections.map(section => section.roleId));
  const roleIdsNeeded = [...roleIds, ROLE.mechanicSenior, ROLE.civilian];
  const roleCache = new Map(roleIdsNeeded.map(id => [id, { id, name: sections.find(section => section.roleId === id)?.title || id }]));

  const members = [
    {
      id: '111111111111111111',
      displayName: 'Kevin Monterrey',
      user: { username: 'kevin' },
      roles: [ROLE.ceo, ROLE.deputy, ROLE.executive, ROLE.managementCompany, ROLE.mechanicDivision, ROLE.workshop1, ROLE.mechanicSenior, ROLE.civilian],
    },
    {
      id: '222222222222222222',
      displayName: 'Maya Florenzia',
      user: { username: 'maya' },
      roles: [ROLE.managementCompany, ROLE.partnership, ROLE.civilian],
    },
  ].map(member => ({
    ...member,
    roles: { cache: { has: id => member.roles.includes(id) } },
  }));

  return {
    guild: {
      roles: { cache: roleCache, fetch: async () => roleCache },
      members: { fetch: async () => new Map(members.map(member => [member.id, member])) },
    },
    config: { guildId: '1414500416724406315', sections },
  };
}

test('multiple management roles produce only one primary role by configured priority', async () => {
  const { guild, config } = makeRuntime();
  const snapshot = await buildCompanyStructureSnapshot(guild, config);
  const membersByKey = Object.fromEntries(snapshot.sections.map(section => [section.key, section.members]));

  assert.deepEqual(membersByKey.ceo, ['Kevin Monterrey']);
  assert.deepEqual(membersByKey.deputy, []);
  assert.deepEqual(membersByKey.executive, []);
  assert.deepEqual(membersByKey['management-company'], ['Maya Florenzia']);
});

test('division and workshop membership remain visible separately; rank and civilian markers are not sections', async () => {
  const { guild, config } = makeRuntime();
  const snapshot = await buildCompanyStructureSnapshot(guild, config);
  const membersByKey = Object.fromEntries(snapshot.sections.map(section => [section.key, section.members]));

  assert.deepEqual(membersByKey['mechanic-division'], ['Kevin Monterrey']);
  assert.deepEqual(membersByKey['workshop-1'], ['Kevin Monterrey']);
  assert.equal(snapshot.sections.some(section => section.roleId === ROLE.mechanicSenior), false);
  assert.equal(snapshot.sections.some(section => section.roleId === ROLE.civilian), false);
});

test('management-company fallback only lists members without any configured management position', async () => {
  const { guild, config } = makeRuntime();
  const snapshot = await buildCompanyStructureSnapshot(guild, config);
  const fallback = snapshot.sections.find(section => section.key === 'management-company');

  assert.deepEqual(fallback.members, ['Maya Florenzia']);
  assert.equal(fallback.members.includes('Kevin Monterrey'), false);
});

test('primary management role follows the configured section order, not role position order', async () => {
  const { guild, config } = makeRuntime();
  config.sections = [...config.sections].map(section => ({ ...section }));
  config.sections.find(section => section.key === 'deputy').order = 5;
  config.sections.find(section => section.key === 'ceo').order = 20;

  const snapshot = await buildCompanyStructureSnapshot(guild, config);
  const membersByKey = Object.fromEntries(snapshot.sections.map(section => [section.key, section.members]));

  assert.deepEqual(membersByKey.deputy, ['Kevin Monterrey']);
  assert.deepEqual(membersByKey.ceo, []);
});

test('empty configured workshops remain visible as N/A', async () => {
  const { guild, config } = makeRuntime();
  const originalFetch = guild.members.fetch;
  guild.members.fetch = async () => {
    const members = await originalFetch();
    return new Map([...members.entries()].map(([id, member]) => [id, {
      ...member,
      roles: { cache: { has: roleId => roleId !== ROLE.workshop1 && member.roles.cache.has(roleId) } },
    }]));
  };

  const snapshot = await buildCompanyStructureSnapshot(guild, config);
  const embeds = buildCompanyStructureEmbeds(snapshot, { ...config, bannerUrl: null, lastUpdatedAt: null });
  const description = embeds.map(embed => embed.data?.description ?? embed.toJSON?.().description ?? '').join('\n');

  assert.match(description, /<@&1436228415492456448>/);
  assert.match(description, /N\/A/);
});

test('footer image is attached to the final structure embed below roster text, independently of banner', async () => {
  const { guild, config } = makeRuntime();
  const snapshot = await buildCompanyStructureSnapshot(guild, config);
  const bannerUrl = 'https://example.com/company-banner.png';
  const footerImageUrl = 'https://example.com/company-footer.png';

  const embeds = buildCompanyStructureEmbeds(snapshot, {
    ...config,
    bannerUrl,
    footerImageUrl,
    lastUpdatedAt: null,
  });
  const json = embeds.map(embed => embed.toJSON());
  const structureEmbed = json.at(-1);

  assert.equal(json[0].image.url, bannerUrl);
  assert.ok(structureEmbed.description.includes('Kevin Monterrey'));
  assert.equal(structureEmbed.image.url, footerImageUrl);
  assert.ok(structureEmbed.footer.text.includes('Preview only'));
});

test('repeated previews reuse the recently fetched guild member list', async () => {
  const { guild, config } = makeRuntime();
  const originalFetch = guild.members.fetch;
  let fetchCount = 0;
  guild.members.fetch = async () => {
    fetchCount += 1;
    return originalFetch();
  };

  await buildCompanyStructureSnapshot(guild, config);
  await buildCompanyStructureSnapshot(guild, config);

  assert.equal(fetchCount, 1);
});
