import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder,
  ChannelType, EmbedBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits, RoleSelectMenuBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { ensureRecruitmentSchema } from '../utils/database/recruitmentSchema.js';
import { logger } from '../utils/logger.js';

const BLUE = 0x1A9EF3;
const DEFAULT_SETTINGS = Object.freeze({
  panelTitle: 'SKAW Group — Recruitment & Partnership',
  headline: 'Build your place in the SKAW network.',
  welcomeText: 'Selamat datang di halaman Recruitment & Partnership SKAW Group.',
  introduction: 'Pilih posisi pekerjaan atau profil partnership yang ingin kamu ajukan.',
  importantInfo: 'Pastikan seluruh informasi yang kamu kirim benar dan dapat dipertanggungjawabkan.',
  instructions: 'Pilih kategori pada menu di bawah, baca informasinya, lalu tekan Apply untuk membuat private ticket.',
  generalTerms: 'Dengan mengirim aplikasi, kamu menyetujui proses peninjauan yang berlaku di SKAW Group.',
  footerText: 'RIGHT SOLUTION, GREAT QUALITY · SKAW GROUP',
  embedColor: '#1A9EF3',
  bannerUrl: null,
  publicChannelId: null,
  panelMessageId: null,
  transcriptChannelId: null,
  logChannelId: null,
  starterProfilesSeeded: false,
  ticketSettings: { autoLockOnClose: true, allowUnlimitedApplications: true, cooldownSeconds: 0 },
});
const APPLICATION_STATUSES = Object.freeze([
  'awaiting_submission', 'submitted', 'under_review', 'interview',
  'partnership_discussion', 'revision_required', 'accepted', 'rejected', 'withdrawn',
]);
const STATUS_LABELS = Object.freeze({
  awaiting_submission: 'Awaiting Submission',
  submitted: 'Submitted',
  under_review: 'Under Review',
  interview: 'Interview',
  partnership_discussion: 'Partnership Discussion',
  revision_required: 'Revision Required',
  accepted: 'Accepted',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
});
const TICKET_LABELS = Object.freeze({
  creating: 'Creating', creation_failed: 'Creation Failed', open: 'Open', closed: 'Closed', archived: 'Archived',
});
const schemaPromises = new WeakMap();

export function slugifyRecruitmentProfile(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
}

export function normalizeRecruitmentPrefix(value) {
  const prefix = slugifyRecruitmentProfile(value).replace(/-+/g, '-').slice(0, 40);
  if (!prefix) throw new Error('Channel prefix harus berisi huruf atau angka.');
  return prefix;
}

export function formatRecruitmentSequence(value, width = 6) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Nomor aplikasi tidak valid.');
  return String(number).padStart(width, '0');
}

export function normalizeRecruitmentStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (!APPLICATION_STATUSES.includes(status)) throw new Error('Application status tidak dikenal.');
  return status;
}

export function escapeRecruitmentHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function buildRecruitmentTranscriptHtml(application, messages = []) {
  const applicationId = application.applicationId || application.application_id;
  const applicantTag = application.applicantTag || application.applicant_tag;
  const profileSnapshot = application.profileSnapshot || application.profile_snapshot || {};
  const rows = messages.map(message => {
    const author = escapeRecruitmentHtml(message.author?.tag || message.author?.username || 'Unknown');
    const timestamp = escapeRecruitmentHtml(message.createdAt ? new Date(message.createdAt).toISOString() : '');
    const content = escapeRecruitmentHtml(message.content || '').replace(/\r?\n/g, '<br>');
    const files = Array.from(message.attachments?.values?.() || []).map(file =>
      '<li><a href="' + escapeRecruitmentHtml(file.url) + '">' +
      escapeRecruitmentHtml(file.name || 'attachment') + '</a></li>').join('');
    const embeds = (message.embeds || []).map(embed => {
      const title = escapeRecruitmentHtml(embed.title || '');
      const description = escapeRecruitmentHtml(embed.description || '').replace(/\r?\n/g, '<br>');
      return '<div class="embed"><strong>' + title + '</strong><p>' + description + '</p></div>';
    }).join('');
    return '<article><header><strong>' + author + '</strong><time>' + timestamp +
      '</time></header><p>' + content + '</p>' + (files ? '<ul>' + files + '</ul>' : '') + embeds + '</article>';
  }).join('\n');
  return '<!doctype html><html><head><meta charset="utf-8"><title>' +
    escapeRecruitmentHtml(applicationId) +
    '</title><style>body{font:14px Arial,sans-serif;background:#f5f7fa;color:#172033;padding:24px}' +
    'main{max-width:900px;margin:auto;background:white;padding:24px;border-radius:12px}' +
    'article{border-top:1px solid #ddd;padding:14px 0}header{display:flex;gap:12px;justify-content:space-between}' +
    'time{color:#657084;font-size:12px}.embed{border-left:3px solid #1a9ef3;padding:8px 12px;background:#f3f7fb}' +
    '</style></head><body><main><h1>SKAW Group · Recruitment Transcript</h1><p><b>Application:</b> ' +
    escapeRecruitmentHtml(applicationId) + '</p><p><b>Applicant:</b> ' +
    escapeRecruitmentHtml(applicantTag) + '</p><p><b>Profile:</b> ' +
    escapeRecruitmentHtml(profileSnapshot?.name || 'Unknown') + '</p>' +
    rows + '</main></body></html>';
}

function getRawPool(client) {
  const status = client?.db?.getStatus?.();
  const pool = client?.db?.db?.pool;
  if (!pool || status?.isDegraded === true || client?.db?.isDegraded?.() === true) {
    throw new Error('SKAW Recruitment membutuhkan PostgreSQL aktif. Operasi dihentikan agar data aplikasi tidak tersimpan sementara di memory.');
  }
  if (typeof pool.query !== 'function') throw new Error('PostgreSQL pool SKAW Recruitment tidak tersedia.');
  return pool;
}

async function getPool(client) {
  const pool = getRawPool(client);
  let pending = schemaPromises.get(pool);
  if (!pending) {
    pending = ensureRecruitmentSchema(pool);
    schemaPromises.set(pool, pending);
  }
  try {
    await pending;
  } catch (error) {
    schemaPromises.delete(pool);
    throw error;
  }
  return pool;
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return fallback;
}

function mapProfile(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    key: row.profile_key,
    name: row.name,
    type: row.profile_type,
    division: row.division || '',
    emoji: row.emoji || '📄',
    prefix: row.channel_prefix,
    data: parseJson(row.data),
    enabled: Boolean(row.enabled),
    archived: Boolean(row.archived),
    sortOrder: Number(row.sort_order || 0),
    version: Number(row.version || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapApplication(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    applicationId: row.application_id,
    sequenceNumber: Number(row.sequence_number),
    profileId: String(row.profile_id),
    profileSnapshot: parseJson(row.profile_snapshot),
    applicantId: String(row.applicant_id),
    applicantTag: row.applicant_tag,
    channelId: row.channel_id ? String(row.channel_id) : null,
    channelName: row.channel_name,
    applicationStatus: row.application_status,
    ticketStatus: row.ticket_status,
    claimedBy: row.claimed_by ? String(row.claimed_by) : null,
    priority: row.priority || 'normal',
    submittedAt: row.submitted_at,
    closedAt: row.closed_at,
    archivedAt: row.archived_at,
    transcriptHtml: row.transcript_html || null,
    data: parseJson(row.data),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
  };
}

async function ensureSettings(pool, guildId) {
  await pool.query(
    'INSERT INTO skaw_recruitment_settings (guild_id, data) VALUES ($1, $2::jsonb) ON CONFLICT (guild_id) DO NOTHING',
    [String(guildId), JSON.stringify(DEFAULT_SETTINGS)],
  );
  const result = await pool.query(
    'SELECT guild_id, data, version, updated_at FROM skaw_recruitment_settings WHERE guild_id = $1',
    [String(guildId)],
  );
  const row = result.rows[0];
  return {
    ...DEFAULT_SETTINGS,
    ...parseJson(row?.data),
    ticketSettings: { ...DEFAULT_SETTINGS.ticketSettings, ...parseJson(row?.data).ticketSettings },
    version: Number(row?.version || 1),
    updatedAt: row?.updated_at || null,
  };
}

async function seedStarterProfiles(pool, guildId) {
  const settings = await ensureSettings(pool, guildId);
  if (settings.starterProfilesSeeded) return;
  const starters = [
    { key: 'mechanic', name: 'Mechanic', type: 'employment', division: 'Automotive Division', emoji: '🔧', prefix: 'mechanic' },
    { key: 'trucker', name: 'Trucker', type: 'employment', division: 'Logistics Division', emoji: '🚚', prefix: 'trucker' },
    { key: 'builder', name: 'Builder', type: 'employment', division: 'Construction Division', emoji: '🏗️', prefix: 'builder' },
    { key: 'modshoper', name: 'Modshoper', type: 'employment', division: 'Modification Division', emoji: '🛠️', prefix: 'modshoper' },
    { key: 'partnership', name: 'Partnership', type: 'partnership', division: 'Business Partnership', emoji: '🤝', prefix: 'partnership' },
  ];
  const count = await pool.query(
    'SELECT COUNT(*)::int AS count FROM skaw_recruitment_profiles WHERE guild_id = $1',
    [String(guildId)],
  );
  if (Number(count.rows[0]?.count || 0) === 0) {
    for (const item of starters) {
      await pool.query(
        'INSERT INTO skaw_recruitment_profiles (guild_id, profile_key, name, profile_type, division, emoji, channel_prefix, data, enabled, archived, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,FALSE,FALSE,$9) ON CONFLICT (guild_id, profile_key) DO NOTHING',
        [String(guildId), item.key, item.name, item.type, item.division, item.emoji, item.prefix,
          JSON.stringify({ description: '', criteria: '', requirements: '', terms: '', benefits: '',
            formTemplate: 'Nama Discord:\nNama karakter IC:\nJawaban sesuai persyaratan profil:\nLampiran / bukti pendukung:',
            reviewerRoleIds: [], acceptedRoleId: null, categoryId: null, infoChannelId: null, applyLabel: 'Apply' }), starters.indexOf(item)],
      );
    }
  }
  const next = { ...settings, starterProfilesSeeded: true };
  delete next.version;
  delete next.updatedAt;
  await pool.query(
    'UPDATE skaw_recruitment_settings SET data = $2::jsonb, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE guild_id = $1',
    [String(guildId), JSON.stringify(next)],
  );
  await pool.query(
    'INSERT INTO skaw_recruitment_versions (guild_id, scope, scope_id, version, snapshot, published, actor_id) VALUES ($1,\'settings\',$1,$2,$3::jsonb,FALSE,NULL) ON CONFLICT DO NOTHING',
    [String(guildId), settings.version + 1, JSON.stringify(next)],
  );
}

export async function getRecruitmentSettings(client, guildId) {
  const pool = await getPool(client);
  return ensureSettings(pool, guildId);
}

export async function getRecruitmentProfiles(client, guildId, options = {}) {
  const pool = await getPool(client);
  await seedStarterProfiles(pool, guildId);
  const includeArchived = options.includeArchived !== false;
  const result = await pool.query(
    'SELECT * FROM skaw_recruitment_profiles WHERE guild_id = $1 ' +
    (includeArchived ? '' : 'AND archived = FALSE ') +
    'ORDER BY sort_order ASC, id ASC',
    [String(guildId)],
  );
  return result.rows.map(mapProfile);
}

export async function getRecruitmentProfile(client, guildId, profileKeyOrId) {
  const pool = await getPool(client);
  await seedStarterProfiles(pool, guildId);
  const value = String(profileKeyOrId || '');
  const byId = /^\d+$/.test(value);
  const result = await pool.query(
    'SELECT * FROM skaw_recruitment_profiles WHERE guild_id = $1 AND ' +
    (byId ? 'id = $2' : 'profile_key = $2') + ' LIMIT 1',
    [String(guildId), byId ? Number(value) : value],
  );
  return mapProfile(result.rows[0]);
}

function validateProfile(profile) {
  const name = String(profile.name || '').trim().slice(0, 100);
  const type = String(profile.type || '').trim().toLowerCase();
  const division = String(profile.division || '').trim().slice(0, 100);
  const emoji = String(profile.emoji || '📄').trim().slice(0, 20);
  const prefix = normalizeRecruitmentPrefix(profile.prefix || name);
  if (!name) throw new Error('Nama profil wajib diisi.');
  if (!['employment', 'partnership'].includes(type)) throw new Error('Tipe profil harus employment atau partnership.');
  const acceptedRoleId = String(profile.acceptedRoleId || '').trim();
  if (acceptedRoleId && !/^\d{15,22}$/.test(acceptedRoleId)) throw new Error('Accepted Role ID harus berupa Discord Role ID yang valid.');
  return { name, type, division, emoji, prefix, acceptedRoleId: acceptedRoleId || null };
}

async function saveProfileVersion(pool, guildId, profile, actorId) {
  await pool.query(
    'INSERT INTO skaw_recruitment_versions (guild_id, scope, scope_id, version, snapshot, published, actor_id) VALUES ($1,\'profile\',$2,$3,$4::jsonb,FALSE,$5) ON CONFLICT DO NOTHING',
    [String(guildId), String(profile.id), Number(profile.version), JSON.stringify(profile), actorId ? String(actorId) : null],
  );
}

export async function createRecruitmentProfile(client, guildId, input, actorId) {
  const pool = await getPool(client);
  const valid = validateProfile(input);
  const key = slugifyRecruitmentProfile(input.key || valid.name);
  if (!key) throw new Error('Profile key tidak dapat dibentuk dari nama profil.');
  const data = {
    description: String(input.description || '').trim().slice(0, 1500),
    criteria: String(input.criteria || '').trim().slice(0, 2500),
    requirements: String(input.requirements || '').trim().slice(0, 2500),
    terms: String(input.terms || '').trim().slice(0, 2500),
    benefits: String(input.benefits || '').trim().slice(0, 1500),
    formTemplate: String(input.formTemplate || '').trim().slice(0, 3500),
    reviewerRoleIds: [], acceptedRoleId: valid.acceptedRoleId, categoryId: null, infoChannelId: null,
    applyLabel: String(input.applyLabel || 'Apply').trim().slice(0, 80),
  };
  const result = await pool.query(
    'INSERT INTO skaw_recruitment_profiles (guild_id, profile_key, name, profile_type, division, emoji, channel_prefix, data, enabled, archived, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,FALSE,FALSE,COALESCE((SELECT MAX(sort_order)+1 FROM skaw_recruitment_profiles WHERE guild_id=$1),0)) RETURNING *',
    [String(guildId), key, valid.name, valid.type, valid.division, valid.emoji, valid.prefix, JSON.stringify(data)],
  );
  const profile = mapProfile(result.rows[0]);
  await saveProfileVersion(pool, guildId, profile, actorId);
  await recordRecruitmentEvent(pool, guildId, null, null, 'profile_created', actorId, { profileKey: key, profileName: valid.name });
  return profile;
}

export async function updateRecruitmentProfile(client, guildId, profileId, patch, actorId) {
  const pool = await getPool(client);
  const currentResult = await pool.query(
    'SELECT * FROM skaw_recruitment_profiles WHERE guild_id = $1 AND id = $2',
    [String(guildId), Number(profileId)],
  );
  const current = mapProfile(currentResult.rows[0]);
  if (!current) throw new Error('Profile tidak ditemukan.');
  const valid = validateProfile({
    name: patch.name ?? current.name,
    type: patch.type ?? current.type,
    division: patch.division ?? current.division,
    emoji: patch.emoji ?? current.emoji,
    prefix: patch.prefix ?? current.prefix,
    acceptedRoleId: patch.acceptedRoleId ?? current.data.acceptedRoleId,
  });
  const data = { ...current.data, ...(patch.data || {}) };
  data.acceptedRoleId = valid.acceptedRoleId;
  const nextVersion = current.version + 1;
  const result = await pool.query(
    'UPDATE skaw_recruitment_profiles SET name=$3, profile_type=$4, division=$5, emoji=$6, channel_prefix=$7, data=$8::jsonb, version=$9, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1 AND id=$2 RETURNING *',
    [String(guildId), Number(profileId), valid.name, valid.type, valid.division, valid.emoji, valid.prefix, JSON.stringify(data), nextVersion],
  );
  const profile = mapProfile(result.rows[0]);
  await saveProfileVersion(pool, guildId, profile, actorId);
  await recordRecruitmentEvent(pool, guildId, null, null, 'profile_updated', actorId, { profileKey: profile.key, version: profile.version });
  return profile;
}

export async function setRecruitmentProfileEnabled(client, guildId, profileId, enabled, actorId) {
  const pool = await getPool(client);
  const result = await pool.query(
    'UPDATE skaw_recruitment_profiles SET enabled=$3, archived=FALSE, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1 AND id=$2 RETURNING *',
    [String(guildId), Number(profileId), Boolean(enabled)],
  );
  if (!result.rows[0]) throw new Error('Profile tidak ditemukan.');
  const profile = mapProfile(result.rows[0]);
  await saveProfileVersion(pool, guildId, profile, actorId);
  await recordRecruitmentEvent(pool, guildId, null, null, enabled ? 'profile_enabled' : 'profile_disabled', actorId, { profileKey: profile.key });
  return profile;
}

export async function archiveRecruitmentProfile(client, guildId, profileId, actorId) {
  const pool = await getPool(client);
  const result = await pool.query(
    'UPDATE skaw_recruitment_profiles SET enabled=FALSE, archived=TRUE, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1 AND id=$2 RETURNING *',
    [String(guildId), Number(profileId)],
  );
  if (!result.rows[0]) throw new Error('Profile tidak ditemukan.');
  const profile = mapProfile(result.rows[0]);
  await saveProfileVersion(pool, guildId, profile, actorId);
  await recordRecruitmentEvent(pool, guildId, null, null, 'profile_archived', actorId, { profileKey: profile.key });
  return profile;
}

export async function deleteRecruitmentProfile(client, guildId, profileId, actorId) {
  const pool = await getPool(client);
  const count = await pool.query(
    'SELECT COUNT(*)::int AS count FROM skaw_recruitment_applications WHERE guild_id=$1 AND profile_id=$2',
    [String(guildId), Number(profileId)],
  );
  if (Number(count.rows[0]?.count || 0) > 0) throw new Error('Profile tidak dapat dihapus karena sudah memiliki riwayat aplikasi. Gunakan Archive agar histori tetap utuh.');
  const result = await pool.query(
    'DELETE FROM skaw_recruitment_profiles WHERE guild_id=$1 AND id=$2 RETURNING profile_key',
    [String(guildId), Number(profileId)],
  );
  if (!result.rows[0]) throw new Error('Profile tidak ditemukan.');
  await recordRecruitmentEvent(pool, guildId, null, null, 'profile_deleted', actorId, { profileKey: result.rows[0].profile_key });
}

export async function updateRecruitmentSettings(client, guildId, patch, actorId) {
  const pool = await getPool(client);
  const current = await ensureSettings(pool, guildId);
  const next = { ...current, ...patch, ticketSettings: { ...current.ticketSettings, ...(patch.ticketSettings || {}) } };
  delete next.version;
  delete next.updatedAt;
  const result = await pool.query(
    'UPDATE skaw_recruitment_settings SET data=$2::jsonb, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1 RETURNING version',
    [String(guildId), JSON.stringify(next)],
  );
  const version = Number(result.rows[0]?.version || current.version + 1);
  await pool.query(
    'INSERT INTO skaw_recruitment_versions (guild_id, scope, scope_id, version, snapshot, published, actor_id) VALUES ($1,\'settings\',$1,$2,$3::jsonb,FALSE,$4) ON CONFLICT DO NOTHING',
    [String(guildId), version, JSON.stringify(next), actorId ? String(actorId) : null],
  );
  await recordRecruitmentEvent(pool, guildId, null, null, 'settings_updated', actorId, { version });
  return { ...next, version };
}

async function recordRecruitmentEvent(pool, guildId, applicationRowId, applicationId, action, actorId, metadata = {}, actorTag = null) {
  await pool.query(
    'INSERT INTO skaw_recruitment_events (guild_id, application_row_id, application_id, action, actor_id, actor_tag, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)',
    [String(guildId), applicationRowId ? Number(applicationRowId) : null, applicationId || null, action,
      actorId ? String(actorId) : null, actorTag ? String(actorTag).slice(0, 100) : null, JSON.stringify(metadata || {})],
  );
}

async function getApplicationByPublicId(pool, guildId, applicationId) {
  const result = await pool.query(
    'SELECT * FROM skaw_recruitment_applications WHERE guild_id=$1 AND application_id=$2 LIMIT 1',
    [String(guildId), String(applicationId)],
  );
  return mapApplication(result.rows[0]);
}

export async function getRecruitmentApplication(client, guildId, applicationId) {
  const pool = await getPool(client);
  return getApplicationByPublicId(pool, guildId, applicationId);
}

async function createApplicationRecord(pool, guildId, profile, interaction) {
  const existing = await pool.query(
    'SELECT * FROM skaw_recruitment_applications WHERE guild_id=$1 AND interaction_id=$2 LIMIT 1',
    [String(guildId), String(interaction.id)],
  );
  if (existing.rows[0]) return mapApplication(existing.rows[0]);

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const counter = await dbClient.query(
      "INSERT INTO skaw_recruitment_counters (guild_id, counter_key, current_value) VALUES ($1,'application',1) " +
      'ON CONFLICT (guild_id, counter_key) DO UPDATE SET current_value=skaw_recruitment_counters.current_value+1, updated_at=CURRENT_TIMESTAMP RETURNING current_value',
      [String(guildId)],
    );
    const sequence = Number(counter.rows[0].current_value);
    const applicationId = 'SKAW-REC-' + formatRecruitmentSequence(sequence, 6);
    const channelName = profile.prefix + '-' + formatRecruitmentSequence(sequence, 4);
    const result = await dbClient.query(
      'INSERT INTO skaw_recruitment_applications (guild_id, application_id, sequence_number, interaction_id, profile_id, profile_snapshot, applicant_id, applicant_tag, channel_name, application_status, ticket_status, data) ' +
      'VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,\'awaiting_submission\',\'creating\',$10::jsonb) RETURNING *',
      [String(guildId), applicationId, sequence, String(interaction.id), Number(profile.id),
        JSON.stringify(profile), String(interaction.user.id), String(interaction.user.tag || interaction.user.username),
        channelName, JSON.stringify({ source: 'recruitment_panel' })],
    );
    await dbClient.query(
      'INSERT INTO skaw_recruitment_events (guild_id, application_row_id, application_id, action, actor_id, actor_tag, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [String(guildId), result.rows[0].id, applicationId, 'application_created', String(interaction.user.id),
        String(interaction.user.tag || interaction.user.username), JSON.stringify({ profileKey: profile.key, sequence })],
    );
    await dbClient.query('COMMIT');
    return mapApplication(result.rows[0]);
  } catch (error) {
    await dbClient.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') {
      const duplicate = await getApplicationByPublicId(pool, guildId, String(error.detail || '').match(/application_id[^)]*/)?.[0] || '');
      if (duplicate) return duplicate;
      const byInteraction = await pool.query(
        'SELECT * FROM skaw_recruitment_applications WHERE guild_id=$1 AND interaction_id=$2 LIMIT 1',
        [String(guildId), String(interaction.id)],
      );
      if (byInteraction.rows[0]) return mapApplication(byInteraction.rows[0]);
    }
    throw error;
  } finally {
    dbClient.release();
  }
}

function isTextChannel(channel) {
  return Boolean(channel?.isTextBased?.() && !channel.isDMBased?.() && channel.messages);
}

function ticketPermissionOverwrites(guild, client, applicantId, reviewerRoleIds) {
  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: String(applicantId), allow: [
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
    ] },
  ];
  const botId = client.user?.id;
  if (botId) overwrites.push({ id: botId, allow: [
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages,
  ] });
  for (const roleId of reviewerRoleIds) {
    if (!guild.roles.cache.has(String(roleId))) throw new Error('Reviewer role ' + roleId + ' tidak ditemukan. Perbarui konfigurasi profile sebelum menerima aplikasi.');
    overwrites.push({ id: String(roleId), allow: [
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages,
    ] });
  }
  return overwrites;
}

function ticketEmbed(application) {
  const profile = application.profileSnapshot || {};
  const data = profile.data || {};
  const description = [
    'Terima kasih telah mengajukan diri melalui Recruitment SKAW Group.',
    '',
    '**Application ID:** ' + application.applicationId,
    '**Profile:** ' + (profile.emoji || '📄') + ' ' + (profile.name || 'Unknown'),
    '**Applicant:** <@' + application.applicantId + '>',
    '**Application Status:** Awaiting Submission',
    '',
    '**Petunjuk Pengajuan**',
    'Silakan kirim jawaban secara manual pada channel ini mengikuti template di bawah. Lampirkan screenshot atau bukti pendukung yang diminta oleh profil.',
    '',
    '**Form Template**',
    String(data.formTemplate || 'Nama Discord:\nNama karakter IC:\nJawaban:\nLampiran / bukti pendukung:'),
    '',
    data.requirements ? '**Requirements**\n' + data.requirements : '',
    data.terms ? '\n**Terms & Conditions**\n' + data.terms : '',
    '',
    'Setelah seluruh jawaban dan lampiran dikirim, tekan **Submit for Review** agar tim reviewer menerima notifikasi.',
  ].filter(Boolean).join('\n');
  const embed = new EmbedBuilder().setColor(BLUE).setTitle('SKAW Group · Recruitment Application')
    .setDescription(description.slice(0, 4000))
    .setFooter({ text: application.applicationId + ' · RIGHT SOLUTION, GREAT QUALITY' });
  return embed;
}

function ticketControlRow(application) {
  const id = application.applicationId;
  const buttons = [];
  if (application.ticketStatus === 'closed') {
    buttons.push(new ButtonBuilder().setCustomId('skaw_rec_app|' + id + '|reopen').setLabel('Reopen').setStyle(ButtonStyle.Success));
  } else if (application.ticketStatus === 'open' || application.ticketStatus === 'creating') {
    buttons.push(new ButtonBuilder().setCustomId('skaw_rec_app|' + id + '|submit').setLabel('Submit for Review').setStyle(ButtonStyle.Primary));
    buttons.push(new ButtonBuilder().setCustomId('skaw_rec_app|' + id + '|claim').setLabel('Claim / Unclaim').setStyle(ButtonStyle.Secondary));
    buttons.push(new ButtonBuilder().setCustomId('skaw_rec_app|' + id + '|close').setLabel('Close').setStyle(ButtonStyle.Secondary));
  }
  if (application.ticketStatus !== 'archived') {
    buttons.push(new ButtonBuilder().setCustomId('skaw_rec_app|' + id + '|archive').setLabel('Archive').setStyle(ButtonStyle.Danger));
  }
  return new ActionRowBuilder().addComponents(buttons.slice(0, 5));
}

export async function createRecruitmentApplication(client, guild, profileKey, interaction) {
  const pool = await getPool(client);
  const profile = await getRecruitmentProfile(client, guild.id, profileKey);
  if (!profile || !profile.enabled || profile.archived) throw new Error('Profil ini sedang tidak menerima aplikasi.');
  const reviewerRoleIds = Array.isArray(profile.data.reviewerRoleIds) ? profile.data.reviewerRoleIds.map(String) : [];
  const categoryId = profile.data.categoryId ? String(profile.data.categoryId) : null;
  if (categoryId) {
    const category = guild.channels.cache.get(categoryId) || await guild.channels.fetch(categoryId).catch(() => null);
    if (!category || category.type !== ChannelType.GuildCategory) throw new Error('Ticket category profil tidak ditemukan atau bukan category channel.');
  }
  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!botMember?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error('Bot membutuhkan permission Manage Channels untuk membuat private recruitment ticket.');
  }
  const application = await createApplicationRecord(pool, guild.id, profile, interaction);
  if (application.channelId) {
    const existingChannel = guild.channels.cache.get(application.channelId) || await guild.channels.fetch(application.channelId).catch(() => null);
    return { application, channel: existingChannel, duplicate: true, warning: null };
  }

  let channel = null;
  try {
    channel = await guild.channels.create({
      name: application.channelName,
      type: ChannelType.GuildText,
      topic: 'SKAW Recruitment ' + application.applicationId + ' | Applicant: ' + application.applicantId + ' | Profile: ' + profile.key,
      ...(categoryId ? { parent: categoryId } : {}),
      permissionOverwrites: ticketPermissionOverwrites(guild, client, application.applicantId, reviewerRoleIds),
      reason: 'SKAW Recruitment application ' + application.applicationId,
    });
    await pool.query(
      'UPDATE skaw_recruitment_applications SET channel_id=$3, ticket_status=\'open\', updated_at=CURRENT_TIMESTAMP, last_activity_at=CURRENT_TIMESTAMP WHERE guild_id=$1 AND application_id=$2',
      [String(guild.id), application.applicationId, String(channel.id)],
    );
    const storedApplication = { ...application, channelId: channel.id, ticketStatus: 'open' };
    let warning = null;
    try {
      await channel.send({
        embeds: [ticketEmbed(storedApplication)],
        components: [ticketControlRow(storedApplication)],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      warning = 'Ticket channel berhasil dibuat, tetapi pesan formulir awal gagal dikirim: ' + String(error.message || error);
      logger.error('Recruitment ticket initial message failed', { applicationId: application.applicationId, error });
      await recordRecruitmentEvent(pool, guild.id, application.id, application.applicationId, 'ticket_initial_message_failed', client.user?.id, { message: String(error.message || error) });
    }
    await recordRecruitmentEvent(pool, guild.id, application.id, application.applicationId, 'ticket_created', interaction.user.id, { channelId: channel.id, channelName: channel.name }, interaction.user.tag);
    const logChannelId = (await ensureSettings(pool, guild.id)).logChannelId;
    if (logChannelId) {
      const logChannel = guild.channels.cache.get(String(logChannelId));
      if (isTextChannel(logChannel)) {
        await logChannel.send({
          content: '📨 Recruitment application created: **' + application.applicationId + '** · <@' + application.applicantId + '> · ' + profile.name + ' · ' + channel.toString(),
          allowedMentions: { users: [application.applicantId] },
        }).catch(() => {});
      }
    }
    return { application: storedApplication, channel, duplicate: false, warning };
  } catch (error) {
    const current = await getApplicationByPublicId(pool, guild.id, application.applicationId);
    if (!current?.channelId) {
      await pool.query(
        'UPDATE skaw_recruitment_applications SET ticket_status=$3, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1 AND application_id=$2',
        [String(guild.id), application.applicationId, channel ? 'creating' : 'creation_failed'],
      ).catch(() => {});
      await recordRecruitmentEvent(pool, guild.id, application.id, application.applicationId, 'ticket_creation_failed', interaction.user.id, { message: String(error.message || error) }).catch(() => {});
    }
    throw error;
  }
}

async function fetchReviewerMember(interaction) {
  if (interaction.member?.roles?.cache) return interaction.member;
  return interaction.guild.members.fetch(interaction.user.id).catch(() => null);
}

async function canReviewApplication(interaction, application) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  const profile = application.profileSnapshot || {};
  const roleIds = Array.isArray(profile.data?.reviewerRoleIds) ? profile.data.reviewerRoleIds.map(String) : [];
  if (!roleIds.length) return false;
  const member = await fetchReviewerMember(interaction);
  return Boolean(member?.roles?.cache && roleIds.some(id => member.roles.cache.has(id)));
}

async function updateTicketApplicantPermission(guild, application, closed) {
  const channel = guild.channels.cache.get(String(application.channelId)) ||
    await guild.channels.fetch(String(application.channelId)).catch(() => null);
  if (!channel) throw new Error('Ticket channel tidak ditemukan.');
  await channel.permissionOverwrites.edit(application.applicantId, {
    ViewChannel: true,
    SendMessages: !closed,
    AttachFiles: !closed,
    EmbedLinks: !closed,
  });
  return channel;
}

async function setTicketStatus(client, guild, application, status, actorId) {
  const pool = await getPool(client);
  if (!['open', 'closed', 'archived'].includes(status)) throw new Error('Ticket status tidak valid.');
  const result = await pool.query(
    'UPDATE skaw_recruitment_applications SET ticket_status=$3, closed_at=$4, archived_at=$5, updated_at=CURRENT_TIMESTAMP, last_activity_at=CURRENT_TIMESTAMP WHERE guild_id=$1 AND application_id=$2 RETURNING *',
    [String(guild.id), application.applicationId, status,
      status === 'closed' ? new Date() : null, status === 'archived' ? new Date() : null],
  );
  if (!result.rows[0]) throw new Error('Application tidak ditemukan.');
  const updated = mapApplication(result.rows[0]);
  const channel = await updateTicketApplicantPermission(guild, updated, status !== 'open');
  if (channel?.name) {
    const currentName = String(channel.name);
    let nextName = currentName;
    if (status === 'open') nextName = currentName.replace(/^closed-/, '');
    else if (status === 'closed' || status === 'archived') {
      nextName = currentName.startsWith('closed-') ? currentName : 'closed-' + currentName;
    }
    nextName = nextName.slice(0, 100);
    if (nextName !== currentName) {
      await channel.setName(nextName, 'SKAW Recruitment ' + status + ': ' + updated.applicationId);
      await pool.query(
        'UPDATE skaw_recruitment_applications SET channel_name=$3, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1 AND application_id=$2',
        [String(guild.id), updated.applicationId, nextName],
      );
      updated.channelName = nextName;
    }
  }
  await recordRecruitmentEvent(pool, guild.id, updated.id, updated.applicationId, 'ticket_' + status, actorId, { channelId: updated.channelId, channelName: updated.channelName });
  return updated;
}

async function updateApplicationStatus(client, guild, application, status, actor, reason = '') {
  const pool = await getPool(client);
  const normalized = normalizeRecruitmentStatus(status);
  const result = await pool.query(
    'UPDATE skaw_recruitment_applications SET application_status=$3, submitted_at=CASE WHEN $3=\'submitted\' THEN COALESCE(submitted_at,CURRENT_TIMESTAMP) ELSE submitted_at END, updated_at=CURRENT_TIMESTAMP, last_activity_at=CURRENT_TIMESTAMP WHERE guild_id=$1 AND application_id=$2 RETURNING *',
    [String(guild.id), application.applicationId, normalized],
  );
  if (!result.rows[0]) throw new Error('Application tidak ditemukan.');
  const updated = mapApplication(result.rows[0]);
  await recordRecruitmentEvent(pool, guild.id, updated.id, updated.applicationId, 'application_status_changed', actor.id, {
    from: application.applicationStatus, to: normalized, reason: String(reason || '').slice(0, 1000),
  }, actor.tag);
  const channel = updated.channelId ? guild.channels.cache.get(updated.channelId) : null;
  if (isTextChannel(channel)) {
    await channel.send({
      content: '📌 Status aplikasi **' + updated.applicationId + '** diperbarui menjadi **' + STATUS_LABELS[normalized] + '**.',
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }
  if (normalized === 'accepted' && updated.profileSnapshot?.data?.acceptedRoleId) {
    const roleId = String(updated.profileSnapshot.data.acceptedRoleId);
    const member = await guild.members.fetch(updated.applicantId).catch(() => null);
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (member && role) {
      await member.roles.add(role, 'SKAW Recruitment accepted: ' + updated.applicationId).catch(async error => {
        await recordRecruitmentEvent(pool, guild.id, updated.id, updated.applicationId, 'accepted_role_assignment_failed', actor.id, { roleId, message: String(error.message || error) });
      });
    } else {
      await recordRecruitmentEvent(pool, guild.id, updated.id, updated.applicationId, 'accepted_role_assignment_failed', actor.id, { roleId, reason: 'Member or role not found' });
    }
  }
  return updated;
}

async function claimApplication(client, guild, application, actor) {
  const pool = await getPool(client);
  const result = await pool.query(
    'UPDATE skaw_recruitment_applications SET claimed_by=CASE WHEN claimed_by=$3 THEN NULL ELSE $3 END, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1 AND application_id=$2 AND (claimed_by IS NULL OR claimed_by=$3) RETURNING *',
    [String(guild.id), application.applicationId, String(actor.id)],
  );
  if (!result.rows[0]) throw new Error('Aplikasi ini sudah di-claim oleh reviewer lain.');
  const updated = mapApplication(result.rows[0]);
  await recordRecruitmentEvent(pool, guild.id, updated.id, updated.applicationId, updated.claimedBy ? 'application_claimed' : 'application_unclaimed', actor.id, {}, actor.tag);
  return updated;
}

async function addInternalNote(client, guild, application, actor, note) {
  const pool = await getPool(client);
  const normalized = String(note || '').trim();
  if (!normalized) throw new Error('Internal note tidak boleh kosong.');
  if (normalized.length > 1500) throw new Error('Internal note maksimal 1.500 karakter.');
  await recordRecruitmentEvent(pool, guild.id, application.id, application.applicationId, 'internal_note', actor.id, { note: normalized }, actor.tag);
}

async function getApplicationNotes(pool, guildId, applicationId) {
  const result = await pool.query(
    "SELECT actor_id, actor_tag, metadata, created_at FROM skaw_recruitment_events WHERE guild_id=$1 AND application_id=$2 AND action='internal_note' ORDER BY created_at DESC LIMIT 10",
    [String(guildId), String(applicationId)],
  );
  return result.rows.map(row => ({
    actorId: row.actor_id, actorTag: row.actor_tag, note: parseJson(row.metadata).note || '',
    createdAt: row.created_at,
  }));
}

async function archiveTicket(client, guild, application, actor) {
  const pool = await getPool(client);
  const channel = guild.channels.cache.get(String(application.channelId)) ||
    await guild.channels.fetch(String(application.channelId)).catch(() => null);
  if (!isTextChannel(channel)) throw new Error('Ticket channel tidak ditemukan; archive tidak dapat dibuat.');
  const fetched = await channel.messages.fetch({ limit: 100 });
  const messages = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const html = buildRecruitmentTranscriptHtml(application, messages);
  await pool.query(
    'UPDATE skaw_recruitment_applications SET transcript_html=$3, ticket_status=\'archived\', archived_at=CURRENT_TIMESTAMP, closed_at=COALESCE(closed_at,CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP, last_activity_at=CURRENT_TIMESTAMP WHERE guild_id=$1 AND application_id=$2',
    [String(guild.id), application.applicationId, html],
  );
  await channel.permissionOverwrites.edit(application.applicantId, {
    ViewChannel: false, SendMessages: false, AttachFiles: false, EmbedLinks: false,
  });
  if (!channel.name.startsWith('closed-')) {
    const archivedName = ('closed-' + channel.name).slice(0, 100);
    await channel.setName(archivedName, 'SKAW Recruitment archived: ' + application.applicationId);
    await pool.query(
      'UPDATE skaw_recruitment_applications SET channel_name=$3 WHERE guild_id=$1 AND application_id=$2',
      [String(guild.id), application.applicationId, archivedName],
    );
  }
  const settings = await ensureSettings(pool, guild.id);
  let transcriptSent = false;
  if (settings.transcriptChannelId) {
    const transcriptChannel = guild.channels.cache.get(String(settings.transcriptChannelId)) ||
      await guild.channels.fetch(String(settings.transcriptChannelId)).catch(() => null);
    if (isTextChannel(transcriptChannel)) {
      const fileName = application.applicationId.toLowerCase() + '-transcript.html';
      await transcriptChannel.send({
        content: '🗂️ Transcript Recruitment · **' + application.applicationId + '** · Applicant <@' + application.applicantId + '>',
        files: [new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: fileName })],
        allowedMentions: { users: [application.applicantId] },
      });
      transcriptSent = true;
    }
  }
  await recordRecruitmentEvent(pool, guild.id, application.id, application.applicationId, 'ticket_archived', actor.id, { transcriptStored: true, transcriptSent });
  return { transcriptSent, channel };
}

async function listApplications(pool, guildId, limit = 20) {
  const safeLimit = Math.max(1, Math.min(25, Number(limit) || 20));
  const result = await pool.query(
    'SELECT * FROM skaw_recruitment_applications WHERE guild_id=$1 ORDER BY created_at DESC LIMIT $2',
    [String(guildId), safeLimit],
  );
  return result.rows.map(mapApplication);
}

async function getRecruitmentEvents(pool, guildId, limit = 15) {
  const result = await pool.query(
    'SELECT application_id, action, actor_id, actor_tag, metadata, created_at FROM skaw_recruitment_events WHERE guild_id=$1 ORDER BY created_at DESC LIMIT $2',
    [String(guildId), Math.max(1, Math.min(25, Number(limit) || 15))],
  );
  return result.rows;
}

async function getRecruitmentStats(pool, guildId) {
  const result = await pool.query(
    'SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE ticket_status IN (\'open\',\'creating\',\'creation_failed\'))::int AS active_tickets, COUNT(*) FILTER (WHERE application_status=\'submitted\')::int AS submitted, COUNT(*) FILTER (WHERE application_status=\'under_review\')::int AS under_review, COUNT(*) FILTER (WHERE application_status=\'accepted\')::int AS accepted, COUNT(*) FILTER (WHERE application_status=\'rejected\')::int AS rejected FROM skaw_recruitment_applications WHERE guild_id=$1',
    [String(guildId)],
  );
  return result.rows[0] || { total: 0, active_tickets: 0, submitted: 0, under_review: 0, accepted: 0, rejected: 0 };
}

function buildColor(value) {
  const raw = String(value || '#1A9EF3').replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(raw) ? Number.parseInt(raw, 16) : BLUE;
}

function createDashId(ownerId, action, value = '') {
  return 'skaw_rec_dash|' + String(ownerId) + '|' + action + (value ? '|' + String(value) : '');
}

function dashButton(ownerId, action, label, style = ButtonStyle.Secondary, value = '') {
  return new ButtonBuilder().setCustomId(createDashId(ownerId, action, value)).setLabel(label).setStyle(style);
}

function buildNavigation(ownerId, active) {
  const items = [
    ['overview', 'Overview'], ['profiles', 'Profiles'], ['apps', 'Applications'],
    ['content', 'Panel Content'], ['logs', 'Logs'],
  ];
  return new ActionRowBuilder().addComponents(items.map(([key, label]) =>
    dashButton(ownerId, 'page_' + key, label, active === key ? ButtonStyle.Primary : ButtonStyle.Secondary)));
}

function input(customId, label, style, value = '', required = false, maxLength = 1000) {
  const builder = new TextInputBuilder().setCustomId(customId).setLabel(label)
    .setStyle(style).setRequired(required).setMaxLength(maxLength);
  if (value) builder.setValue(String(value).slice(0, maxLength));
  return new ActionRowBuilder().addComponents(builder);
}

function buildProfileModal(ownerId, profile = null) {
  const isNew = !profile;
  const customId = createDashId(ownerId, 'modal_profile', isNew ? 'new' : profile.id);
  return new ModalBuilder().setCustomId(customId).setTitle(isNew ? 'Create Recruitment Profile' : 'Edit Recruitment Profile')
    .addComponents(
      input('profile_name', 'Profile Name', TextInputStyle.Short, profile?.name || '', true, 100),
      input('profile_type', 'Type: employment / partnership', TextInputStyle.Short, profile?.type || 'employment', true, 20),
      input('profile_division', 'Division', TextInputStyle.Short, profile?.division || '', false, 100),
      input('profile_prefix', 'Ticket Channel Prefix', TextInputStyle.Short, profile?.prefix || '', true, 40),
      input('accepted_role_id', 'Accepted Role ID (optional)', TextInputStyle.Short, profile?.data?.acceptedRoleId || '', false, 22),
    );
}

function buildProfileDetailsModal(ownerId, profile) {
  return new ModalBuilder().setCustomId(createDashId(ownerId, 'modal_details', profile.id)).setTitle('Profile Information')
    .addComponents(
      input('profile_description', 'Description', TextInputStyle.Paragraph, profile.data.description || '', false, 1500),
      input('profile_criteria', 'Criteria', TextInputStyle.Paragraph, profile.data.criteria || '', false, 2500),
      input('profile_requirements', 'Requirements', TextInputStyle.Paragraph, profile.data.requirements || '', false, 2500),
      input('profile_terms', 'Terms & Conditions', TextInputStyle.Paragraph, profile.data.terms || '', false, 2500),
      input('profile_benefits', 'Benefits', TextInputStyle.Paragraph, profile.data.benefits || '', false, 1500),
    );
}

function buildFormModal(ownerId, profile) {
  return new ModalBuilder().setCustomId(createDashId(ownerId, 'modal_form', profile.id)).setTitle('Manual Ticket Form Template')
    .addComponents(input('profile_form', 'Form template shown in private ticket', TextInputStyle.Paragraph,
      profile.data.formTemplate || 'Nama Discord:\nNama karakter IC:\nJawaban:\nLampiran / bukti pendukung:', false, 3500));
}

function buildContentModal(ownerId, settings) {
  return new ModalBuilder().setCustomId(createDashId(ownerId, 'modal_content')).setTitle('Recruitment Panel Content')
    .addComponents(
      input('panel_title', 'Panel Title', TextInputStyle.Short, settings.panelTitle, true, 256),
      input('panel_headline', 'Headline', TextInputStyle.Short, settings.headline, true, 256),
      input('welcome_text', 'Welcome Text', TextInputStyle.Paragraph, settings.welcomeText, true, 1000),
      input('introduction', 'Introduction', TextInputStyle.Paragraph, settings.introduction, true, 1000),
      input('important_info', 'Important Information', TextInputStyle.Paragraph, settings.importantInfo, false, 1000),
    );
}

function buildTermsModal(ownerId, settings) {
  return new ModalBuilder().setCustomId(createDashId(ownerId, 'modal_terms')).setTitle('Instructions & Panel Appearance')
    .addComponents(
      input('panel_instructions', 'Instructions', TextInputStyle.Paragraph, settings.instructions, true, 1000),
      input('general_terms', 'General Terms', TextInputStyle.Paragraph, settings.generalTerms, false, 1000),
      input('panel_footer', 'Footer Text', TextInputStyle.Short, settings.footerText, false, 200),
      input('panel_color', 'Embed Color HEX', TextInputStyle.Short, settings.embedColor, true, 7),
      input('panel_banner', 'Banner HTTPS URL (empty removes)', TextInputStyle.Short, settings.bannerUrl || '', false, 400),
    );
}

function buildNotesModal(ownerId, application) {
  return new ModalBuilder().setCustomId('skaw_rec_note|' + String(ownerId) + '|' + application.applicationId)
    .setTitle('Private Internal Note')
    .addComponents(input('internal_note', 'Note (only stored for reviewers)', TextInputStyle.Paragraph, '', true, 1500));
}

function buildProfileDescription(profile) {
  const data = profile.data || {};
  return [
    (profile.emoji || '📄') + ' **' + profile.name + '**',
    profile.division ? 'Division: ' + profile.division : '',
    'Type: ' + profile.type,
    'Ticket prefix: ' + profile.prefix,
    'Status: ' + (profile.archived ? 'Archived' : profile.enabled ? 'Enabled' : 'Disabled'),
    '',
    data.description || 'Description belum diisi.',
    data.criteria ? '\n**Criteria**\n' + data.criteria : '',
    data.requirements ? '\n**Requirements**\n' + data.requirements : '',
    data.terms ? '\n**Terms**\n' + data.terms : '',
    data.benefits ? '\n**Benefits**\n' + data.benefits : '',
    '',
    'Reviewer roles: ' + ((data.reviewerRoleIds || []).map(id => '<@&' + id + '>').join(', ') || 'Belum diatur'),
    'Ticket category: ' + (data.categoryId ? '<#' + data.categoryId + '>' : 'Belum diatur'),
    'Information channel: ' + (data.infoChannelId ? '<#' + data.infoChannelId + '>' : 'Tidak diatur'),
    'Accepted role: ' + (data.acceptedRoleId ? '<@&' + data.acceptedRoleId + '>' : 'Tidak diatur'),
    'Version: ' + profile.version,
  ].filter(Boolean).join('\n').slice(0, 3900);
}

async function buildDashboardPayload(client, guild, ownerId, page = 'overview', selectedProfileId = null, selectedApplicationId = null, notice = null) {
  const pool = await getPool(client);
  const settings = await ensureSettings(pool, guild.id);
  const profiles = await getRecruitmentProfiles(client, guild.id);
  const enabledProfiles = profiles.filter(profile => profile.enabled && !profile.archived);
  const nav = buildNavigation(ownerId, page);
  const components = [nav];
  let embed;

  if (page === 'overview') {
    const stats = await getRecruitmentStats(pool, guild.id);
    embed = new EmbedBuilder().setColor(BLUE).setTitle('SKAW Recruitment Manager')
      .setDescription('Central management for employment recruitment, business partnership and private application tickets.')
      .addFields(
        { name: 'Total Applications', value: String(stats.total), inline: true },
        { name: 'Active Tickets', value: String(stats.active_tickets), inline: true },
        { name: 'Submitted', value: String(stats.submitted), inline: true },
        { name: 'Under Review', value: String(stats.under_review), inline: true },
        { name: 'Accepted', value: String(stats.accepted), inline: true },
        { name: 'Rejected', value: String(stats.rejected), inline: true },
        { name: 'Enabled Profiles', value: String(enabledProfiles.length) + ' / ' + String(profiles.length), inline: true },
        { name: 'Public Panel', value: settings.panelMessageId ? 'Published · <#' + settings.publicChannelId + '>' : 'Not published', inline: true },
        { name: 'Configuration Version', value: String(settings.version), inline: true },
      )
      .setFooter({ text: 'Applications are unlimited; no per-user cooldown or pending-application lock.' });
    components.push(new ActionRowBuilder().addComponents(
      dashButton(ownerId, 'publish', 'Publish / Update Panel', ButtonStyle.Success),
      dashButton(ownerId, 'page_profiles', 'Manage Profiles'),
      dashButton(ownerId, 'page_apps', 'Review Applications'),
    ));
  } else if (page === 'profiles') {
    embed = new EmbedBuilder().setColor(BLUE).setTitle('Recruitment Profiles')
      .setDescription('Kelola profil pekerjaan dan partnership. Profil starter disediakan dalam keadaan disabled sampai informasi, reviewer dan kategori ticket dikonfigurasi.\n\nEnabled profiles: ' + enabledProfiles.length + '\nTotal profiles: ' + profiles.length);
    const options = profiles.slice(0, 25).map(profile => ({
      label: (profile.emoji + ' ' + profile.name).slice(0, 100),
      description: ((profile.type === 'partnership' ? 'Partnership' : 'Employment') + ' · ' + (profile.enabled ? 'Enabled' : profile.archived ? 'Archived' : 'Disabled')).slice(0, 100),
      value: profile.id,
    }));
    if (options.length) components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(createDashId(ownerId, 'profile_select'))
        .setPlaceholder('Select a profile to manage').addOptions(options)));
    components.push(new ActionRowBuilder().addComponents(
      dashButton(ownerId, 'create_profile', 'Create Profile', ButtonStyle.Success),
      dashButton(ownerId, 'page_overview', 'Back to Overview'),
    ));
  } else if (page === 'profile_detail' && selectedProfileId) {
    const profile = await getRecruitmentProfile(client, guild.id, selectedProfileId);
    if (!profile) throw new Error('Profile tidak ditemukan.');
    embed = new EmbedBuilder().setColor(BLUE).setTitle('Profile Manager · ' + profile.name)
      .setDescription(buildProfileDescription(profile));
    components.push(new ActionRowBuilder().addComponents(
      dashButton(ownerId, 'edit_profile', 'Edit Profile', ButtonStyle.Primary, profile.id),
      dashButton(ownerId, 'edit_details', 'Edit Information', ButtonStyle.Secondary, profile.id),
      dashButton(ownerId, 'edit_form', 'Edit Form Template', ButtonStyle.Secondary, profile.id),
      dashButton(ownerId, 'toggle_profile', profile.enabled ? 'Disable' : 'Enable', profile.enabled ? ButtonStyle.Danger : ButtonStyle.Success, profile.id),
      dashButton(ownerId, 'archive_profile', 'Archive', ButtonStyle.Danger, profile.id),
    ));
    const reviewers = new RoleSelectMenuBuilder().setCustomId(createDashId(ownerId, 'profile_reviewers', profile.id))
      .setPlaceholder('Select profile-specific reviewer roles').setMinValues(0).setMaxValues(25);
    if ((profile.data.reviewerRoleIds || []).length) reviewers.setDefaultRoles(...profile.data.reviewerRoleIds.slice(0, 25));
    components.push(new ActionRowBuilder().addComponents(reviewers));
    const category = new ChannelSelectMenuBuilder().setCustomId(createDashId(ownerId, 'profile_category', profile.id))
      .setPlaceholder('Select private ticket category').setChannelTypes(ChannelType.GuildCategory).setMinValues(1).setMaxValues(1);
    if (profile.data.categoryId) category.setDefaultChannels(String(profile.data.categoryId));
    components.push(new ActionRowBuilder().addComponents(category));
    const info = new ChannelSelectMenuBuilder().setCustomId(createDashId(ownerId, 'profile_info_channel', profile.id))
      .setPlaceholder('Select optional information channel').setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1);
    if (profile.data.infoChannelId) info.setDefaultChannels(String(profile.data.infoChannelId));
    components.push(new ActionRowBuilder().addComponents(info));
  } else if (page === 'apps') {
    const applications = await listApplications(pool, guild.id, 25);
    embed = new EmbedBuilder().setColor(BLUE).setTitle('Application Management')
      .setDescription('Pilih aplikasi untuk melihat detail, mengganti application status, menambahkan internal note, atau mengelola ticket.\n\nShowing latest ' + applications.length + ' application(s).');
    const options = applications.map(application => ({
      label: (application.applicationId + ' · ' + (application.profileSnapshot?.name || 'Profile')).slice(0, 100),
      description: (STATUS_LABELS[application.applicationStatus] || application.applicationStatus) + ' · ' + (TICKET_LABELS[application.ticketStatus] || application.ticketStatus),
      value: application.applicationId,
    }));
    if (options.length) components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(createDashId(ownerId, 'application_select'))
        .setPlaceholder('Select an application').addOptions(options)));
    if (selectedApplicationId) {
      const application = await getApplicationByPublicId(pool, guild.id, selectedApplicationId);
      if (application) {
        embed.addFields(
          { name: 'Selected Application', value: application.applicationId, inline: true },
          { name: 'Applicant', value: '<@' + application.applicantId + '>', inline: true },
          { name: 'Profile', value: application.profileSnapshot?.name || 'Unknown', inline: true },
          { name: 'Application Status', value: STATUS_LABELS[application.applicationStatus] || application.applicationStatus, inline: true },
          { name: 'Ticket Status', value: TICKET_LABELS[application.ticketStatus] || application.ticketStatus, inline: true },
          { name: 'Channel', value: application.channelId ? '<#' + application.channelId + '>' : 'Not linked', inline: true },
          { name: 'Claimed By', value: application.claimedBy ? '<@' + application.claimedBy + '>' : 'Unclaimed', inline: true },
        );
        const statusMenu = new StringSelectMenuBuilder().setCustomId(createDashId(ownerId, 'application_status', application.applicationId))
          .setPlaceholder('Change application status')
          .addOptions(APPLICATION_STATUSES.map(status => ({
            label: STATUS_LABELS[status], value: status, default: status === application.applicationStatus,
          })));
        components.push(new ActionRowBuilder().addComponents(statusMenu));
        components.push(new ActionRowBuilder().addComponents(
          dashButton(ownerId, 'application_note', 'Add Internal Note', ButtonStyle.Secondary, application.applicationId),
          dashButton(ownerId, 'application_close', application.ticketStatus === 'closed' ? 'Already Closed' : 'Close Ticket', ButtonStyle.Secondary, application.applicationId),
          dashButton(ownerId, 'application_reopen', 'Reopen Ticket', ButtonStyle.Success, application.applicationId),
          dashButton(ownerId, 'application_archive', 'Archive Ticket', ButtonStyle.Danger, application.applicationId),
        ));
        const notes = await getApplicationNotes(pool, guild.id, application.applicationId);
        if (notes.length) embed.addFields({ name: 'Recent Internal Notes', value: notes.slice(0, 3).map(note =>
          '**' + escapeRecruitmentHtml(note.actorTag || note.actorId || 'Reviewer') + '**: ' +
          String(note.note || '').slice(0, 250)).join('\n').slice(0, 1000) });
      }
    }
  } else if (page === 'content') {
    embed = new EmbedBuilder().setColor(BLUE).setTitle('Panel Content & Ticket Settings')
      .setDescription('Public panel channel: ' + (settings.publicChannelId ? '<#' + settings.publicChannelId + '>' : 'Not selected') +
        '\nTranscript channel: ' + (settings.transcriptChannelId ? '<#' + settings.transcriptChannelId + '>' : 'Not selected') +
        '\nRecruitment log channel: ' + (settings.logChannelId ? '<#' + settings.logChannelId + '>' : 'Not selected') +
        '\n\n**' + settings.panelTitle + '**\n' + settings.headline + '\n\n' + settings.welcomeText +
        '\n\n**Important Information**\n' + settings.importantInfo +
        '\n\nDraft version: ' + settings.version + '\nPublished panel: ' + (settings.panelMessageId ? 'Yes' : 'No'))
      .setFooter({ text: 'Editing content does not overwrite the snapshot stored in existing applications.' });
    components.push(new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder().setCustomId(createDashId(ownerId, 'public_channel')).setPlaceholder('Select public recruitment panel channel')
        .setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1)));
    components.push(new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder().setCustomId(createDashId(ownerId, 'transcript_channel')).setPlaceholder('Select transcript archive channel')
        .setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1)));
    components.push(new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder().setCustomId(createDashId(ownerId, 'log_channel')).setPlaceholder('Select recruitment log channel')
        .setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1)));
    components.push(new ActionRowBuilder().addComponents(
      dashButton(ownerId, 'edit_content', 'Edit Main Information', ButtonStyle.Primary),
      dashButton(ownerId, 'edit_terms', 'Edit Instructions & Appearance'),
      dashButton(ownerId, 'publish', 'Publish Panel', ButtonStyle.Success),
      dashButton(ownerId, 'restore_published', 'Restore Published Version', ButtonStyle.Secondary),
    ));
  } else if (page === 'logs') {
    const events = await getRecruitmentEvents(pool, guild.id, 15);
    embed = new EmbedBuilder().setColor(BLUE).setTitle('Recruitment Activity Logs')
      .setDescription(events.length ? events.map(event => {
        const when = event.created_at ? new Date(event.created_at).toLocaleString('id-ID') : '';
        return '• **' + event.action + '** · ' + (event.application_id || 'Configuration') +
          ' · ' + (event.actor_tag || event.actor_id || 'System') + ' · ' + when;
      }).join('\n').slice(0, 3900) : 'Belum ada aktivitas Recruitment.');
  } else {
    throw new Error('Dashboard page tidak dikenal.');
  }

  if (notice) embed.addFields({ name: 'Information', value: String(notice).slice(0, 1000) });
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

export async function openRecruitmentDashboard(interaction, client) {
  if (!interaction.inGuild?.() || !interaction.guild) {
    return interaction.reply({ content: 'Recruitment dashboard hanya dapat digunakan di dalam server.', flags: MessageFlags.Ephemeral });
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: 'Akses ditolak. Permission Manage Server diperlukan.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    return interaction.editReply(await buildDashboardPayload(client, interaction.guild, interaction.user.id, 'overview'));
  } catch (error) {
    logger.error('Could not open SKAW Recruitment dashboard', { guildId: interaction.guildId, userId: interaction.user.id, error });
    return interaction.editReply({ content: '❌ Recruitment dashboard gagal dimuat: ' + String(error.message || error).slice(0, 1200), embeds: [], components: [] });
  }
}

async function publishRecruitmentPanel(client, guild, actorId) {
  const pool = await getPool(client);
  const settings = await ensureSettings(pool, guild.id);
  if (!settings.publicChannelId) throw new Error('Pilih public panel channel di tab Panel Content terlebih dahulu.');
  const channel = guild.channels.cache.get(String(settings.publicChannelId)) ||
    await guild.channels.fetch(String(settings.publicChannelId)).catch(() => null);
  if (!isTextChannel(channel)) throw new Error('Public panel channel tidak ditemukan atau bukan text channel.');
  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!channel.permissionsFor(botMember)?.has([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory,
  ])) throw new Error('Bot membutuhkan View Channel, Send Messages, Embed Links dan Read Message History pada public panel channel.');
  const profiles = (await getRecruitmentProfiles(client, guild.id, { includeArchived: false }))
    .filter(profile => profile.enabled && !profile.archived).slice(0, 25);
  if (!profiles.length) throw new Error('Belum ada profile yang enabled. Aktifkan minimal satu profile sebelum publish.');
  const embed = new EmbedBuilder().setColor(buildColor(settings.embedColor))
    .setTitle(settings.panelTitle || DEFAULT_SETTINGS.panelTitle)
    .setDescription([
      settings.headline, '',
      settings.welcomeText, '',
      settings.introduction, '',
      '**Important Information**', settings.importantInfo, '',
      '**How to Apply**', settings.instructions, '',
      settings.generalTerms,
    ].filter(Boolean).join('\n').slice(0, 4000))
    .setFooter({ text: settings.footerText || DEFAULT_SETTINGS.footerText });
  if (settings.bannerUrl && /^https:\/\/\S+$/i.test(settings.bannerUrl)) embed.setImage(settings.bannerUrl);
  const menu = new StringSelectMenuBuilder().setCustomId('skaw_rec_public_profile')
    .setPlaceholder('Select a job position or partnership profile')
    .addOptions(profiles.map(profile => ({
      label: (profile.name || profile.key).slice(0, 100),
      description: ((profile.type === 'partnership' ? 'Business Partnership' : 'Employment') + ' · ' + (profile.division || 'SKAW Group')).slice(0, 100),
      value: profile.key,
      emoji: profile.emoji || '📄',
    })));
  const payload = {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(menu)],
    allowedMentions: { parse: [] },
  };
  let message = null;
  if (settings.panelMessageId) {
    message = await channel.messages.fetch(String(settings.panelMessageId)).catch(() => null);
  }
  if (message) await message.edit(payload);
  else message = await channel.send(payload);
  const newSettings = { ...settings, panelMessageId: message.id, publicChannelId: channel.id };
  delete newSettings.version;
  delete newSettings.updatedAt;
  const updated = await pool.query(
    'UPDATE skaw_recruitment_settings SET data=$2::jsonb, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1 RETURNING version',
    [String(guild.id), JSON.stringify(newSettings)],
  );
  const version = Number(updated.rows[0]?.version || settings.version + 1);
  await pool.query(
    'INSERT INTO skaw_recruitment_versions (guild_id, scope, scope_id, version, snapshot, published, actor_id) VALUES ($1,\'settings\',$1,$2,$3::jsonb,TRUE,$4) ON CONFLICT DO NOTHING',
    [String(guild.id), version, JSON.stringify(newSettings), String(actorId)],
  );
  await recordRecruitmentEvent(pool, guild.id, null, null, 'panel_published', actorId, { channelId: channel.id, messageId: message.id, enabledProfileCount: profiles.length });
  return { channel, message, version };
}

async function restorePublishedSettings(client, guildId, actorId) {
  const pool = await getPool(client);
  const result = await pool.query(
    "SELECT snapshot FROM skaw_recruitment_versions WHERE guild_id=$1 AND scope='settings' AND scope_id=$1 AND published=TRUE ORDER BY version DESC LIMIT 1",
    [String(guildId)],
  );
  if (!result.rows[0]) throw new Error('Belum ada published version yang dapat dipulihkan.');
  const snapshot = parseJson(result.rows[0].snapshot);
  delete snapshot.version;
  delete snapshot.updatedAt;
  await pool.query(
    'UPDATE skaw_recruitment_settings SET data=$2::jsonb, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1',
    [String(guildId), JSON.stringify(snapshot)],
  );
  await recordRecruitmentEvent(pool, guildId, null, null, 'settings_restored_to_published', actorId, {});
}

async function refreshDashboard(interaction, client, page, profileId = null, applicationId = null, notice = null) {
  const payload = await buildDashboardPayload(client, interaction.guild, interaction.user.id, page, profileId, applicationId, notice);
  return interaction.editReply(payload);
}

async function handleDashboardInteraction(interaction, client) {
  const parts = String(interaction.customId || '').split('|');
  const ownerId = parts[1];
  const action = parts[2];
  const value = parts[3] || '';
  if (!ownerId || ownerId !== String(interaction.user.id)) {
    return interaction.reply({ content: 'Dashboard ini hanya dapat digunakan oleh administrator yang membukanya.', flags: MessageFlags.Ephemeral });
  }
  if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: 'Akses dashboard ditolak. Permission Manage Server diperlukan.', flags: MessageFlags.Ephemeral });
  }

  if (action === 'create_profile') return interaction.showModal(buildProfileModal(ownerId));
  if (action === 'edit_content') return interaction.showModal(buildContentModal(ownerId, await getRecruitmentSettings(client, interaction.guildId)));
  if (action === 'edit_terms') return interaction.showModal(buildTermsModal(ownerId, await getRecruitmentSettings(client, interaction.guildId)));
  if (action === 'application_note') {
    const application = await getRecruitmentApplication(client, interaction.guildId, value);
    if (!application || !await canReviewApplication(interaction, application)) {
      return interaction.reply({ content: 'Akses reviewer ditolak.', flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(buildNotesModal(interaction.user.id, application));
  }

  if (action === 'edit_profile' || action === 'edit_details' || action === 'edit_form') {
    const profile = await getRecruitmentProfile(client, interaction.guildId, value);
    if (!profile) throw new Error('Profile tidak ditemukan.');
    if (action === 'edit_profile') return interaction.showModal(buildProfileModal(ownerId, profile));
    if (action === 'edit_details') return interaction.showModal(buildProfileDetailsModal(ownerId, profile));
    return interaction.showModal(buildFormModal(ownerId, profile));
  }

  await interaction.deferUpdate();
  if (action.startsWith('page_')) {
    return refreshDashboard(interaction, client, action.slice(5));
  }
  if (action === 'profile_select') {
    return refreshDashboard(interaction, client, 'profile_detail', interaction.values[0]);
  }
  if (action === 'application_select') {
    return refreshDashboard(interaction, client, 'apps', null, interaction.values[0]);
  }
  if (action === 'toggle_profile') {
    const profile = await getRecruitmentProfile(client, interaction.guildId, value);
    await setRecruitmentProfileEnabled(client, interaction.guildId, value, !profile.enabled, interaction.user.id);
    return refreshDashboard(interaction, client, 'profile_detail', value, null, 'Profile status updated.');
  }
  if (action === 'archive_profile') {
    await archiveRecruitmentProfile(client, interaction.guildId, value, interaction.user.id);
    return refreshDashboard(interaction, client, 'profiles', null, null, 'Profile archived. Existing applications and snapshots are preserved.');
  }
  if (action === 'delete_profile') {
    await deleteRecruitmentProfile(client, interaction.guildId, value, interaction.user.id);
    return refreshDashboard(interaction, client, 'profiles', null, null, 'Profile deleted because no application history existed.');
  }
  if (action === 'profile_reviewers') {
    const profile = await getRecruitmentProfile(client, interaction.guildId, value);
    await updateRecruitmentProfile(client, interaction.guildId, value, {
      data: { reviewerRoleIds: [...new Set(interaction.values.map(String))] },
    }, interaction.user.id);
    return refreshDashboard(interaction, client, 'profile_detail', value, null, 'Profile-specific reviewer roles updated.');
  }
  if (action === 'profile_category' || action === 'profile_info_channel') {
    const profile = await getRecruitmentProfile(client, interaction.guildId, value);
    const selectedId = String(interaction.values[0]);
    await updateRecruitmentProfile(client, interaction.guildId, value, {
      data: { [action === 'profile_category' ? 'categoryId' : 'infoChannelId']: selectedId },
    }, interaction.user.id);
    return refreshDashboard(interaction, client, 'profile_detail', value, null,
      action === 'profile_category' ? 'Private ticket category updated.' : 'Information channel updated.');
  }
  if (action === 'public_channel' || action === 'transcript_channel' || action === 'log_channel') {
    const field = action === 'public_channel' ? 'publicChannelId' :
      action === 'transcript_channel' ? 'transcriptChannelId' : 'logChannelId';
    await updateRecruitmentSettings(client, interaction.guildId, { [field]: String(interaction.values[0]) }, interaction.user.id);
    return refreshDashboard(interaction, client, 'content', null, null, 'Channel setting updated.');
  }
  if (action === 'publish') {
    const result = await publishRecruitmentPanel(client, interaction.guild, interaction.user.id);
    return refreshDashboard(interaction, client, 'overview', null, null, 'Panel published or updated in ' + result.channel.toString() + '. Version ' + result.version + '.');
  }
  if (action === 'restore_published') {
    await restorePublishedSettings(client, interaction.guildId, interaction.user.id);
    return refreshDashboard(interaction, client, 'content', null, null, 'Draft settings restored from the latest published snapshot. Publish again to apply.');
  }
  if (action === 'application_status') {
    const pool = await getPool(client);
    const application = await getApplicationByPublicId(pool, interaction.guildId, value);
    if (!application) throw new Error('Application tidak ditemukan.');
    if (!await canReviewApplication(interaction, application)) throw new Error('Kamu tidak memiliki akses reviewer untuk profil aplikasi ini.');
    await updateApplicationStatus(client, interaction.guild, application, interaction.values[0], interaction.user);
    return refreshDashboard(interaction, client, 'apps', null, value, 'Application status updated.');
  }
  if (action === 'application_close' || action === 'application_reopen' || action === 'application_archive') {
    const application = await getRecruitmentApplication(client, interaction.guildId, value);
    if (!application || !await canReviewApplication(interaction, application)) throw new Error('Akses reviewer ditolak.');
    if (action === 'application_close') await setTicketStatus(client, interaction.guild, application, 'closed', interaction.user.id);
    if (action === 'application_reopen') await setTicketStatus(client, interaction.guild, application, 'open', interaction.user.id);
    if (action === 'application_archive') await archiveTicket(client, interaction.guild, application, interaction.user);
    return refreshDashboard(interaction, client, 'apps', null, value, 'Ticket action completed.');
  }
}

async function handleDashboardModal(interaction, client) {
  const parts = String(interaction.customId || '').split('|');
  const ownerId = parts[1];
  const action = parts[2];
  const value = parts[3] || '';
  if (ownerId !== String(interaction.user.id)) {
    return interaction.reply({ content: 'Modal ini bukan milik sesi dashboard kamu.', flags: MessageFlags.Ephemeral });
  }
  if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: 'Akses dashboard ditolak.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const field = id => interaction.fields.getTextInputValue(id);
  if (action === 'modal_profile') {
    const name = field('profile_name').trim();
    const type = field('profile_type').trim().toLowerCase();
    const division = field('profile_division').trim();
    const prefix = field('profile_prefix').trim();
    const acceptedRoleId = field('accepted_role_id').trim();
    if (value === 'new') {
      const profile = await createRecruitmentProfile(client, interaction.guildId, {
        name, type, division, prefix, acceptedRoleId, emoji: type === 'partnership' ? '🤝' : '📄',
      }, interaction.user.id);
      return interaction.editReply(await buildDashboardPayload(client, interaction.guild, interaction.user.id, 'profile_detail', profile.id, null, 'Profile created in disabled state. Complete its settings before enabling.'));
    }
    const profile = await updateRecruitmentProfile(client, interaction.guildId, value, {
      name, type, division, prefix, acceptedRoleId,
    }, interaction.user.id);
    return interaction.editReply(await buildDashboardPayload(client, interaction.guild, interaction.user.id, 'profile_detail', profile.id, null, 'Profile updated.'));
  }
  if (action === 'modal_details') {
    const profile = await updateRecruitmentProfile(client, interaction.guildId, value, {
      data: {
        description: field('profile_description'), criteria: field('profile_criteria'),
        requirements: field('profile_requirements'), terms: field('profile_terms'), benefits: field('profile_benefits'),
      },
    }, interaction.user.id);
    return interaction.editReply(await buildDashboardPayload(client, interaction.guild, interaction.user.id, 'profile_detail', profile.id, null, 'Profile information saved.'));
  }
  if (action === 'modal_form') {
    const profile = await updateRecruitmentProfile(client, interaction.guildId, value, {
      data: { formTemplate: field('profile_form') },
    }, interaction.user.id);
    return interaction.editReply(await buildDashboardPayload(client, interaction.guild, interaction.user.id, 'profile_detail', profile.id, null, 'Manual ticket form template saved.'));
  }
  if (action === 'modal_content') {
    await updateRecruitmentSettings(client, interaction.guildId, {
      panelTitle: field('panel_title'), headline: field('panel_headline'),
      welcomeText: field('welcome_text'), introduction: field('introduction'), importantInfo: field('important_info'),
    }, interaction.user.id);
    return interaction.editReply(await buildDashboardPayload(client, interaction.guild, interaction.user.id, 'content', null, null, 'Main panel information saved as a draft.'));
  }
  if (action === 'modal_terms') {
    const color = field('panel_color').trim();
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Embed color harus menggunakan format HEX #RRGGBB.');
    const rawBanner = field('panel_banner').trim();
    if (rawBanner && new URL(rawBanner).protocol !== 'https:') throw new Error('Banner URL harus menggunakan HTTPS.');
    await updateRecruitmentSettings(client, interaction.guildId, {
      instructions: field('panel_instructions'), generalTerms: field('general_terms'),
      footerText: field('panel_footer'), embedColor: color, bannerUrl: rawBanner || null,
    }, interaction.user.id);
    return interaction.editReply(await buildDashboardPayload(client, interaction.guild, interaction.user.id, 'content', null, null, 'Instructions and appearance saved as a draft.'));
  }
}

async function handlePublicProfileSelect(interaction, client) {
  if (!interaction.guild) return interaction.reply({ content: 'Recruitment hanya tersedia di server SKAW.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const profile = await getRecruitmentProfile(client, interaction.guildId, interaction.values[0]);
  if (!profile || !profile.enabled || profile.archived) {
    return interaction.editReply({ content: 'Profil ini sedang tidak menerima aplikasi. Silakan pilih profil lain.' });
  }
  const data = profile.data || {};
  const embed = new EmbedBuilder().setColor(BLUE).setTitle((profile.emoji || '📄') + ' ' + profile.name)
    .setDescription([
      data.description || 'Informasi profil belum tersedia.',
      data.criteria ? '\n**Criteria**\n' + data.criteria : '',
      data.requirements ? '\n**Requirements**\n' + data.requirements : '',
      data.benefits ? '\n**Benefits**\n' + data.benefits : '',
      data.terms ? '\n**Terms & Conditions**\n' + data.terms : '',
      data.infoChannelId ? '\nFurther information: <#' + data.infoChannelId + '>' : '',
    ].filter(Boolean).join('\n').slice(0, 4000))
    .setFooter({ text: 'Review seluruh informasi sebelum mengirim aplikasi.' });
  const apply = new ButtonBuilder().setCustomId('skaw_rec_apply|' + profile.key)
    .setLabel(data.applyLabel || 'Apply').setEmoji('📝').setStyle(ButtonStyle.Primary);
  return interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(apply)], allowedMentions: { parse: [] } });
}

async function handleApply(interaction, client) {
  if (!interaction.guild) return interaction.reply({ content: 'Apply hanya dapat dilakukan di server SKAW.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const profileKey = String(interaction.customId).split('|')[1];
    const result = await createRecruitmentApplication(client, interaction.guild, profileKey, interaction);
    if (!result.channel) {
      return interaction.editReply({ content: 'Aplikasi **' + result.application.applicationId + '** tercatat, tetapi ticket channel belum dapat dipulihkan. Hubungi Recruitment Management.' });
    }
    const content = result.duplicate
      ? 'Interaksi ini sudah diproses. Aplikasi kamu: ' + result.application.applicationId + ' · ' + result.channel.toString()
      : 'Private application ticket berhasil dibuat: ' + result.channel.toString() + '\n**Application ID:** ' + result.application.applicationId +
        (result.warning ? '\n⚠️ ' + result.warning : '');
    return interaction.editReply({ content, allowedMentions: { parse: [] } });
  } catch (error) {
    logger.error('SKAW Recruitment apply failed', { guildId: interaction.guildId, userId: interaction.user.id, error });
    return interaction.editReply({ content: '❌ Aplikasi belum dapat dibuat: ' + String(error.message || error).slice(0, 1200) });
  }
}

async function handleTicketAction(interaction, client) {
  const parts = String(interaction.customId || '').split('|');
  const applicationId = parts[1];
  const action = parts[2];
  if (!interaction.guild || !applicationId) {
    return interaction.reply({ content: 'Recruitment ticket tidak valid.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const application = await getRecruitmentApplication(client, interaction.guildId, applicationId);
    if (!application) throw new Error('Application record tidak ditemukan.');
    const pool = await getPool(client);
    if (action === 'submit') {
      if (String(interaction.user.id) !== application.applicantId) throw new Error('Hanya applicant yang dapat mengirim aplikasi untuk direview.');
      if (application.ticketStatus !== 'open') throw new Error('Ticket harus dalam status open untuk mengirim aplikasi.');
      if (!['awaiting_submission', 'revision_required'].includes(application.applicationStatus)) {
        throw new Error('Application status saat ini tidak membutuhkan pengiriman ulang.');
      }
      const updated = await updateApplicationStatus(client, interaction.guild, application, 'submitted', interaction.user);
      const reviewerRoleIds = application.profileSnapshot?.data?.reviewerRoleIds || [];
      const mention = reviewerRoleIds.map(id => '<@&' + id + '>').join(' ');
      const channel = interaction.guild.channels.cache.get(updated.channelId);
      if (isTextChannel(channel)) {
        await channel.send({
          content: '📥 Application **' + updated.applicationId + '** telah dikirim untuk review. ' + mention,
          allowedMentions: { roles: reviewerRoleIds },
        });
        await channel.send({ components: [ticketControlRow(updated)], allowedMentions: { parse: [] } }).catch(() => {});
      }
      return interaction.editReply({ content: 'Aplikasi berhasil dikirim ke tim reviewer.' });
    }

    if (!await canReviewApplication(interaction, application)) throw new Error('Akses ditolak. Kamu bukan reviewer untuk profil aplikasi ini.');
    if (action === 'claim') {
      const updated = await claimApplication(client, interaction.guild, application, interaction.user);
      return interaction.editReply({ content: updated.claimedBy ? 'Application berhasil di-claim oleh kamu.' : 'Claim berhasil dilepas.' });
    }
    if (action === 'close') {
      await setTicketStatus(client, interaction.guild, application, 'closed', interaction.user.id);
      return interaction.editReply({ content: 'Ticket ditutup. Application status tidak berubah.' });
    }
    if (action === 'reopen') {
      if (application.ticketStatus === 'archived') throw new Error('Ticket yang sudah diarsipkan tidak dapat dibuka kembali.');
      await setTicketStatus(client, interaction.guild, application, 'open', interaction.user.id);
      return interaction.editReply({ content: 'Ticket dibuka kembali.' });
    }
    if (action === 'note') {
      return interaction.editReply({ content: 'Gunakan dashboard /recruitment panel untuk menambahkan internal note yang hanya tersimpan untuk reviewer.' });
    }
    if (action === 'archive') {
      const result = await archiveTicket(client, interaction.guild, application, interaction.user);
      return interaction.editReply({ content: 'Ticket archived. Transcript tersimpan di database' + (result.transcriptSent ? ' dan dikirim ke transcript channel.' : '. Transcript channel belum diatur atau tidak dapat diakses; channel tetap tersimpan sebagai arsip.') });
    }
    throw new Error('Ticket action tidak dikenal.');
  } catch (error) {
    logger.warn('SKAW Recruitment ticket action rejected', { applicationId, action, userId: interaction.user.id, error: error.message });
    return interaction.editReply({ content: '❌ ' + String(error.message || error).slice(0, 1200) });
  }
}

async function handleInternalNoteModal(interaction, client) {
  const parts = String(interaction.customId || '').split('|');
  const ownerId = parts[1];
  const applicationId = parts[2];
  if (ownerId !== String(interaction.user.id)) {
    return interaction.reply({ content: 'Internal note ini bukan milik sesi kamu.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const application = await getRecruitmentApplication(client, interaction.guildId, applicationId);
  if (!application || !await canReviewApplication(interaction, application)) {
    return interaction.editReply({ content: 'Akses reviewer ditolak.' });
  }
  await addInternalNote(client, interaction.guild, application, interaction.user, interaction.fields.getTextInputValue('internal_note'));
  return interaction.editReply({ content: 'Internal note disimpan secara private di database reviewer. Note tidak dipublikasikan ke applicant atau ticket channel.' });
}

export function isSkawRecruitmentInteraction(interaction) {
  return typeof interaction?.customId === 'string' && interaction.customId.startsWith('skaw_rec_');
}

export async function handleSkawRecruitmentInteraction(interaction, client) {
  try {
    const customId = String(interaction.customId || '');
    if (customId === 'skaw_rec_public_profile' && interaction.isStringSelectMenu?.()) {
      return handlePublicProfileSelect(interaction, client);
    }
    if (customId.startsWith('skaw_rec_apply|') && interaction.isButton?.()) {
      return handleApply(interaction, client);
    }
    if (customId.startsWith('skaw_rec_app|') && interaction.isButton?.()) {
      return handleTicketAction(interaction, client);
    }
    if (customId.startsWith('skaw_rec_note|') && interaction.isModalSubmit?.()) {
      return handleInternalNoteModal(interaction, client);
    }
    if (customId.startsWith('skaw_rec_dash|')) {
      if (interaction.isModalSubmit?.()) return handleDashboardModal(interaction, client);
      if (interaction.isButton?.() || interaction.isStringSelectMenu?.() ||
          interaction.isRoleSelectMenu?.() || interaction.isChannelSelectMenu?.()) {
        return handleDashboardInteraction(interaction, client);
      }
    }
    return null;
  } catch (error) {
    logger.error('SKAW Recruitment interaction failed', { customId: interaction.customId, guildId: interaction.guildId, error });
    const payload = { content: '❌ SKAW Recruitment: ' + String(error?.message || 'Terjadi kesalahan.').slice(0, 1400), allowedMentions: { parse: [] } };
    if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => null);
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => null);
  }
}

export async function reconcileRecruitmentApplications(client, guild) {
  const pool = await getPool(client);
  const pending = await pool.query(
    "SELECT * FROM skaw_recruitment_applications WHERE guild_id=$1 AND ticket_status='creating' AND channel_id IS NULL ORDER BY created_at ASC LIMIT 100",
    [String(guild.id)],
  );
  if (!pending.rows.length) return { scanned: 0, recovered: 0 };
  await guild.channels.fetch().catch(() => null);
  let recovered = 0;
  for (const row of pending.rows) {
    const application = mapApplication(row);
    const channel = guild.channels.cache.find(item => item.topic?.includes(application.applicationId));
    if (!channel) continue;
    const update = await pool.query(
      "UPDATE skaw_recruitment_applications SET channel_id=$3, ticket_status='open', updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1 AND application_id=$2 AND channel_id IS NULL RETURNING id",
      [String(guild.id), application.applicationId, String(channel.id)],
    );
    if (update.rows[0]) {
      recovered += 1;
      await recordRecruitmentEvent(pool, guild.id, update.rows[0].id, application.applicationId, 'ticket_recovered', client.user?.id, { channelId: channel.id });
      const recentMessages = await channel.messages.fetch({ limit: 10 }).catch(() => null);
      if (recentMessages?.size === 0) {
        const recoveredApplication = { ...application, channelId: String(channel.id), ticketStatus: 'open' };
        await channel.send({
          embeds: [ticketEmbed(recoveredApplication)],
          components: [ticketControlRow(recoveredApplication)],
          allowedMentions: { parse: [] },
        }).catch(async error => {
          await recordRecruitmentEvent(pool, guild.id, application.id, application.applicationId, 'ticket_recovery_message_failed', client.user?.id, { message: String(error.message || error) }).catch(() => {});
        });
      }
    }
  }
  return { scanned: pending.rows.length, recovered };
}

export async function initializeSkawRecruitment(client) {
  const pool = await getPool(client);
  let recovered = 0;
  let guilds = 0;
  for (const guild of client.guilds.cache.values()) {
    await ensureSettings(pool, guild.id);
    await seedStarterProfiles(pool, guild.id);
    const result = await reconcileRecruitmentApplications(client, guild);
    recovered += result.recovered;
    guilds += 1;
  }
  return { guilds, recovered };
}
