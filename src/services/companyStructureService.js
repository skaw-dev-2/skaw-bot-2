import { randomUUID } from 'node:crypto';
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';

export const COMPANY_STRUCTURE_CHANNEL_ID = '1510967982044745738';
export const MANAGEMENT_COMPANY_ROLE_ID = '1414623053471547474';
export const COMPANY_STRUCTURE_DRAFT_TTL_MS = 12 * 60 * 1000;

const DEFAULT_SECTIONS = [
  { key: 'ceo', title: 'Chief Executive Officer', roleId: '1432365826136080625', kind: 'management', order: 10, enabled: true },
  { key: 'coo', title: 'Chief Operating Officer', roleId: '1432366070911598794', kind: 'management', order: 20, enabled: true },
  { key: 'cfo', title: 'Chief Financial Officer', roleId: '1432367796515373056', kind: 'management', order: 30, enabled: true },
  { key: 'cmo', title: 'Chief Marketing Officer', roleId: '1466364388117315665', kind: 'management', order: 40, enabled: true },
  { key: 'human-resources-officer', title: 'Human Resources Officer', roleId: '1432367493242032309', kind: 'management', order: 50, enabled: true },
  { key: 'chief-creative-officer', title: 'Chief Creative Officer', roleId: '1471649299967512587', kind: 'management', order: 60, enabled: true },
  { key: 'chief-mechanic-officer', title: 'Chief Mechanic Officer', roleId: '1466363836951957801', kind: 'management', order: 70, enabled: true },
  { key: 'chief-builder-officer', title: 'Chief Builder Officer', roleId: '1466364144180527241', kind: 'management', order: 80, enabled: true },
  { key: 'chief-trucker-officer', title: 'Chief Trucker Officer', roleId: '1466364014606159934', kind: 'management', order: 90, enabled: true },
  { key: 'deputy-operation-officer', title: 'Deputy Operation Officer', roleId: '1466084643001602081', kind: 'management', order: 110, enabled: true },
  { key: 'deputy-financial-officer', title: 'Deputy Financial Officer', roleId: '1466363661621792823', kind: 'management', order: 120, enabled: true },
  { key: 'deputy-marketing-officer', title: 'Deputy Marketing Officer', roleId: '1466375043138191380', kind: 'management', order: 130, enabled: true },
  { key: 'deputy-mechanic-officer', title: 'Deputy Mechanic Officer', roleId: '1466365041468117083', kind: 'management', order: 140, enabled: true },
  { key: 'deputy-trucker-officer', title: 'Deputy Trucker Officer', roleId: '1466364841282506783', kind: 'management', order: 150, enabled: true },
  { key: 'deputy-builder-officer', title: 'Deputy Builder Officer', roleId: '1466365148708081859', kind: 'management', order: 160, enabled: true },
  { key: 'executive-workshop', title: 'Executive Workshop', roleId: '1432368240012689559', kind: 'management', order: 170, enabled: true },
  { key: 'executive-trucker', title: 'Executive Trucker', roleId: '1432368698664161300', kind: 'management', order: 180, enabled: true },
  { key: 'management-company-fallback', title: 'Management Company | SKAW', roleId: MANAGEMENT_COMPANY_ROLE_ID, kind: 'managementFallback', order: 190, enabled: true },
  { key: 'partnership-company', title: 'Partnership Company | SKAW', roleId: '1414623346452336823', kind: 'partner', order: 210, enabled: true },
  { key: 'mechanic-division', title: 'Mechanic Division | SKAW', roleId: '1414623229288513586', kind: 'division', order: 300, enabled: true },
  { key: 'workshop-1', title: 'Workshop 1', roleId: '1436228415492456448', kind: 'workshop', order: 311, enabled: true },
  { key: 'workshop-2', title: 'Workshop 2', roleId: '1436228814949715998', kind: 'workshop', order: 312, enabled: true },
  { key: 'workshop-3', title: 'Workshop 3', roleId: '1436228874823405589', kind: 'workshop', order: 313, enabled: true },
  { key: 'workshop-4', title: 'Workshop 4', roleId: '1437062950497288212', kind: 'workshop', order: 314, enabled: true },
  { key: 'workshop-5', title: 'Workshop 5', roleId: '1440548885855600681', kind: 'workshop', order: 315, enabled: true },
  { key: 'workshop-6', title: 'Workshop 6', roleId: '1479735429266931883', kind: 'workshop', order: 316, enabled: true },
  { key: 'workshop-7', title: 'Workshop 7', roleId: '1522080501383565484', kind: 'workshop', order: 317, enabled: true },
  { key: 'workshop-8', title: 'Workshop 8', roleId: '1564094273387888691', kind: 'workshop', order: 318, enabled: true },
  { key: 'trucker-division', title: 'Trucker Division | SKAW', roleId: '1414623154151882882', kind: 'division', order: 330, enabled: true },
  { key: 'taxi-division', title: 'Taxi Division | SKAW', roleId: '1521028847380992021', kind: 'division', order: 340, enabled: true },
  { key: 'builder-division', title: 'Builder | SKAW', roleId: '1456912660510543945', kind: 'division', order: 350, enabled: true },
];

const draftStore = new Map();

// Full guild-member fetches use Discord Gateway opcode 8, which is rate limited.
// Coalesce concurrent requests and briefly reuse a successful result; Discord's
// member add/update/remove events keep the manager cache current in the meantime.
const memberFetchCache = new WeakMap();
const memberFetchInFlight = new WeakMap();
const MEMBER_FETCH_CACHE_TTL_MS = 20_000;
const MAX_MEMBER_FETCH_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchGuildMembers(guild) {
  const manager = guild.members;
  const cached = memberFetchCache.get(manager);
  if (cached && Date.now() - cached.fetchedAt < MEMBER_FETCH_CACHE_TTL_MS) {
    return cached.members;
  }

  const currentRequest = memberFetchInFlight.get(manager);
  if (currentRequest) return currentRequest;

  const request = (async () => {
    for (let attempt = 1; attempt <= MAX_MEMBER_FETCH_ATTEMPTS; attempt += 1) {
      try {
        const members = await manager.fetch();
        memberFetchCache.set(manager, { members, fetchedAt: Date.now() });
        return members;
      } catch (error) {
        const message = String(error?.message || error);
        const retryMatch = message.match(/retry after\\s+([\\d.]+)\\s+seconds?/i);
        const isOpcodeRateLimit = /opcode\\s+8.*rate.?limit/i.test(message);
        if (attempt >= MAX_MEMBER_FETCH_ATTEMPTS || (!retryMatch && !isOpcodeRateLimit)) {
          throw error;
        }

        // Respect Discord's explicit retry-after value. If the gateway error
        // omits it, use a conservative pause before retrying once more.
        const retryMs = retryMatch
          ? Math.ceil(Number(retryMatch[1]) * 1000) + 300
          : 6_000;
        await sleep(Math.max(300, retryMs));
      }
    }
    throw new Error('Unable to fetch the server member list after rate-limit retries.');
  })();

  memberFetchInFlight.set(manager, request);
  try {
    return await request;
  } finally {
    if (memberFetchInFlight.get(manager) === request) {
      memberFetchInFlight.delete(manager);
    }
  }
}

function configKey(guildId) {
  return 'guild:' + guildId + ':company_structure';
}

function defaultConfig(guildId) {
  return {
    version: 1,
    guildId,
    channelId: COMPANY_STRUCTURE_CHANNEL_ID,
    bannerUrl: 'https://cdn.discordapp.com/attachments/1563718579742842930/1564497289349697609/CS-BANNER.png?ex=6ae17b24&is=6ae029a4&hm=01936041ed60ce3fdf866e65f11aeba90f32695fb1c64f1cdfd23931bb4736ca',
    bannerConfigured: true,
    messageId: null,
    messageChannelId: null,
    lastUpdatedAt: null,
    updatedAt: new Date().toISOString(),
    sections: DEFAULT_SECTIONS.map(section => ({ ...section })),
  };
}

function normalizeConfig(raw, guildId) {
  const defaults = defaultConfig(guildId);
  if (!raw || typeof raw !== 'object') return defaults;

  return {
    ...defaults,
    ...raw,
    guildId,
    channelId: String(raw.channelId || defaults.channelId),
    bannerUrl: typeof raw.bannerUrl === 'string' && raw.bannerUrl.trim()
      ? raw.bannerUrl.trim()
      : (raw.bannerConfigured === true ? null : defaults.bannerUrl),
    bannerConfigured: raw.bannerConfigured === true || Boolean(raw.bannerUrl),
    messageId: raw.messageId ? String(raw.messageId) : null,
    messageChannelId: raw.messageChannelId ? String(raw.messageChannelId) : null,
    sections: Array.isArray(raw.sections)
      ? raw.sections.map(section => ({
          ...section,
          key: String(section.key || ''),
          title: String(section.title || 'Untitled category'),
          roleId: String(section.roleId || ''),
          kind: ['management', 'managementFallback', 'division', 'workshop', 'partner'].includes(section.kind)
            ? section.kind
            : 'division',
          order: Number.isFinite(Number(section.order)) ? Number(section.order) : 999,
          enabled: section.enabled !== false,
          customTitle: section.customTitle === true,
        })).filter(section => section.key && /^\d{17,20}$/.test(section.roleId))
      : defaults.sections,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : defaults.updatedAt,
  };
}

export async function getCompanyStructureConfig(client, guildId) {
  if (!client?.db || typeof client.db.get !== 'function' || typeof client.db.set !== 'function') {
    throw new Error('Database is not available for Company Structure settings.');
  }

  const key = configKey(guildId);
  const raw = await client.db.get(key, null);
  if (!raw || typeof raw !== 'object') {
    const config = defaultConfig(guildId);
    return await saveCompanyStructureConfig(client, guildId, config);
  }
  return normalizeConfig(raw, guildId);
}

export async function saveCompanyStructureConfig(client, guildId, config) {
  const normalized = normalizeConfig({
    ...config,
    guildId,
    updatedAt: new Date().toISOString(),
  }, guildId);

  const result = await client.db.set(configKey(guildId), normalized);
  if (result === false) {
    throw new Error('The database could not save Company Structure settings. Check PostgreSQL status.');
  }
  return normalized;
}

export async function canManageCompanyStructure(interaction) {
  if (!interaction?.guild || !interaction?.user) return false;
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return false;

  if (
    member.id === interaction.guild.ownerId ||
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  ) {
    return true;
  }

  const managementRoleIds = new Set([
    MANAGEMENT_COMPANY_ROLE_ID,
    '1432365826136080625', '1432366070911598794', '1432367796515373056',
    '1466364388117315665', '1432367493242032309', '1471649299967512587',
    '1466363836951957801', '1466364144180527241', '1466364014606159934',
    '1466084643001602081', '1466363661621792823', '1466375043138191380',
    '1466365041468117083', '1466364841282506783', '1466365148708081859',
    '1432368240012689559', '1432368698664161300',
  ]);

  return [...managementRoleIds].some(roleId => member.roles.cache.has(roleId));
}

function safeDisplayName(value) {
  return String(value || 'Unknown')
    .replace(/\\/g, '\\\\')
    .replace(/([_*~|>])/g, '\\$1')
    .replace(/\n|\r/g, ' ')
    .slice(0, 80);
}

export async function buildCompanyStructureSnapshot(guild, config) {
  await guild.roles.fetch();
  const members = await fetchGuildMembers(guild);
  const sectionOrder = [...config.sections].sort((a, b) => a.order - b.order);
  const missingRoles = sectionOrder
    .filter(section => section.enabled && !guild.roles.cache.has(section.roleId))
    .map(section => ({ key: section.key, title: section.title, roleId: section.roleId }));

  const managementPositionRoleIds = new Set(
    sectionOrder.filter(section => section.kind === 'management').map(section => section.roleId),
  );
  const fallbackSection = sectionOrder.find(section => section.kind === 'managementFallback');
  const fallbackRoleId = fallbackSection?.roleId || MANAGEMENT_COMPANY_ROLE_ID;

  // Management positions use the configured section order as their priority.
  // A person with multiple configured management-position roles is shown in
  // only the first enabled role category that matches. Division and workshop
  // membership are processed separately below and may still list that person.
  const orderedManagementPositions = sectionOrder.filter(section =>
    section.kind === 'management'
      && section.enabled
      && guild.roles.cache.has(section.roleId),
  );
  const primaryManagementRoleByMember = new Map();
  for (const member of members.values()) {
    const primarySection = orderedManagementPositions.find(section =>
      member.roles.cache.has(section.roleId),
    );
    if (primarySection) {
      primaryManagementRoleByMember.set(member.id, primarySection.roleId);
    }
  }

  const sections = sectionOrder.map(section => {
    const roleExists = guild.roles.cache.has(section.roleId);
    let holders = [];

    if (section.enabled && roleExists) {
      holders = [...members.values()].filter(member => {
        if (section.kind === 'managementFallback') {
          return member.roles.cache.has(fallbackRoleId)
            && ![...managementPositionRoleIds].some(roleId => member.roles.cache.has(roleId));
        }
        if (section.kind === 'management') {
          return primaryManagementRoleByMember.get(member.id) === section.roleId;
        }
        return member.roles.cache.has(section.roleId);
      });
    }

    const uniqueNames = new Map();
    for (const member of holders) {
      uniqueNames.set(member.id, safeDisplayName(member.displayName || member.user?.username));
    }

    return {
      ...section,
      roleExists,
      members: [...uniqueNames.values()].sort((a, b) => a.localeCompare(b, 'id', { sensitivity: 'base' })),
    };
  });

  const workshopSections = sections.filter(section => section.enabled && section.roleExists && section.kind === 'workshop');
  const workshopMemberships = new Map();
  for (const section of workshopSections) {
    const role = guild.roles.cache.get(section.roleId);
    for (const member of members.values()) {
      if (!member.roles.cache.has(section.roleId)) continue;
      const current = workshopMemberships.get(member.id) || {
        displayName: safeDisplayName(member.displayName || member.user?.username),
        workshops: [],
      };
      current.workshops.push(role?.name || section.title);
      workshopMemberships.set(member.id, current);
    }
  }
  const workshopConflicts = [...workshopMemberships.values()]
    .filter(item => item.workshops.length > 1)
    .map(item => ({ displayName: item.displayName, workshops: item.workshops }));

  return {
    sections,
    missingRoles,
    workshopConflicts,
    generatedAt: new Date().toISOString(),
  };
}

function renderStructureText(snapshot) {
  // Empty workshops remain visible as N/A to match SKAW's existing structure
  // format. Other empty categories are omitted to keep the message compact.
  const visibleSections = snapshot.sections.filter(section =>
    section.enabled
      && section.roleExists
      && (section.members.length > 0 || section.kind === 'workshop'),
  );
  if (visibleSections.length === 0) {
    return 'No members currently match the configured Company Structure roles.';
  }

  return visibleSections.map(section => {
    const heading = section.customTitle
      ? '**' + safeDisplayName(section.title) + '**'
      : '**<@&' + section.roleId + '>**';
    const memberLines = section.members.length > 0
      ? section.members.map(name => '• ' + name).join('\n')
      : 'N/A';
    return heading + '\n' + memberLines;
  }).join('\n\n');
}

function chunkText(text, maxChunkLength) {
  const chunks = [];
  let current = '';

  for (const line of text.split('\n')) {
    const candidate = current ? current + '\n' + line : line;
    if (candidate.length <= maxChunkLength) {
      current = candidate;
      continue;
    }

    if (current) chunks.push(current);
    if (line.length > maxChunkLength) {
      for (let i = 0; i < line.length; i += maxChunkLength) {
        chunks.push(line.slice(i, i + maxChunkLength));
      }
      current = '';
    } else {
      current = line;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function formatJakartaTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date) + ' WIB';
}

export function buildCompanyStructureEmbeds(snapshot, config, options = {}) {
  const isPreview = options.preview === true;
  const structureText = renderStructureText(snapshot);
  if (structureText.length > 5400) {
    throw new Error('The structure exceeds Discord message embed limits. Remove unnecessary categories or shorten member display names before publishing.');
  }

  const chunks = chunkText(structureText, 3500);
  const publishedAt = config.lastUpdatedAt ? new Date(config.lastUpdatedAt) : null;
  const nowText = formatJakartaTimestamp(new Date());
  const footerText = isPreview
    ? (publishedAt
      ? 'Preview • Last published ' + formatJakartaTimestamp(publishedAt) + ' • timestamp updates on Publish'
      : 'Preview only • timestamp updates on Publish')
    : 'Last Updated: ' + nowText;

  const embeds = [];
  if (config.bannerUrl) {
    const banner = new EmbedBuilder()
      .setColor(0x0878FF)
      .setTitle(isPreview ? 'COMPANY STRUCTURE • PREVIEW' : 'COMPANY STRUCTURE')
      .setImage(config.bannerUrl);
    embeds.push(banner);
  }

  const structureEmbeds = chunks.map((chunk, index) => {
    const embed = new EmbedBuilder()
      .setColor(0x0878FF)
      .setDescription(chunk);

    if (!config.bannerUrl && index === 0) {
      embed.setTitle(isPreview ? 'COMPANY STRUCTURE • PREVIEW' : 'COMPANY STRUCTURE');
    }

    if (index === chunks.length - 1) {
      embed.setFooter({ text: footerText });
    }

    return embed;
  });
  embeds.push(...structureEmbeds);

  if (isPreview && ((snapshot.missingRoles || []).length > 0 || (snapshot.workshopConflicts || []).length > 0)) {
    const warningParts = [];
    if (snapshot.missingRoles.length > 0) {
      const missingText = snapshot.missingRoles
        .map(role => '• ' + role.title + ' (' + role.roleId + ')')
        .join('\n')
        .slice(0, 1500);
      warningParts.push('**MISSING ROLES — Publish is blocked**\n' + missingText + '\nFix or remove these categories in /cs manage, then run /cs update again.');
    }
    if ((snapshot.workshopConflicts || []).length > 0) {
      const conflictText = snapshot.workshopConflicts
        .slice(0, 20)
        .map(item => '• ' + item.displayName + ': ' + item.workshops.join(', '))
        .join('\n')
        .slice(0, 1800);
      warningParts.push('**MULTIPLE WORKSHOP ASSIGNMENTS — Please review**\n' + conflictText + '\nThis is a warning only; Publishing remains available.');
    }
    embeds.unshift(new EmbedBuilder()
      .setColor(snapshot.missingRoles.length > 0 ? 0xE74C3C : 0xE67E22)
      .setTitle(snapshot.missingRoles.length > 0 ? 'Review required • missing Discord roles' : 'Review required • workshop assignments')
      .setDescription(warningParts.join('\n\n').slice(0, 4000)));
  }

  if (embeds.length > 10) {
    throw new Error('This structure needs more than 10 Discord embeds. Shorten the member list or reduce the structure before publishing.');
  }

  return embeds;
}

export async function createCompanyStructureDraft(client, guild, ownerId) {
  const config = await getCompanyStructureConfig(client, guild.id);
  const snapshot = await buildCompanyStructureSnapshot(guild, config);
  const draft = {
    id: randomUUID().replace(/-/g, '').slice(0, 12),
    guildId: guild.id,
    ownerId,
    createdAt: Date.now(),
    configUpdatedAt: config.updatedAt,
    config: structuredClone(config),
    snapshot,
    overrides: {},
  };
  draftStore.set(draft.id, draft);
  while (draftStore.size > 100) draftStore.delete(draftStore.keys().next().value);
  return draft;
}

export function getCompanyStructureDraft(draftId) {
  const draft = draftStore.get(draftId);
  if (!draft) return null;
  if (Date.now() - draft.createdAt > COMPANY_STRUCTURE_DRAFT_TTL_MS) {
    draftStore.delete(draftId);
    return null;
  }
  return draft;
}

export function deleteCompanyStructureDraft(draftId) {
  draftStore.delete(draftId);
}

export function getDraftSnapshotView(draft) {
  return {
    ...draft.snapshot,
    sections: draft.snapshot.sections.map(section => ({
      ...section,
      members: Object.hasOwn(draft.overrides, section.key)
        ? [...draft.overrides[section.key]]
        : [...section.members],
    })),
  };
}

export function setCompanyStructureDraftRoster(draft, sectionKey, rawText) {
  const section = draft.snapshot.sections.find(item => item.key === sectionKey && item.enabled && item.roleExists);
  if (!section) throw new Error('That category is unavailable in this preview.');
  const names = String(rawText || '')
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:[•*-]\s*)/, '').trim())
    .filter(Boolean)
    .map(safeDisplayName);
  if (names.length > 100) throw new Error('A category can contain at most 100 manually edited preview entries.');
  draft.overrides[sectionKey] = [...new Set(names)];
}

export async function publishCompanyStructureDraft(client, draft) {
  const guild = await client.guilds.fetch(draft.guildId);
  const currentConfig = await getCompanyStructureConfig(client, draft.guildId);
  if (currentConfig.updatedAt !== draft.configUpdatedAt) {
    throw new Error('Company Structure settings changed after this preview. Run /cs update again before publishing.');
  }

  // Publish the reviewed preview snapshot instead of issuing a second opcode-8
  // guild-member request. The config timestamp check above ensures its category
  // configuration still matches the draft; roster edits are applied below.
  const snapshot = structuredClone(draft.snapshot);
  if (snapshot.missingRoles.length > 0) {
    throw new Error('Publishing is blocked because one or more configured Discord roles are missing. Resolve them in /cs manage and preview again.');
  }

  for (const [sectionKey, names] of Object.entries(draft.overrides)) {
    const section = snapshot.sections.find(item => item.key === sectionKey);
    if (section) section.members = [...names];
  }

  const embeds = buildCompanyStructureEmbeds(snapshot, currentConfig, { preview: false });
  const channel = await client.channels.fetch(currentConfig.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased() || typeof channel.send !== 'function') {
    throw new Error('The configured Company Structure channel is unavailable or is not a text channel. Open /cs manage to fix it.');
  }

  const previousChannelId = currentConfig.messageChannelId || currentConfig.channelId;
  let previousMessage = null;
  if (currentConfig.messageId && previousChannelId === currentConfig.channelId) {
    previousMessage = await channel.messages.fetch(currentConfig.messageId).catch(() => null);
  } else if (currentConfig.messageId && previousChannelId !== currentConfig.channelId) {
    const oldChannel = await client.channels.fetch(previousChannelId).catch(() => null);
    if (oldChannel?.messages?.fetch) {
      previousMessage = await oldChannel.messages.fetch(currentConfig.messageId).catch(() => null);
    }
  }

  let message;
  let action;
  if (previousMessage && previousChannelId === currentConfig.channelId) {
    message = await previousMessage.edit({ content: null, embeds, allowedMentions: { parse: [] } });
    action = 'edited';
  } else {
    message = await channel.send({ embeds, allowedMentions: { parse: [] } });
    action = 'created';

    if (previousMessage && previousChannelId !== currentConfig.channelId) {
      await previousMessage.delete().catch(() => {});
    }
  }

  const persistedConfig = {
    ...currentConfig,
    messageId: message.id,
    messageChannelId: currentConfig.channelId,
    lastUpdatedAt: new Date().toISOString(),
  };

  let configSaved = true;
  try {
    await saveCompanyStructureConfig(client, draft.guildId, persistedConfig);
  } catch {
    configSaved = false;
  }

  return { message, action, configSaved, channelId: currentConfig.channelId };
}

export function buildCompanyStructurePreviewComponents(draft) {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = globalThis.__unusedCompanyStructureComponents || {};
  // Component builders are loaded lazily by the command/handlers so this service stays focused on data and rendering.
  return { ActionRowBuilder, ButtonBuilder, ButtonStyle, draftId: draft.id };
}

export function makeCompanyStructureCategoryKey(roleId, title) {
  const slug = String(title || 'category')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20) || 'category';
  return 'custom-' + slug + '-' + String(roleId).slice(-5);
}
