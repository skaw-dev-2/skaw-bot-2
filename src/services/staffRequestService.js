import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType,
  EmbedBuilder, escapeMarkdown, LabelBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits,
  RoleSelectMenuBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { SKAW_EMPLOYEE_ROLE_CATALOG } from './employeeLogsAutoRoleService.js';
import { getEmployeeRoleRegistry, BASE_EMPLOYEE_ROLE } from './employeeRoleRegistryService.js';
import { logger } from '../utils/logger.js';

export const STAFF_REQUEST_BASE_ROLE_ID = BASE_EMPLOYEE_ROLE.id;
export const DEFAULT_STAFF_REQUEST_MANAGEMENT_ROLE_IDS = Object.freeze(['1414623053471547474']);

const SNOWFLAKE_RE = /^\d{17,20}$/;
const REQUEST_TYPES = Object.freeze({
  absence: { code: 'ABS', label: 'Absence', title: 'ABSENCE FORM', color: 0x2563eb },
  resignation: { code: 'RES', label: 'Resignation', title: 'RESIGNATION FORM', color: 0x2563eb },
});
const REQUEST_STATUSES = new Set(['pending', 'approved', 'rejected', 'delivery_failed']);
const ABSENCE_DATE_PAGE_SIZE = 25;
const ABSENCE_MAX_FUTURE_DAYS = 730;
const MONTH_SHORT_NAMES_ID = Object.freeze([
  'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun',
  'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des',
]);

function getJakartaCalendarDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  return {
    year: Number(parts.find(part => part.type === 'year')?.value),
    month: Number(parts.find(part => part.type === 'month')?.value),
    day: Number(parts.find(part => part.type === 'day')?.value),
  };
}

function dateToIsoFromJakarta(date = new Date()) {
  const current = getJakartaCalendarDate(date);
  return String(current.year).padStart(4, '0') + '-' + String(current.month).padStart(2, '0') + '-' + String(current.day).padStart(2, '0');
}

function addCalendarDays(date, days) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + Number(days || 0), 12));
}

function formatIsoDate(date) {
  return String(date.getUTCFullYear()).padStart(4, '0') + '-' + String(date.getUTCMonth() + 1).padStart(2, '0') + '-' + String(date.getUTCDate()).padStart(2, '0');
}

export function buildAbsenceDateOptions(now = new Date(), offsetDays = 0) {
  const base = parseAbsenceDate(now instanceof Date ? dateToIsoFromJakarta(now) : String(now), 'Tanggal');
  const first = addCalendarDays(base, Math.max(0, Number(offsetDays) || 0));
  return Array.from({ length: ABSENCE_DATE_PAGE_SIZE }, (_, index) => {
    const date = addCalendarDays(first, index);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    return {
      label: new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date),
      value: formatIsoDate(date),
    };
  });
}
function parseAbsenceDate(value, label) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(label + ' wajib dipilih dengan benar.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (month < 1 || month > 12 || date.getUTCFullYear() !== year
      || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(label + ' tidak valid. Silakan pilih tanggal dari daftar.');
  }
  return date;
}

export function buildAbsenceDateRange(startValue, endValue) {
  const start = parseAbsenceDate(startValue, 'Tanggal mulai');
  const end = parseAbsenceDate(endValue, 'Tanggal selesai');
  if (start.getTime() > end.getTime()) {
    throw new Error('Tanggal mulai tidak boleh setelah tanggal selesai.');
  }
  const format = date => String(date.getUTCDate()).padStart(2, '0')
    + ' ' + MONTH_SHORT_NAMES_ID[date.getUTCMonth()]
    + ' ' + date.getUTCFullYear();
  return format(start) + ' - ' + format(end);
}
function addCalendarMonth(date) {
  const nextMonth = date.getUTCMonth() + 1;
  const year = date.getUTCFullYear() + Math.floor(nextMonth / 12);
  const month = nextMonth % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0, 12)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay), 12));
}

export function formatAbsenceDuration(startValue, endValue) {
  const start = parseAbsenceDate(startValue, 'Tanggal mulai');
  const end = parseAbsenceDate(endValue, 'Tanggal selesai');
  if (start.getTime() > end.getTime()) throw new Error('Tanggal mulai tidak boleh setelah tanggal selesai.');
  const elapsedDays = Math.floor((end.getTime() - start.getTime()) / 86400000);
  const durationDays = Math.max(1, elapsedDays);
  let cursor = start;
  let months = 0;
  while (months < ABSENCE_MAX_FUTURE_DAYS) {
    const next = addCalendarMonth(cursor);
    if (next.getTime() > end.getTime()) break;
    cursor = next;
    months += 1;
  }
  const remainingDays = Math.max(0, Math.floor((end.getTime() - cursor.getTime()) / 86400000));
  const weeks = Math.floor(remainingDays / 7);
  const days = remainingDays % 7;
  const parts = [];
  if (months) parts.push(months + ' month' + (months === 1 ? '' : 's'));
  if (weeks) parts.push(weeks + ' week' + (weeks === 1 ? '' : 's'));
  if (days) parts.push(days + ' day' + (days === 1 ? '' : 's'));
  if (!parts.length) parts.push('1 day');
  return parts.join(', ') + ' (' + durationDays + ' day' + (durationDays === 1 ? '' : 's') + ' / ' + (durationDays * 24) + ' hours)';
}

export function buildAbsenceDatePickerPayload(userId, { step = 'start', startDate = null, offsetDays = 0, now = new Date() } = {}) {
  if (!['start', 'end'].includes(step)) throw new Error('Tahap pemilihan tanggal tidak valid.');
  const offset = Number(offsetDays);
  if (!Number.isInteger(offset) || offset < 0 || offset > 725 || offset % ABSENCE_DATE_PAGE_SIZE !== 0) throw new Error('Halaman tanggal tidak valid.');
  const today = parseAbsenceDate(dateToIsoFromJakarta(now), 'Tanggal hari ini');
  const anchor = step === 'end' ? parseAbsenceDate(startDate, 'Tanggal mulai') : today;
  const dateOptions = buildAbsenceDateOptions(addCalendarDays(anchor, offset));
  const stepLabel = step === 'start' ? 'Tanggal Mulai' : 'Tanggal Selesai';
  const select = new StringSelectMenuBuilder()
    .setCustomId(step === 'start' ? 'skaw_sr_date_start|' + String(userId) : 'skaw_sr_date_end|' + String(userId) + '|' + String(startDate))
    .setPlaceholder('Pilih ' + stepLabel.toLowerCase())
    .setMinValues(1).setMaxValues(1).addOptions(dateOptions);
  const previousOffset = Math.max(0, offset - ABSENCE_DATE_PAGE_SIZE);
  const nextOffset = Math.min(725, offset + ABSENCE_DATE_PAGE_SIZE);
  const previous = new ButtonBuilder()
    .setCustomId('skaw_sr_date_page|' + step + '|' + String(userId) + '|' + (startDate || '-') + '|' + previousOffset)
    .setLabel('Previous 25 days').setStyle(ButtonStyle.Secondary).setDisabled(offset === 0);
  const next = new ButtonBuilder()
    .setCustomId('skaw_sr_date_page|' + step + '|' + String(userId) + '|' + (startDate || '-') + '|' + nextOffset)
    .setLabel('Next 25 days').setStyle(ButtonStyle.Secondary).setDisabled(offset >= 725);
  const embed = new EmbedBuilder().setColor(0x1a9ef3).setTitle('SKAW GROUP · ABSENCE DATE SELECTION').setDescription([
    step === 'start' ? '**Pilih tanggal mulai Absence.**' : '**Pilih tanggal selesai Absence.**',
    step === 'end' ? '**Tanggal mulai:** ' + startDate : '',
    '', '**Rentang pilihan:**', dateOptions[0].label + ' — ' + dateOptions[dateOptions.length - 1].label,
    '', 'Gunakan tombol Previous / Next untuk membuka tanggal di bulan berikutnya.',
    'Pilihan tanggal tersedia hingga 2 tahun ke depan.',
  ].filter(Boolean).join('\n')).setFooter({ text: 'SKAW GROUP · PEOPLE OPERATIONS' });
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(previous, next)],
    allowedMentions: { parse: [] },
  };
}

function getPool(client) {
  const status = client?.db?.getStatus?.();
  const pool = client?.db?.db?.pool;
  if (!pool || status?.isDegraded === true || client?.db?.isDegraded?.() === true) {
    throw new Error('Staff Request membutuhkan PostgreSQL aktif. Data tidak disimpan ke penyimpanan sementara.');
  }
  if (typeof pool.query !== 'function') throw new Error('PostgreSQL pool tidak tersedia.');
  return pool;
}

function cleanText(value, label, { required = true, maxLength = 900 } = {}) {
  const result = String(value ?? '').trim();
  if (required && !result) throw new Error(label + ' wajib diisi.');
  if (result.length > maxLength) throw new Error(label + ' maksimal ' + maxLength + ' karakter.');
  if (/@everyone\b|@here\b/i.test(result)) throw new Error(label + ' tidak boleh menggunakan @everyone atau @here.');
  return result;
}

function parseRoleIds(value) {
  if (Array.isArray(value)) return value.map(String).filter(id => SNOWFLAKE_RE.test(id));
  if (typeof value === 'string') {
    try { return parseRoleIds(JSON.parse(value)); } catch { return []; }
  }
  return [];
}

export function canSubmitStaffRequest(memberRoleIds = [], managementRoleIds = []) {
  const owned = new Set([...memberRoleIds].map(String));
  return owned.has(STAFF_REQUEST_BASE_ROLE_ID)
    || managementRoleIds.some(roleId => owned.has(String(roleId)));
}

function formatRequestId(type) {
  const template = REQUEST_TYPES[type];
  if (!template) throw new Error('Jenis pengajuan tidak dikenal.');
  return 'SKAW-' + template.code + '-' + randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
}

function mapStaffRequest(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    requestId: row.request_id,
    guildId: String(row.guild_id),
    type: row.request_type,
    applicantId: String(row.applicant_id),
    applicantName: row.applicant_name,
    applicantUsername: row.applicant_username || null,
    divisionRoleId: row.division_role_id ? String(row.division_role_id) : null,
    divisionName: row.division_name || null,
    dateRange: row.date_range || null,
    dateStart: row.date_start ? (row.date_start instanceof Date ? row.date_start.toISOString().slice(0, 10) : String(row.date_start).slice(0, 10)) : null,
    dateEnd: row.date_end ? (row.date_end instanceof Date ? row.date_end.toISOString().slice(0, 10) : String(row.date_end).slice(0, 10)) : null,
    reason: row.reason || '',
    note: row.note || '',
    status: row.status,
    channelId: row.channel_id ? String(row.channel_id) : null,
    messageId: row.message_id ? String(row.message_id) : null,
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : null,
    reviewedAt: row.reviewed_at || null,
    reviewReason: row.review_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function resolveDivisionRoleFromIds(memberRoleIds = [], registryRoles = [], managementRoleIds = []) {
  const owned = new Set([...memberRoleIds].map(String));
  if (managementRoleIds.some(roleId => owned.has(String(roleId)))) {
    return { id: null, name: 'Management', management: true };
  }
  const matches = new Map();

  for (const [id, metadata] of Object.entries(SKAW_EMPLOYEE_ROLE_CATALOG)) {
    if (owned.has(id) && metadata?.active === true && metadata?.kind === 'division') {
      matches.set(id, { id, name: metadata.name });
    }
  }

  for (const role of registryRoles || []) {
    const id = String(role?.id || '');
    if (owned.has(id) && role?.category === 'division' && role?.active !== false && SNOWFLAKE_RE.test(id)) {
      matches.set(id, { id, name: String(role.name || 'Division') });
    }
  }

  const divisions = [...matches.values()];
  if (!divisions.length) {
    const domainLabels = { mechanic: 'Mechanic', builder: 'Builder', trucker: 'Trucker', taxi: 'Taxi' };
    const fallbackDomains = new Set();
    for (const [id, metadata] of Object.entries(SKAW_EMPLOYEE_ROLE_CATALOG)) {
      if (!owned.has(id) || metadata?.active !== true || metadata?.position === false
          || !metadata?.domain || ['management', 'partner'].includes(metadata.domain)) continue;
      const domain = String(metadata.domain);
      if (domainLabels[domain]) fallbackDomains.add(domain);
    }
    for (const role of registryRoles || []) {
      if (role?.active === false || role?.category !== 'rank') continue;
      const department = String(role?.department || '').toLowerCase();
      if (domainLabels[department]) fallbackDomains.add(department);
    }
    if (fallbackDomains.size === 1) {
      const domain = [...fallbackDomains][0];
      return { id: null, name: domainLabels[domain] + ' Division | SKAW', inferred: true };
    }
    if (fallbackDomains.size > 1) {
      throw new Error('Role divisi tidak dapat ditentukan secara otomatis. Hubungi Management untuk memperbarui Division Role akun kamu.');
    }
    return null;
  }
  if (divisions.length > 1) {
    throw new Error('Akun kamu memiliki lebih dari satu Division Role aktif. Hubungi Management untuk memperbaiki penempatan divisi sebelum mengirim pengajuan.');
  }
  return divisions[0];
}

async function getMemberDivision(client, guild, member, managementRoleIds = []) {
  const memberRoleIds = [...member.roles.cache.keys()];
  if (managementRoleIds.some(roleId => member.roles.cache.has(String(roleId)))) {
    return { id: null, name: 'Management' };
  }
  const registry = await getEmployeeRoleRegistry(client, guild.id);
  const division = resolveDivisionRoleFromIds(memberRoleIds, registry.roles, managementRoleIds);
  if (!division) {
    throw new Error('Division Role SKAW belum ditemukan pada akun kamu. Hubungi Management untuk memperbarui role divisi.');
  }
  if (division.inferred) return { id: null, name: division.name };
  const role = member.roles.cache.get(division.id)
    || await guild.roles.fetch(division.id).catch(() => null);
  if (!role) throw new Error('Division Role tidak ditemukan di server. Hubungi Management.');
  return { id: role.id, name: role.name };
}

export async function getStaffRequestSettings(client, guildId) {
  const pool = getPool(client);
  await pool.query(
    'INSERT INTO skaw_staff_request_settings (guild_id, management_role_ids) VALUES ($1, $2::jsonb) ON CONFLICT (guild_id) DO NOTHING',
    [String(guildId), JSON.stringify(DEFAULT_STAFF_REQUEST_MANAGEMENT_ROLE_IDS)],
  );
  const result = await pool.query(
    'SELECT guild_id, request_channel_id, absence_channel_id, resignation_channel_id, log_channel_id, management_role_ids, updated_by, updated_at FROM skaw_staff_request_settings WHERE guild_id=$1 LIMIT 1',
    [String(guildId)],
  );
  const row = result.rows[0];
  const legacyChannelId = row?.request_channel_id ? String(row.request_channel_id) : null;
  const roleIds = parseRoleIds(row?.management_role_ids);
  return {
    guildId: String(guildId),
    absenceChannelId: row?.absence_channel_id ? String(row.absence_channel_id) : legacyChannelId,
    resignationChannelId: row?.resignation_channel_id ? String(row.resignation_channel_id) : legacyChannelId,
    logChannelId: row?.log_channel_id ? String(row.log_channel_id) : null,
    managementRoleIds: roleIds.length ? roleIds : [...DEFAULT_STAFF_REQUEST_MANAGEMENT_ROLE_IDS],
    updatedBy: row?.updated_by ? String(row.updated_by) : null,
    updatedAt: row?.updated_at || null,
  };
}

export async function setStaffRequestChannel(client, guildId, requestType, channelId, actorId) {
  const columnByType = {
    absence: 'absence_channel_id',
    resignation: 'resignation_channel_id',
  };
  const column = columnByType[String(requestType)];
  if (!column) throw new Error('Jenis Staff Request untuk channel tidak valid.');
  const id = String(channelId || '');
  if (!SNOWFLAKE_RE.test(id)) throw new Error('Request channel ID tidak valid.');
  const pool = getPool(client);
  await getStaffRequestSettings(client, guildId);
  await pool.query(
    'UPDATE skaw_staff_request_settings SET ' + column + '=$2, updated_by=$3, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1',
    [String(guildId), id, String(actorId)],
  );
  return getStaffRequestSettings(client, guildId);
}

export async function setStaffRequestManagementRoles(client, guildId, roleIds, actorId) {
  const unique = [...new Set((roleIds || []).map(String))];
  if (!unique.length) throw new Error('Pilih minimal satu Management Role.');
  if (unique.length > 10 || unique.some(id => !SNOWFLAKE_RE.test(id))) {
    throw new Error('Pilih maksimal 10 Management Role yang valid.');
  }
  const pool = getPool(client);
  await getStaffRequestSettings(client, guildId);
  await pool.query(
    'UPDATE skaw_staff_request_settings SET management_role_ids=$2::jsonb, updated_by=$3, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1',
    [String(guildId), JSON.stringify(unique), String(actorId)],
  );
  return getStaffRequestSettings(client, guildId);
}

export async function setStaffRequestLogChannel(client, guildId, channelId, actorId) {
  const id = channelId ? String(channelId) : null;
  if (id && !SNOWFLAKE_RE.test(id)) throw new Error('Staff Request logs channel ID tidak valid.');
  const pool = getPool(client);
  await getStaffRequestSettings(client, guildId);
  await pool.query(
    'UPDATE skaw_staff_request_settings SET log_channel_id=$2, updated_by=$3, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1',
    [String(guildId), id, String(actorId)],
  );
  return getStaffRequestSettings(client, guildId);
}

export function buildStaffRequestSetupPayload(settings, notice = null) {
  const embed = new EmbedBuilder()
    .setColor(0x1a9ef3)
    .setTitle('SKAW GROUP · STAFF REQUEST SETTINGS')
    .setDescription([
      'Configure request channels, a shared activity log channel, and Management approval roles.',
      '',
      '**Absence Channel**',
      settings.absenceChannelId ? '<#' + settings.absenceChannelId + '>' : 'Not configured',
      '',
      '**Resignation Channel**',
      settings.resignationChannelId ? '<#' + settings.resignationChannelId + '>' : 'Not configured',
      '',
      '**Activity Logs Channel**',
      settings.logChannelId ? '<#' + settings.logChannelId + '>' : 'Not configured',
      '',
      '**Management Approval Roles**',
      settings.managementRoleIds.length ? settings.managementRoleIds.map(id => '<@&' + id + '>').join(', ') : 'Not configured',
      '',
      '-# Company Staff and configured Management roles can submit Absence and Resignation requests.',
      '-# Only configured Management roles and server administrators can approve or reject.',
    ].join('\n'))
    .setFooter({ text: 'SKAW GROUP · PEOPLE OPERATIONS' });
  if (notice) embed.addFields({ name: 'Update', value: String(notice).slice(0, 900) });

  const absenceChannelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('skaw_sr_setup_absence_channel')
    .setPlaceholder('Select Absence request channel')
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(1);
  if (settings.absenceChannelId) absenceChannelSelect.setDefaultChannels(settings.absenceChannelId);

  const resignationChannelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('skaw_sr_setup_resignation_channel')
    .setPlaceholder('Select Resignation request channel')
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(1);
  if (settings.resignationChannelId) resignationChannelSelect.setDefaultChannels(settings.resignationChannelId);

  const logChannelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('skaw_sr_setup_logs_channel')
    .setPlaceholder('Select Staff Request activity logs channel')
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(1);
  if (settings.logChannelId) logChannelSelect.setDefaultChannels(settings.logChannelId);

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId('skaw_sr_setup_roles')
    .setPlaceholder('Select Management approval roles')
    .setMinValues(1)
    .setMaxValues(10);
  if (settings.managementRoleIds.length) roleSelect.setDefaultRoles(...settings.managementRoleIds.slice(0, 10));

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(absenceChannelSelect),
      new ActionRowBuilder().addComponents(resignationChannelSelect),
      new ActionRowBuilder().addComponents(logChannelSelect),
      new ActionRowBuilder().addComponents(roleSelect),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('skaw_sr_setup_reset')
          .setLabel('Reset Management Roles')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('skaw_sr_setup_logs_disable')
          .setLabel('Disable Logs')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

function isServerAdministrator(interaction) {
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild),
  );
}

async function isManagementMember(interaction, settings) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  let member = interaction.member;
  if (!member?.roles?.cache) {
    member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  }
  if (!member?.roles?.cache) return false;
  return settings.managementRoleIds.some(id => member.roles.cache.has(String(id)));
}

async function getStaffRequestById(client, guildId, requestId) {
  const pool = getPool(client);
  const result = await pool.query(
    'SELECT * FROM skaw_staff_requests WHERE guild_id=$1 AND request_id=$2 LIMIT 1',
    [String(guildId), String(requestId)],
  );
  return mapStaffRequest(result.rows[0]);
}

export function buildStaffRequestEmbed(request) {
  const template = REQUEST_TYPES[request.type];
  if (!template) throw new Error('Jenis pengajuan tidak dikenal.');
  if (!REQUEST_STATUSES.has(request.status || 'pending')) throw new Error('Status pengajuan tidak dikenal.');

  const cleanName = escapeMarkdown(cleanText(request.applicantName, 'Name', { maxLength: 100 }));
  const cleanUsername = request.applicantUsername
    ? escapeMarkdown(cleanText(request.applicantUsername, 'Discord username', { maxLength: 100 }))
    : null;
  const cleanReason = escapeMarkdown(cleanText(request.reason, 'Reason', { maxLength: 900 }));
  const cleanDivision = request.divisionRoleId
    ? '<@&' + String(request.divisionRoleId) + '>'
    : escapeMarkdown(cleanText(request.divisionName || 'Not recorded', 'Division', { maxLength: 100 }));
  const reviewerPermission = (request.managementRoleIds || DEFAULT_STAFF_REQUEST_MANAGEMENT_ROLE_IDS)
    .map(id => '<@&' + String(id) + '>')
    .join(', ');

  const lines = [
    '__**' + template.title + '**__',
    '',
    '> **Name :** ' + cleanName + (cleanUsername ? ' (@' + cleanUsername + ')' : ''),
    '> **Division :** ' + cleanDivision,
  ];
  if (request.type === 'absence') {
    lines.push(
      '> **Date :** ' + escapeMarkdown(cleanText(request.dateRange, 'Date', { maxLength: 100 })),
      ...(request.dateStart && request.dateEnd
        ? ['> **Duration :** ' + escapeMarkdown(formatAbsenceDuration(request.dateStart, request.dateEnd))]
        : []),
      '> **Reason :** ' + cleanReason,
    );
  } else {
    lines.push('> **Reason :** ' + cleanReason);
    const note = escapeMarkdown(cleanText(request.note, 'Note', { required: false, maxLength: 700 }));
    if (note) lines.push('> **Note :** ' + note);
  }
  lines.push(
    '> **Permission to :** ' + reviewerPermission,
    '',
    'Signed,',
    '__**' + cleanName + '**__.',
  );

  const statusLabel = {
    pending: '⏳ Pending Approval',
    approved: '✅ Approved',
    rejected: '❌ Rejected',
    delivery_failed: '⚠️ Delivery Failed',
  }[request.status || 'pending'];

  const embed = new EmbedBuilder()
    .setColor(request.status === 'approved' ? 0x16a34a : request.status === 'rejected' ? 0xdc2626 : template.color)
    .setTitle('SKAW GROUP · ' + template.label.toUpperCase() + ' REQUEST')
    .setDescription(lines.join('\n'))
    .addFields(
      { name: 'Approval Status', value: statusLabel, inline: true },
    )
    .setFooter({ text: 'SKAW GROUP · PEOPLE OPERATIONS' })
    .setTimestamp(request.createdAt ? new Date(request.createdAt) : new Date());

  if (request.reviewedBy) {
    embed.addFields({ name: 'Reviewed By', value: '<@' + String(request.reviewedBy) + '>', inline: true });
  }
  if (request.reviewReason) {
    embed.addFields({
      name: request.status === 'rejected' ? 'Rejection Note' : 'Review Note',
      value: escapeMarkdown(cleanText(request.reviewReason, 'Review note', { maxLength: 900 })),
      inline: false,
    });
  }
  return embed;
}

export function buildStaffRequestLogEmbed(request, event = 'submitted') {
  const template = REQUEST_TYPES[request.type];
  if (!template) throw new Error('Jenis pengajuan tidak dikenal.');
  const eventLabels = { submitted: 'NEW REQUEST SUBMITTED', approved: 'REQUEST APPROVED', rejected: 'REQUEST REJECTED', delivery_failed: 'REQUEST DELIVERY FAILED' };
  const eventColors = { submitted: 0x2563eb, approved: 0x16a34a, rejected: 0xdc2626, delivery_failed: 0xd97706 };
  const name = escapeMarkdown(cleanText(request.applicantName, 'Name', { maxLength: 100 }));
  const username = request.applicantUsername ? escapeMarkdown(cleanText(request.applicantUsername, 'Discord username', { maxLength: 100 })) : null;
  const division = request.divisionRoleId ? '<@&' + String(request.divisionRoleId) + '>' : escapeMarkdown(cleanText(request.divisionName || 'Not recorded', 'Division', { maxLength: 100 }));
  const lines = [
    '**Employee:** <@' + String(request.applicantId) + '>',
    '**Name:** ' + name + (username ? ' (@' + username + ')' : ''),
    '**Division:** ' + division,
    '**Request ID:** `' + String(request.requestId || 'N/A') + '`',
    '**Reason:** ' + escapeMarkdown(cleanText(request.reason || 'Not recorded', 'Reason', { maxLength: 900 })),
  ];
  if (request.type === 'absence' && request.dateRange) {
    lines.splice(3, 0, '**Date:** ' + escapeMarkdown(cleanText(request.dateRange, 'Date', { maxLength: 100 })));
    if (request.dateStart && request.dateEnd) lines.splice(4, 0, '**Duration:** ' + escapeMarkdown(formatAbsenceDuration(request.dateStart, request.dateEnd)));
  }
  if (request.note) lines.push('**Note:** ' + escapeMarkdown(cleanText(request.note, 'Note', { maxLength: 700 })));
  if (request.reviewedBy) lines.push('**Reviewed By:** <@' + String(request.reviewedBy) + '>');
  if (request.reviewReason) lines.push('**Management Note:** ' + escapeMarkdown(cleanText(request.reviewReason, 'Management note', { maxLength: 800 })));
  return new EmbedBuilder()
    .setColor(eventColors[event] || 0x64748b)
    .setTitle('SKAW GROUP · ' + template.label.toUpperCase() + ' · ' + (eventLabels[event] || 'REQUEST UPDATE'))
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'SKAW GROUP · PEOPLE OPERATIONS LOGS' })
    .setTimestamp(request.reviewedAt || request.createdAt || new Date());
}

async function sendStaffRequestLog(guild, settings, request, event) {
  if (!settings?.logChannelId) return false;
  const channel = guild.channels.cache.get(settings.logChannelId) || await guild.channels.fetch(settings.logChannelId).catch(() => null);
  if (!channel?.isTextBased?.() || channel.isDMBased?.()) {
    logger.warn('Staff Request logs channel is unavailable', { guildId: guild.id, channelId: settings.logChannelId });
    return false;
  }
  try {
    await channel.send({ embeds: [buildStaffRequestLogEmbed(request, event)], allowedMentions: { parse: [] } });
    return true;
  } catch (error) {
    logger.warn('Could not send Staff Request activity log', { guildId: guild.id, requestId: request.requestId, event, channelId: settings.logChannelId, error: error.message });
    return false;
  }
}
export function buildStaffRequestDecisionRows(request) {
  const template = REQUEST_TYPES[request.type];
  if (!template) throw new Error('Jenis pengajuan tidak dikenal.');

  let decisionRow;
  if (request.status === 'pending') {
    decisionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('skaw_sr_decide|' + request.requestId + '|approve')
        .setLabel('Approve')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('skaw_sr_decide|' + request.requestId + '|reject')
        .setLabel('Reject')
        .setEmoji('✖️')
        .setStyle(ButtonStyle.Danger),
    );
  } else {
    const label = request.status === 'approved' ? 'Approved' : request.status === 'rejected' ? 'Rejected' : 'Unavailable';
    decisionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('skaw_sr_decision_complete|' + request.requestId)
        .setLabel(label)
        .setStyle(request.status === 'approved' ? ButtonStyle.Success : ButtonStyle.Danger)
        .setDisabled(true),
    );
  }

  const submitRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('skaw_sr_submit|' + request.requestId)
      .setLabel(template.label === 'Absence' ? 'Submit Absence' : 'Submit Resignation')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Primary),
  );

  return [decisionRow, submitRow];
}

export function buildStaffRequestDecisionStatement(requestId, guildId, status, reviewerId, reason = '') {
  if (!['approved', 'rejected'].includes(status)) throw new Error('Decision status tidak valid.');
  return {
    text: "UPDATE skaw_staff_requests SET status=$3::varchar(24), reviewed_by=$4, reviewed_at=CURRENT_TIMESTAMP, review_reason=$5, updated_at=CURRENT_TIMESTAMP WHERE request_id=$1 AND guild_id=$2 AND status='pending' RETURNING *",
    values: [String(requestId), String(guildId), status, String(reviewerId), reason ? String(reason) : null],
  };
}

function buildRequestModal(userId, type, dateStart = null, dateEnd = null) {
  const template = REQUEST_TYPES[type];
  if (!template) throw new Error('Jenis form tidak dikenal.');
  const modal = new ModalBuilder()
    .setCustomId('skaw_sr_form|' + type + '|' + String(userId))
    .setTitle(template.label + ' Request');
  if (type === 'absence') {
    buildAbsenceDateRange(dateStart, dateEnd);
    modal.setCustomId('skaw_sr_form|absence|' + String(userId) + '|' + String(dateStart) + '|' + String(dateEnd));
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Reason')
        .setPlaceholder('Jelaskan alasan absence kamu.')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(900),
    ));
  } else {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Resignation Reason')
          .setPlaceholder('Jelaskan alasan pengunduran diri kamu.')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(900),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('note')
          .setLabel('Note / Pesan Tambahan (optional)')
          .setPlaceholder('Ucapan terima kasih atau pesan untuk Management.')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(700),
      ),
    );
  }
  return modal;
}
export async function openStaffRequestSetup(interaction, client) {
  if (!interaction.inGuild?.() || !interaction.guild) {
    return interaction.reply({ content: 'Staff Request hanya dapat dikonfigurasi di dalam server.', flags: MessageFlags.Ephemeral });
  }
  if (!isServerAdministrator(interaction)) {
    return interaction.reply({ content: 'Akses ditolak. Permission Manage Server diperlukan untuk mengatur Staff Request.', flags: MessageFlags.Ephemeral });
  }
  const settings = await getStaffRequestSettings(client, interaction.guildId);
  return interaction.reply({
    ...buildStaffRequestSetupPayload(settings),
    flags: MessageFlags.Ephemeral,
  });
}

async function submitStaffRequest(client, guild, interaction, type, input) {
  const pool = getPool(client);
  const member = interaction.member?.roles?.cache
    ? interaction.member
    : await guild.members.fetch(interaction.user.id).catch(() => null);
  const settings = await getStaffRequestSettings(client, guild.id);
  if (!canSubmitStaffRequest([...member.roles.cache.keys()], settings.managementRoleIds)) {
    throw new Error('Fitur ini hanya dapat digunakan oleh anggota Company Staff atau Management SKAW.');
  }
  const division = await getMemberDivision(client, guild, member, settings.managementRoleIds);
  const channelId = type === 'absence' ? settings.absenceChannelId : settings.resignationChannelId;
  if (!channelId) {
    throw new Error(
      'Channel ' + REQUEST_TYPES[type].label + ' belum dikonfigurasi. Hubungi Management untuk mengatur channel Staff Request.',
    );
  }

  const channel = guild.channels.cache.get(channelId)
    || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.() || channel.isDMBased?.()) {
    throw new Error('Staff Request channel tidak ditemukan atau bukan text channel. Hubungi Management.');
  }
  const managerRoles = [];
  for (const roleId of settings.managementRoleIds) {
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (role) managerRoles.push(role);
  }
  if (!managerRoles.length) {
    throw new Error('Management approval role tidak ditemukan. Hubungi administrator untuk memperbarui konfigurasi.');
  }

  const reason = cleanText(input.reason, 'Reason', { maxLength: 900 });
  const dateRange = type === 'absence' ? cleanText(input.dateRange, 'Date', { maxLength: 100 }) : null;
  const note = type === 'resignation' ? cleanText(input.note, 'Note', { required: false, maxLength: 700 }) : '';

  if (type === 'resignation') {
    const pending = await pool.query(
      "SELECT request_id FROM skaw_staff_requests WHERE guild_id=$1 AND applicant_id=$2 AND request_type='resignation' AND status='pending' LIMIT 1",
      [String(guild.id), String(interaction.user.id)],
    );
    if (pending.rows[0]) {
      throw new Error('Kamu masih memiliki pengajuan resign yang menunggu keputusan Management: ' + pending.rows[0].request_id + '.');
    }
  }

  const requestId = formatRequestId(type);
  const applicantName = cleanText(member.displayName || interaction.user.username, 'Name', { maxLength: 100 });
  const applicantUsername = cleanText(interaction.user.username || interaction.user.id, 'Discord username', { maxLength: 100 });
  let inserted;
  try {
    inserted = await pool.query(
      "INSERT INTO skaw_staff_requests (request_id, guild_id, request_type, applicant_id, applicant_name, applicant_username, division_role_id, division_name, date_range, reason, note, status, channel_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12) RETURNING *",
      [requestId, String(guild.id), type, String(interaction.user.id), applicantName, applicantUsername,
        division.id, division.name, dateRange, reason, note, String(channel.id)],
    );
  } catch (error) {
    if (type === 'resignation' && error?.code === '23505') {
      throw new Error('Kamu masih memiliki pengajuan resign yang menunggu keputusan Management.');
    }
    throw error;
  }
  const request = mapStaffRequest(inserted.rows[0]);
  const requestWithRoles = { ...request, managementRoleIds: managerRoles.map(role => role.id) };
  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  const canMentionRoles = Boolean(channel.permissionsFor?.(botMember)?.has(PermissionFlagsBits.MentionEveryone));
  const roleMentions = canMentionRoles ? managerRoles.map(role => '<@&' + role.id + '>').join(' ') : undefined;

  try {
    const message = await channel.send({
      ...(roleMentions ? { content: roleMentions } : {}),
      embeds: [buildStaffRequestEmbed(requestWithRoles)],
      components: buildStaffRequestDecisionRows(request),
      allowedMentions: { parse: [], ...(canMentionRoles ? { roles: managerRoles.map(role => role.id) } : {}) },
    });
    await pool.query(
      'UPDATE skaw_staff_requests SET message_id=$3, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1 AND request_id=$2',
      [String(guild.id), requestId, String(message.id)],
    );
  } catch (error) {
    await pool.query(
      "UPDATE skaw_staff_requests SET status='delivery_failed', updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1 AND request_id=$2",
      [String(guild.id), requestId],
    ).catch(() => {});
    logger.error('Staff Request message delivery failed', { guildId: guild.id, requestId, error });
    throw new Error('Pengajuan tercatat, tetapi pesan gagal dikirim ke channel Management. Hubungi administrator dengan Request ID ' + requestId + '.');
  }

  return requestWithRoles;
}

async function updateRequestMessage(client, guild, request) {
  if (!request.channelId || !request.messageId) return false;
  const channel = guild.channels.cache.get(request.channelId)
    || await guild.channels.fetch(request.channelId).catch(() => null);
  if (!channel?.messages?.fetch) return false;
  const message = await channel.messages.fetch(request.messageId).catch(() => null);
  if (!message || message.author?.id !== client.user?.id) return false;
  const settings = await getStaffRequestSettings(client, guild.id);
  await message.edit({
    embeds: [buildStaffRequestEmbed({ ...request, managementRoleIds: settings.managementRoleIds })],
    components: buildStaffRequestDecisionRows(request),
    allowedMentions: { parse: [] },
  });
  return true;
}

async function notifyApplicant(guild, request) {
  const member = guild.members.cache.get(request.applicantId)
    || await guild.members.fetch(request.applicantId).catch(() => null);
  if (!member) return;
  const action = request.status === 'approved' ? 'disetujui' : 'ditolak';
  const type = REQUEST_TYPES[request.type]?.label || 'Staff Request';
  const lines = [
    'Pengajuan **' + type + '** kamu di SKAW Group telah **' + action + '** oleh Management.',
    '',
    '**Request ID:** ' + request.requestId,
  ];
  if (request.reviewReason) lines.push('**Catatan Management:** ' + escapeMarkdown(request.reviewReason));
  await member.send({ content: lines.join('\n'), allowedMentions: { parse: [] } }).catch(error => {
    logger.warn('Could not DM Staff Request applicant', { requestId: request.requestId, userId: request.applicantId, error: error.message });
  });
}

async function finalizeDecision(client, interaction, requestId, status, reason = '') {
  const pool = getPool(client);
  const statement = buildStaffRequestDecisionStatement(requestId, interaction.guildId, status, interaction.user.id, reason);
  const result = await pool.query(statement.text, statement.values);
  if (!result.rows[0]) {
    const current = await getStaffRequestById(client, interaction.guildId, requestId);
    if (!current) throw new Error('Pengajuan tidak ditemukan.');
    throw new Error('Pengajuan ini sudah diproses dengan status ' + current.status + '. Keputusan tidak dapat diubah.');
  }
  const request = mapStaffRequest(result.rows[0]);
  const settings = await getStaffRequestSettings(client, interaction.guildId);
  const updated = { ...request, managementRoleIds: settings.managementRoleIds };
  await updateRequestMessage(client, interaction.guild, updated).catch(error => {
    logger.error('Staff Request decision saved but message update failed', { requestId, status, error });
  });
  await notifyApplicant(interaction.guild, updated);
  return updated;
}

async function handleRequestForm(interaction, client) {
  const [, type, ownerId] = String(interaction.customId || '').split('|');
  if (ownerId !== String(interaction.user.id)) {
    return interaction.reply({ content: 'Form ini bukan milik sesi kamu.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (!Object.hasOwn(REQUEST_TYPES, type)) throw new Error('Jenis pengajuan tidak dikenal.');
    const input = {
      dateRange: type === 'absence'
        ? buildAbsenceDateRange(
          interaction.fields.getStringSelectValues('start_date')[0],
          interaction.fields.getStringSelectValues('end_date')[0],
        )
        : null,
      reason: interaction.fields.getTextInputValue('reason'),
      note: type === 'resignation' ? interaction.fields.getTextInputValue('note') : '',
    };
    const request = await submitStaffRequest(client, interaction.guild, interaction, type, input);
    return interaction.editReply({
      content: '✅ Pengajuan **' + REQUEST_TYPES[type].label + '** berhasil dikirim ke Management.\n**Request ID:** ' + request.requestId,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.warn('Staff Request submission rejected', { guildId: interaction.guildId, userId: interaction.user.id, type, error: error.message });
    return interaction.editReply({ content: '❌ Staff Request: ' + String(error.message || error).slice(0, 1200) });
  }
}

async function handleSetupComponent(interaction, client) {
  if (!interaction.guild || !isServerAdministrator(interaction)) {
    return interaction.reply({ content: 'Akses ditolak. Permission Manage Server diperlukan.', flags: MessageFlags.Ephemeral });
  }
  const id = String(interaction.customId || '');
  if (interaction.isChannelSelectMenu?.() && (
    id === 'skaw_sr_setup_absence_channel'
    || id === 'skaw_sr_setup_resignation_channel'
    || id === 'skaw_sr_setup_channel'
  )) {
    await interaction.deferUpdate();
    let settings;
    if (id === 'skaw_sr_setup_channel') {
      settings = await setStaffRequestChannel(client, interaction.guildId, 'absence', interaction.values[0], interaction.user.id);
      settings = await setStaffRequestChannel(client, interaction.guildId, 'resignation', interaction.values[0], interaction.user.id);
    } else {
      const requestType = id === 'skaw_sr_setup_absence_channel' ? 'absence' : 'resignation';
      settings = await setStaffRequestChannel(client, interaction.guildId, requestType, interaction.values[0], interaction.user.id);
    }
    return interaction.editReply({
      ...buildStaffRequestSetupPayload(
        settings,
        id === 'skaw_sr_setup_channel'
          ? 'Legacy request channel berhasil diterapkan ke Absence dan Resignation.'
          : (id === 'skaw_sr_setup_absence_channel' ? 'Absence channel' : 'Resignation channel') + ' berhasil diperbarui.',
      ),
      allowedMentions: { parse: [] },
    });
  }
  if (interaction.isRoleSelectMenu?.() && id === 'skaw_sr_setup_roles') {
    await interaction.deferUpdate();
    const settings = await setStaffRequestManagementRoles(client, interaction.guildId, interaction.values, interaction.user.id);
    return interaction.editReply({
      ...buildStaffRequestSetupPayload(settings, 'Management approval roles berhasil diperbarui.'),
      allowedMentions: { parse: [] },
    });
  }
  if (interaction.isButton?.() && id === 'skaw_sr_setup_reset') {
    await interaction.deferUpdate();
    const settings = await setStaffRequestManagementRoles(
      client, interaction.guildId, DEFAULT_STAFF_REQUEST_MANAGEMENT_ROLE_IDS, interaction.user.id,
    );
    return interaction.editReply({
      ...buildStaffRequestSetupPayload(settings, 'Management role dikembalikan ke Management Company | SKAW.'),
      allowedMentions: { parse: [] },
    });
  }
  return null;
}

async function handleSubmitButton(interaction, client) {
  const [, requestId] = String(interaction.customId || '').split('|');
  if (!interaction.guild || !requestId) {
    return interaction.reply({ content: 'Staff Request submit button tidak valid.', flags: MessageFlags.Ephemeral });
  }

  const request = await getStaffRequestById(client, interaction.guildId, requestId);
  if (!request) {
    return interaction.reply({ content: 'Pengajuan tidak ditemukan atau sudah tidak tersedia.', flags: MessageFlags.Ephemeral });
  }

  if (
    String(interaction.message?.id || '') !== String(request.messageId || '')
    || String(interaction.channelId || '') !== String(request.channelId || '')
    || String(interaction.message?.author?.id || '') !== String(client.user?.id || '')
  ) {
    return interaction.reply({
      content: 'Tombol ini tidak terhubung dengan pesan pengajuan SKAW yang valid.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const member = interaction.member?.roles?.cache
    ? interaction.member
    : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  const settings = await getStaffRequestSettings(client, interaction.guildId);
  if (!member?.roles?.cache || !canSubmitStaffRequest([...member.roles.cache.keys()], settings.managementRoleIds)) {
    return interaction.reply({
      content: 'Fitur ini hanya dapat digunakan oleh anggota Company Staff atau Management SKAW.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.showModal(buildRequestModal(interaction.user.id, request.type));
}

async function handleDecisionButton(interaction, client) {
  const [, requestId, action] = String(interaction.customId || '').split('|');
  if (!interaction.guild || !requestId || !['approve', 'reject'].includes(action)) {
    return interaction.reply({ content: 'Staff Request button tidak valid.', flags: MessageFlags.Ephemeral });
  }
  const request = await getStaffRequestById(client, interaction.guildId, requestId);
  if (!request) return interaction.reply({ content: 'Pengajuan tidak ditemukan.', flags: MessageFlags.Ephemeral });
  const settings = await getStaffRequestSettings(client, interaction.guildId);
  if (!await isManagementMember(interaction, settings)) {
    return interaction.reply({ content: 'Akses ditolak. Tombol ini hanya dapat digunakan oleh Management SKAW.', flags: MessageFlags.Ephemeral });
  }
  if (String(interaction.message?.id || '') !== String(request.messageId || '')
      || String(interaction.channelId || '') !== String(request.channelId || '')) {
    return interaction.reply({ content: 'Tombol ini tidak terhubung dengan pesan pengajuan yang valid.', flags: MessageFlags.Ephemeral });
  }
  if (request.status !== 'pending') {
    return interaction.reply({ content: 'Pengajuan ini sudah diproses dengan status ' + request.status + '.', flags: MessageFlags.Ephemeral });
  }

  if (action === 'reject') {
    const modal = new ModalBuilder()
      .setCustomId('skaw_sr_reject|' + request.requestId + '|' + interaction.user.id)
      .setTitle('Reject Staff Request')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('review_reason')
          .setLabel('Reason for rejection')
          .setPlaceholder('Tuliskan alasan atau catatan untuk employee.')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(800),
      ));
    return interaction.showModal(modal);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const updated = await finalizeDecision(client, interaction, request.requestId, 'approved');
  return interaction.editReply({
    content: '✅ Pengajuan ' + updated.requestId + ' berhasil di-approve.',
    allowedMentions: { parse: [] },
  });
}

async function handleRejectModal(interaction, client) {
  const [, requestId, reviewerId] = String(interaction.customId || '').split('|');
  if (reviewerId !== String(interaction.user.id)) {
    return interaction.reply({ content: 'Form rejection ini bukan milik sesi kamu.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const settings = await getStaffRequestSettings(client, interaction.guildId);
  if (!await isManagementMember(interaction, settings)) {
    return interaction.editReply({ content: 'Akses ditolak. Hanya Management SKAW yang dapat menolak pengajuan.' });
  }
  const reason = cleanText(interaction.fields.getTextInputValue('review_reason'), 'Rejection reason', { maxLength: 800 });
  const updated = await finalizeDecision(client, interaction, requestId, 'rejected', reason);
  return interaction.editReply({
    content: '❌ Pengajuan ' + updated.requestId + ' berhasil di-reject. Catatan sudah dikirim kepada employee.',
    allowedMentions: { parse: [] },
  });
}

export function isStaffRequestInteraction(interaction) {
  const id = String(interaction?.customId || '');
  return id.startsWith('skaw_sr_') && Boolean(
    interaction.isButton?.()
    || interaction.isModalSubmit?.()
    || interaction.isRoleSelectMenu?.()
    || interaction.isChannelSelectMenu?.(),
  );
}

export async function handleStaffRequestInteraction(interaction, client) {
  try {
    const id = String(interaction.customId || '');
    if (interaction.isModalSubmit?.() && id.startsWith('skaw_sr_form|')) {
      return handleRequestForm(interaction, client);
    }
    if (interaction.isModalSubmit?.() && id.startsWith('skaw_sr_reject|')) {
      return handleRejectModal(interaction, client);
    }
    if ((interaction.isChannelSelectMenu?.() || interaction.isRoleSelectMenu?.() || interaction.isButton?.())
        && id.startsWith('skaw_sr_setup_')) {
      return handleSetupComponent(interaction, client);
    }
    if (interaction.isButton?.() && id.startsWith('skaw_sr_submit|')) {
      return handleSubmitButton(interaction, client);
    }
    if (interaction.isButton?.() && id.startsWith('skaw_sr_decide|')) {
      return handleDecisionButton(interaction, client);
    }
    return null;
  } catch (error) {
    logger.error('SKAW Staff Request interaction failed', {
      customId: interaction.customId, guildId: interaction.guildId, userId: interaction.user?.id, error,
    });
    const payload = {
      content: '❌ Staff Request: ' + String(error?.message || 'Terjadi kesalahan.').slice(0, 1200),
      allowedMentions: { parse: [] },
    };
    if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => null);
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => null);
  }
}

export { buildRequestModal };
