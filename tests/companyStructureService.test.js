import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompanyStructureEmbeds, buildCompanyStructureSnapshot, createCompanyStructureDraft, getCompanyStructureDraft, deleteCompanyStructureDraft, setCompanyStructureDraftRoster, publishCompanyStructureDraft } from '../src/services/companyStructureService.js';

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

  const sourceMembers = [
    {
      id: '111111111111111111',
      displayName: 'Kevin_Monterrey',
      user: { username: 'kevin' },
      roles: [ROLE.ceo, ROLE.deputy, ROLE.executive, ROLE.managementCompany, ROLE.mechanicDivision, ROLE.workshop1, ROLE.mechanicSenior, ROLE.civilian],
    },
    {
      id: '222222222222222222',
      displayName: 'Maya_Florenzia',
      user: { username: 'maya' },
      roles: [ROLE.managementCompany, ROLE.partnership, ROLE.civilian],
    },
  ];
  const members = sourceMembers.map(member => ({
    ...member,
    roles: { cache: { has: id => member.roles.includes(id) } },
  }));

  return {
    guild: {
      roles: { cache: roleCache, fetch: async () => roleCache },
      members: { fetch: async () => new Map(members.map(member => [member.id, member])) },
    },
    config: { guildId: '1414500416724406315', sections },
    members,
    sourceMembers,
  };
}

test('multiple management roles produce only one primary role by configured priority', async () => {
  const { guild, config } = makeRuntime();
  const snapshot = await buildCompanyStructureSnapshot(guild, config);
  const membersByKey = Object.fromEntries(snapshot.sections.map(section => [section.key, section.members]));

  assert.deepEqual(membersByKey.ceo, ['Kevin_Monterrey']);
  assert.deepEqual(membersByKey.deputy, []);
  assert.deepEqual(membersByKey.executive, []);
  assert.deepEqual(membersByKey['management-company'], ['Maya_Florenzia']);
});

test('division and workshop membership remain visible separately; rank and civilian markers are not sections', async () => {
  const { guild, config } = makeRuntime();
  const snapshot = await buildCompanyStructureSnapshot(guild, config);
  const membersByKey = Object.fromEntries(snapshot.sections.map(section => [section.key, section.members]));

  assert.deepEqual(membersByKey['mechanic-division'], ['Kevin_Monterrey']);
  assert.deepEqual(membersByKey['workshop-1'], ['Kevin_Monterrey']);
  assert.equal(snapshot.sections.some(section => section.roleId === ROLE.mechanicSenior), false);
  assert.equal(snapshot.sections.some(section => section.roleId === ROLE.civilian), false);
});

test('management-company fallback only lists members without any configured management position', async () => {
  const { guild, config } = makeRuntime();
  const snapshot = await buildCompanyStructureSnapshot(guild, config);
  const fallback = snapshot.sections.find(section => section.key === 'management-company');

  assert.deepEqual(fallback.members, ['Maya_Florenzia']);
  assert.equal(fallback.members.includes('Kevin_Monterrey'), false);
});

test('primary management role follows the configured section order, not role position order', async () => {
  const { guild, config } = makeRuntime();
  config.sections = [...config.sections].map(section => ({ ...section }));
  config.sections.find(section => section.key === 'deputy').order = 5;
  config.sections.find(section => section.key === 'ceo').order = 20;

  const snapshot = await buildCompanyStructureSnapshot(guild, config);
  const membersByKey = Object.fromEntries(snapshot.sections.map(section => [section.key, section.members]));

  assert.deepEqual(membersByKey.deputy, ['Kevin_Monterrey']);
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


test('custom category titles still render as Discord role mentions in Company Structure', async () => {
  const { guild, config } = makeRuntime();
  const ceoSection = config.sections.find(section => section.key === 'ceo');
  ceoSection.title = 'Modshoper | SKAW';
  ceoSection.customTitle = true;

  const snapshot = await buildCompanyStructureSnapshot(guild, config);
  const embeds = buildCompanyStructureEmbeds(snapshot, { ...config, bannerUrl: null, lastUpdatedAt: null });
  const description = embeds.map(embed => embed.toJSON().description || '').join('\n');

  assert.ok(description.includes('**<@&1432365826136080625>**'));
  assert.ok(!description.includes('**Modshoper | SKAW**'));
});


test('Company Structure compacts only management, preserves spacing in non-management sections, and adds a divider', async () => {
  const { guild, config } = makeRuntime();
  const snapshot = await buildCompanyStructureSnapshot(guild, config);
  const embeds = buildCompanyStructureEmbeds(snapshot, { ...config, bannerUrl: null, lastUpdatedAt: null });
  const description = embeds.map(embed => embed.toJSON().description || '').join('\n');

  assert.ok(description.includes('**<@&1432365826136080625>**\n• Kevin\\_Monterrey\n> **<@&1414623053471547474>**\n• Maya\\_Florenzia'));
  const [managementBlock, otherBlock] = description.split('\n\n-------------------------------------------------\n\n');
  assert.ok(managementBlock);
  assert.ok(otherBlock);
  assert.ok(!managementBlock.includes('\n\n> **'));
  assert.ok(description.includes('• Maya\\_Florenzia\n\n-------------------------------------------------\n\n> **<@&1414623346452336823>**'));
  assert.ok(description.includes('> **<@&1414623229288513586>**\n• Kevin\\_Monterrey'));
  assert.ok(description.includes('> **<@&1436228415492456448>**\n• Kevin\\_Monterrey'));
  assert.ok(description.includes('• Maya\\_Florenzia\n\n> **<@&1414623229288513586>**'));
  assert.ok(description.includes('• Kevin\\_Monterrey\n\n> **<@&1436228415492456448>**'));
});


test('published Company Structure shows a visible Last Updated timestamp in Jakarta time', async () => {
  const { guild, config } = makeRuntime();
  const snapshot = await buildCompanyStructureSnapshot(guild, config);
  const lastUpdatedAt = '2026-10-27T11:45:00.000Z';

  const embeds = buildCompanyStructureEmbeds(snapshot, {
    ...config,
    bannerUrl: null,
    lastUpdatedAt,
  }, { preview: false });
  const finalEmbed = embeds.at(-1).toJSON();

  assert.match(finalEmbed.description, /Last Updated:\*\* 27 Oct 2026, 18:45 WIB/);
  assert.equal(finalEmbed.footer.text, 'SKAW Group • Company Structure');
});

test('unpublished Company Structure preview tells managers its timestamp is set on publish', async () => {
  const { guild, config } = makeRuntime();
  const snapshot = await buildCompanyStructureSnapshot(guild, config);

  const embeds = buildCompanyStructureEmbeds(snapshot, {
    ...config,
    bannerUrl: null,
    lastUpdatedAt: null,
  }, { preview: true });
  const finalEmbed = embeds.at(-1).toJSON();

  assert.match(finalEmbed.description, /Last Updated:\*\* Will be set on Publish/);
  assert.match(finalEmbed.footer.text, /Preview only/);
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
  }, { preview: true });
  const json = embeds.map(embed => embed.toJSON());
  const structureEmbed = json.at(-1);

  assert.equal(json[0].image.url, bannerUrl);
  assert.ok(structureEmbed.description.includes('Kevin' + String.fromCharCode(92) + '_Monterrey'));
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


test('Company Structure draft stays available after the former 12-minute timeout', async () => {
  const { guild, config } = makeRuntime();
  guild.id = config.guildId;

  let storedConfig = {
    ...config,
    guildId: config.guildId,
    updatedAt: new Date().toISOString(),
  };
  const client = {
    db: {
      get: async () => storedConfig,
      set: async (_key, value) => {
        storedConfig = value;
        return true;
      },
    },
  };

  const draft = await createCompanyStructureDraft(client, guild, '333333333333333333');
  draft.createdAt = Date.now() - (24 * 60 * 60 * 1000);

  assert.equal(getCompanyStructureDraft(draft.id), draft);
  deleteCompanyStructureDraft(draft.id);
});


test('saved roster names are stable by Discord user ID while role membership remains dynamic', async () => {
  const { guild, config, members } = makeRuntime();
  const kevinId = '111111111111111111';
  const mayaId = '222222222222222222';
  config.rosterNamesByUserId = {
    [kevinId]: 'Kevin_Previous_Name',
    [mayaId]: 'Maya_Previous_Name',
  };
  members[0].displayName = 'Kevin_New_Discord_Display';
  members[1].displayName = 'Maya_New_Discord_Display';
  guild.id = config.guildId;

  let storedConfig = { ...config, updatedAt: new Date().toISOString() };
  const client = {
    db: {
      get: async () => storedConfig,
      set: async (_key, value) => { storedConfig = value; return true; },
    },
  };
  const draft = await createCompanyStructureDraft(client, guild, '333333333333333333');
  const snapshot = draft.snapshot;
  const byKey = Object.fromEntries(snapshot.sections.map(section => [section.key, section]));

  assert.deepEqual(byKey.ceo.members, ['Kevin_Previous_Name']);
  assert.deepEqual(byKey['management-company'].members, ['Maya_Previous_Name']);
  assert.deepEqual(byKey['workshop-1'].members, ['Kevin_Previous_Name']);
  assert.equal(byKey.ceo.memberEntries[0].userId, kevinId);
  assert.equal(snapshot.rosterNamesByUserId[kevinId], 'Kevin_Previous_Name');
  deleteCompanyStructureDraft(draft.id);
});

test('roster names replace spaces with one underscore and accept old Markdown-escaped names', async () => {
  const { guild, config, members } = makeRuntime();
  members[0].displayName = 'Leonardo Maximilano';
  members[1].displayName = 'Eugene' + String.fromCharCode(92).repeat(3) + '_Maleek';

  const snapshot = await buildCompanyStructureSnapshot(guild, config);
  const byKey = Object.fromEntries(snapshot.sections.map(section => [section.key, section]));

  assert.deepEqual(byKey.ceo.members, ['Leonardo_Maximilano']);
  assert.deepEqual(byKey['management-company'].members, ['Eugene_Maleek']);
  assert.equal(snapshot.rosterNamesByUserId['111111111111111111'], 'Leonardo_Maximilano');
  assert.equal(snapshot.rosterNamesByUserId['222222222222222222'], 'Eugene_Maleek');

  const embeds = buildCompanyStructureEmbeds(snapshot, { ...config, bannerUrl: null, lastUpdatedAt: null });
  const renderedDescription = embeds.map(embed => embed.toJSON().description || '').join('\n');
  const slash = String.fromCharCode(92);
  assert.ok(renderedDescription.includes('Leonardo' + slash + '_Maximilano'));
  assert.equal(renderedDescription.includes('Leonardo' + slash + slash + '_Maximilano'), false);
});

test('manual display-name edits are stored against the matched Discord user ID', async () => {
  const { guild, config } = makeRuntime();
  guild.id = config.guildId;
  let storedConfig = { ...config, updatedAt: new Date().toISOString() };
  const client = {
    db: {
      get: async () => storedConfig,
      set: async (_key, value) => {
        storedConfig = value;
        return true;
      },
    },
  };

  const draft = await createCompanyStructureDraft(client, guild, '333333333333333333');
  setCompanyStructureDraftRoster(draft, 'ceo', 'Kevin' + String.fromCharCode(92) + '_CustomName');
  assert.equal(draft.overrides.ceo[0], 'Kevin_CustomName');
  assert.equal(draft.pendingRosterNamesByUserId['111111111111111111'], 'Kevin_CustomName');
  deleteCompanyStructureDraft(draft.id);
});


test('a member who loses a workshop role is removed from that workshop while the saved name remains available', async () => {
  const { guild, config, sourceMembers } = makeRuntime();
  const kevinId = '111111111111111111';
  config.rosterNamesByUserId = { [kevinId]: 'Kevin_Saved_Name' };
  sourceMembers[0].roles = sourceMembers[0].roles.filter(roleId => roleId !== ROLE.workshop1);

  const snapshot = await buildCompanyStructureSnapshot(guild, config);
  const byKey = Object.fromEntries(snapshot.sections.map(section => [section.key, section]));

  assert.deepEqual(byKey['workshop-1'].members, []);
  assert.deepEqual(byKey.ceo.members, ['Kevin_Saved_Name']);
  assert.equal(snapshot.rosterNamesByUserId[kevinId], 'Kevin_Saved_Name');
});


test('publishing persists newly discovered canonical names by Discord user ID', async () => {
  const { guild, config } = makeRuntime();
  guild.id = config.guildId;
  let storedConfig = { ...config, updatedAt: new Date().toISOString(), channelId: '555555555555555555', bannerUrl: null };
  const publishedMessage = { id: '666666666666666666' };
  const channel = {
    isTextBased: () => true,
    isDMBased: () => false,
    send: async () => publishedMessage,
  };
  const client = {
    db: {
      get: async () => storedConfig,
      set: async (_key, value) => { storedConfig = value; return true; },
    },
    guilds: { fetch: async () => guild },
    channels: { fetch: async () => channel },
  };

  const draft = await createCompanyStructureDraft(client, guild, '333333333333333333');
  const result = await publishCompanyStructureDraft(client, draft);

  assert.equal(result.configSaved, true);
  assert.equal(storedConfig.messageId, publishedMessage.id);
  assert.equal(storedConfig.rosterNamesByUserId['111111111111111111'], 'Kevin_Monterrey');
  assert.equal(storedConfig.rosterNamesByUserId['222222222222222222'], 'Maya_Florenzia');
  deleteCompanyStructureDraft(draft.id);
});
