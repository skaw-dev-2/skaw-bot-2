import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
  ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { logger } from '../utils/logger.js';

const CONFIG_KEY = id => 'guild:' + id + ':skaw_verification:config:v1';
const DATA_KEY = id => 'guild:' + id + ':skaw_verification:data:v1';
const BLUE = 0x1A9EF3;
const MAX_LOGS = 1000;
const queues = new Map();

export const DEFAULT_VERIFICATION_GUIDE = [
  '1. Tekan tombol Register pada panel verifikasi.',
  '2. Masukkan nama depan dan nama belakang karakter IC kamu.',
  '3. Pastikan penulisan nama sudah benar sebelum menekan Submit.',
  '4. Bot akan memvalidasi nama, memperbarui nickname, dan memberikan role Verified.',
  '',
  'Nama hanya boleh berisi huruf. Angka, spasi, dan simbol tidak diperbolehkan.',
  'Jika nama yang sama sudah digunakan anggota lain, bot akan memberikan peringatan. Registrasi tetap dapat dilanjutkan.',
  'Kamu dapat mengirim ulang formulir untuk memperbarui nama IC.',
].join('\n');

export const DEFAULT_VERIFICATION_CONFIG = Object.freeze({
  enabled: false,
  verificationChannelId: null,
  panelMessageId: null,
  verifiedRoleId: null,
  unverifiedRoleId: null,
  logChannelId: null,
  panelTitle: 'SKAW Group — Member Verification',
  panelDescription: 'Welcome to **SKAW Group**. Complete the registration below to verify your membership and access the community.',
  guideText: DEFAULT_VERIFICATION_GUIDE,
  imageUrl: null,
  nicknameFormat: '{first}_{last}',
});

function requirePersistentDatabase(client) {
  const db = client?.db;
  if (!db || typeof db.get !== 'function' || typeof db.set !== 'function') {
    throw new Error('Database SKAW Verification belum tersedia.');
  }
  const status = typeof db.getStatus === 'function' ? db.getStatus() : null;
  if (db.isDegraded?.() === true || status?.isDegraded === true) {
    throw new Error('SKAW Verification membutuhkan PostgreSQL aktif. Operasi dihentikan karena database sedang dalam mode in-memory.');
  }
}

function withGuildQueue(guildId, task) {
  const key = String(guildId);
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  queues.set(key, current);
  return current.finally(() => {
    if (queues.get(key) === current) queues.delete(key);
  });
}

function emptyStore() {
  return { version: 1, members: {}, nameIndex: {}, logs: [] };
}

async function readStore(client, guildId) {
  const raw = await client.db.get(DATA_KEY(guildId), null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyStore();
  return {
    version: 1,
    members: raw.members && typeof raw.members === 'object' ? raw.members : {},
    nameIndex: raw.nameIndex && typeof raw.nameIndex === 'object' ? raw.nameIndex : {},
    logs: Array.isArray(raw.logs) ? raw.logs : [],
  };
}

async function writeStore(client, guildId, store) {
  if (await client.db.set(DATA_KEY(guildId), store) === false) {
    throw new Error('PostgreSQL menolak penyimpanan data verifikasi.');
  }
}

export async function getSkawVerificationConfig(client, guildId) {
  requirePersistentDatabase(client);
  const raw = await client.db.get(CONFIG_KEY(guildId), null);
  return { ...DEFAULT_VERIFICATION_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
}

function cleanNamePart(value, label) {
  const cleaned = String(value ?? '').normalize('NFC').trim();
  if (!cleaned) throw new Error(label + ' wajib diisi.');
  if (cleaned.length > 32) throw new Error(label + ' maksimal 32 karakter.');
  if (!/^\p{L}[\p{L}\p{M}]*$/u.test(cleaned)) {
    throw new Error(label + ' hanya boleh berisi huruf. Angka, spasi, dan simbol tidak diperbolehkan.');
  }
  return cleaned;
}

export function validateICNamePart(value, label = 'Nama') {
  return cleanNamePart(value, label);
}

export function buildICNickname(firstName, lastName) {
  const first = cleanNamePart(firstName, 'Nama depan');
  const last = cleanNamePart(lastName, 'Nama belakang');
  const nickname = first + '_' + last;
  if (nickname.length > 32) throw new Error('Gabungan nama melebihi batas nickname Discord (32 karakter).');
  return nickname;
}

export function normalizeICNameKey(firstName, lastName) {
  return (String(firstName ?? '') + ' ' + String(lastName ?? ''))
    .normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('id-ID');
}

function makeLog(action, member, metadata = {}) {
  return {
    id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    action,
    userId: String(member.id),
    username: String(member.user?.tag || member.user?.username || member.displayName || 'Unknown'),
    displayName: String(member.displayName || member.user?.username || 'Unknown'),
    timestamp: new Date().toISOString(),
    ...metadata,
  };
}

function addLog(store, entry) {
  store.logs.push(entry);
  if (store.logs.length > MAX_LOGS) store.logs.splice(0, store.logs.length - MAX_LOGS);
}

function removeFromNameIndex(store, key, userId) {
  if (!key || !Array.isArray(store.nameIndex[key])) return;
  store.nameIndex[key] = store.nameIndex[key].filter(id => String(id) !== String(userId));
  if (!store.nameIndex[key].length) delete store.nameIndex[key];
}

function isTextChannel(channel) {
  return Boolean(channel?.isTextBased?.() && !channel.isDMBased?.() && channel.messages);
}

async function getBotMember(guild) {
  return guild.members.me || await guild.members.fetchMe().catch(() => null);
}

function assertManageRoles(botMember) {
  if (!botMember?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error('Bot membutuhkan permission Manage Roles.');
  }
}

function assertRoleAssignable(guild, botMember, role, label) {
  if (!role) throw new Error('Role ' + label + ' belum dipilih atau sudah dihapus.');
  if (role.id === guild.id || role.managed || role.editable === false) {
    throw new Error('Role ' + label + ' tidak dapat dikelola oleh bot.');
  }
  if (role.position >= botMember.roles.highest.position) {
    throw new Error('Posisi role bot harus lebih tinggi daripada role ' + label + '.');
  }
}

async function validateSetupRoles(guild, config) {
  const botMember = await getBotMember(guild);
  if (!botMember) throw new Error('Bot tidak dapat memeriksa role server.');
  assertManageRoles(botMember);
  if (!botMember.permissions.has(PermissionFlagsBits.ManageNicknames)) {
    throw new Error('Bot membutuhkan permission Manage Nicknames untuk mengatur nama IC otomatis.');
  }
  const verifiedRole = guild.roles.cache.get(String(config.verifiedRoleId));
  const unverifiedRole = guild.roles.cache.get(String(config.unverifiedRoleId));
  assertRoleAssignable(guild, botMember, verifiedRole, 'Verified');
  assertRoleAssignable(guild, botMember, unverifiedRole, 'Unverified');
  if (verifiedRole.id === unverifiedRole.id) throw new Error('Role Verified dan Unverified harus berbeda.');
  return { botMember, verifiedRole, unverifiedRole };
}

function assertPanelChannelPermissions(channel, botMember) {
  if (!isTextChannel(channel)) throw new Error('Channel verifikasi harus berupa channel teks.');
  const permissions = channel.permissionsFor(botMember);
  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
  ];
  if (!permissions?.has(required)) {
    throw new Error('Bot membutuhkan View Channel, Send Messages, Embed Links, dan Read Message History di channel verifikasi.');
  }
}

export async function configureSkawVerification(client, guild, input) {
  requirePersistentDatabase(client);
  const verifiedRoleId = String(input.verifiedRoleId || '');
  const unverifiedRoleId = String(input.unverifiedRoleId || '');
  const channelId = String(input.channelId || '');
  if (!verifiedRoleId || !unverifiedRoleId || !channelId) {
    throw new Error('Channel verifikasi, role Verified, dan role Unverified wajib ditentukan.');
  }
  const previousConfig = await getSkawVerificationConfig(client, guild.id);
  const panelTitle = input.panelTitle === undefined
    ? previousConfig.panelTitle
    : String(input.panelTitle).trim().slice(0, 256);
  const panelDescription = input.panelDescription === undefined
    ? previousConfig.panelDescription
    : String(input.panelDescription).trim().slice(0, 1000);
  const guideText = input.guideText === undefined
    ? previousConfig.guideText
    : String(input.guideText).trim().slice(0, 4000);
  let imageUrl = previousConfig.imageUrl;
  if (input.imageUrl !== undefined) {
    const candidate = String(input.imageUrl || '').trim();
    if (!candidate) {
      imageUrl = null;
    } else {
      let parsed;
      try { parsed = new URL(candidate); } catch { throw new Error('Image URL tidak valid. Gunakan URL HTTPS langsung ke gambar.'); }
      if (parsed.protocol !== 'https:') throw new Error('Image URL harus menggunakan HTTPS.');
      imageUrl = candidate;
    }
  }
  const nextConfig = {
    ...previousConfig,
    enabled: true,
    verifiedRoleId,
    unverifiedRoleId,
    verificationChannelId: channelId,
    logChannelId: input.logChannelId === undefined
      ? previousConfig.logChannelId
      : (input.logChannelId ? String(input.logChannelId) : null),
    panelTitle: panelTitle || DEFAULT_VERIFICATION_CONFIG.panelTitle,
    panelDescription: panelDescription || DEFAULT_VERIFICATION_CONFIG.panelDescription,
    guideText: guideText || DEFAULT_VERIFICATION_GUIDE,
    imageUrl,
  };
  if (previousConfig.verificationChannelId !== channelId) nextConfig.panelMessageId = null;
  const { botMember } = await validateSetupRoles(guild, nextConfig);
  const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
  assertPanelChannelPermissions(channel, botMember);
  if (nextConfig.logChannelId) {
    const logChannel = guild.channels.cache.get(nextConfig.logChannelId) ||
      await guild.channels.fetch(nextConfig.logChannelId).catch(() => null);
    if (!isTextChannel(logChannel) || !logChannel.permissionsFor(botMember)?.has([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
    ])) {
      throw new Error('Bot membutuhkan View Channel, Send Messages, dan Embed Links di Log Channel.');
    }
  }
  if (await client.db.set(CONFIG_KEY(guild.id), nextConfig) === false) {
    throw new Error('Tidak dapat menyimpan konfigurasi verifikasi ke PostgreSQL.');
  }
  return nextConfig;
}

export function buildVerificationPanelPayload(config) {
  const embed = new EmbedBuilder()
    .setColor(BLUE)
    .setAuthor({ name: 'SKAW GROUP · COMMUNITY' })
    .setTitle(config.panelTitle || DEFAULT_VERIFICATION_CONFIG.panelTitle)
    .setDescription([
      config.panelDescription || DEFAULT_VERIFICATION_CONFIG.panelDescription,
      '',
      '**Registration Steps**',
      '1. Tekan tombol Register.',
      '2. Isi nama depan dan nama belakang karakter IC.',
      '3. Submit formulir untuk menyelesaikan verifikasi.',
      '',
      'Pastikan data yang kamu masukkan benar. Nickname Discord akan diperbarui otomatis.',
    ].join('\n'))
    .setFooter({ text: 'RIGHT SOLUTION, GREAT QUALITY · SKAW VERIFICATION' });
  if (config.imageUrl && /^https?:\/\/\S+$/i.test(config.imageUrl)) embed.setImage(config.imageUrl);
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('skaw_vf_register').setLabel('Register').setEmoji('📝').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('skaw_vf_guide').setLabel('Panduan').setEmoji('📚').setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

export function buildVerificationGuideEmbed(config = DEFAULT_VERIFICATION_CONFIG) {
  return new EmbedBuilder()
    .setColor(BLUE)
    .setAuthor({ name: 'SKAW GROUP · REGISTRATION GUIDE' })
    .setTitle('Panduan Registrasi Member')
    .setDescription(config.guideText || DEFAULT_VERIFICATION_GUIDE)
    .setFooter({ text: 'SKAW VERIFICATION · Nama IC harus sesuai karakter kamu.' });
}

function buildRegistrationModal(existingRecord = null) {
  const firstInput = new TextInputBuilder()
    .setCustomId('first_name').setLabel('Nama Depan IC').setPlaceholder('Contoh: Vicenzo')
    .setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(32).setRequired(true);
  const lastInput = new TextInputBuilder()
    .setCustomId('last_name').setLabel('Nama Belakang IC').setPlaceholder('Contoh: Alejandro')
    .setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(32).setRequired(true);
  if (existingRecord?.firstName) firstInput.setValue(String(existingRecord.firstName).slice(0, 32));
  if (existingRecord?.lastName) lastInput.setValue(String(existingRecord.lastName).slice(0, 32));
  return new ModalBuilder()
    .setCustomId('skaw_vf_registration')
    .setTitle(existingRecord?.status === 'verified' ? 'Perbarui Nama IC' : 'Formulir Registrasi')
    .addComponents(new ActionRowBuilder().addComponents(firstInput), new ActionRowBuilder().addComponents(lastInput));
}

export async function handleVerificationButton(interaction, client, action) {
  if (!interaction.inGuild?.() || !interaction.guild) {
    return interaction.reply({ content: 'Verifikasi hanya dapat digunakan di dalam server.', flags: MessageFlags.Ephemeral });
  }
  const config = await getSkawVerificationConfig(client, interaction.guildId);
  if (!config.enabled) {
    return interaction.reply({ content: 'Sistem verifikasi SKAW belum diaktifkan. Hubungi administrator.', flags: MessageFlags.Ephemeral });
  }
  if (action === 'guide') {
    return interaction.reply({
      embeds: [buildVerificationGuideEmbed(config)],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  if (action !== 'register') return;
  const store = await readStore(client, interaction.guildId);
  const existing = store.members[String(interaction.user.id)] || null;
  return interaction.showModal(buildRegistrationModal(existing));
}

function assertMemberCanBeNicknamed(guild, botMember, member) {
  if (!botMember.permissions.has(PermissionFlagsBits.ManageNicknames)) {
    throw new Error('Bot membutuhkan permission Manage Nicknames.');
  }
  if (member.id === guild.ownerId || member.manageable === false) {
    throw new Error('Bot tidak dapat mengubah nickname anggota ini karena batasan kepemilikan atau hierarki role.');
  }
  if (member.roles?.highest && member.roles.highest.position >= botMember.roles.highest.position) {
    throw new Error('Role anggota berada di atas atau sejajar dengan role tertinggi bot. Nickname tidak dapat diubah.');
  }
}

async function postVerificationStaffLog(client, guild, config, entry) {
  if (!config.logChannelId) return;
  try {
    const channel = guild.channels.cache.get(config.logChannelId) || await guild.channels.fetch(config.logChannelId).catch(() => null);
    const botMember = await getBotMember(guild);
    if (!isTextChannel(channel) || !channel.permissionsFor(botMember)?.has([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
    ])) return;
    const embed = new EmbedBuilder()
      .setColor(entry.duplicateWarning ? 0xF0B429 : BLUE)
      .setTitle(entry.action === 'registration_updated' ? 'IC Name Updated' : 'Member Verified')
      .setDescription('Member: <@' + entry.userId + '>\nIC Name: ' + entry.icName + '\nNickname: ' + entry.nickname)
      .addFields(
        { name: 'Source', value: entry.source || 'self-service', inline: true },
        { name: 'Duplicate Name', value: entry.duplicateWarning ? 'Warning — ' + entry.duplicateUserIds.length + ' existing member(s)' : 'No', inline: true },
      )
      .setTimestamp(new Date(entry.timestamp))
      .setFooter({ text: 'SKAW VERIFICATION LOG' });
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    logger.warn('Could not send SKAW verification staff log:', error?.message || error);
  }
}

export async function registerSkawMember(client, guild, member, input, options = {}) {
  requirePersistentDatabase(client);
  const firstName = cleanNamePart(input.firstName, 'Nama depan');
  const lastName = cleanNamePart(input.lastName, 'Nama belakang');
  const nickname = buildICNickname(firstName, lastName);
  const nameKey = normalizeICNameKey(firstName, lastName);
  const config = await getSkawVerificationConfig(client, guild.id);
  if (!config.enabled) throw new Error('Sistem verifikasi SKAW belum diaktifkan.');

  return withGuildQueue(guild.id, async () => {
    const { botMember, verifiedRole, unverifiedRole } = await validateSetupRoles(guild, config);
    assertMemberCanBeNicknamed(guild, botMember, member);
    const store = await readStore(client, guild.id);
    const userId = String(member.id);
    const previousRecord = store.members[userId] || null;
    const duplicateUserIds = Array.isArray(store.nameIndex[nameKey])
      ? store.nameIndex[nameKey].filter(id => String(id) !== userId)
      : [];
    const duplicateWarning = duplicateUserIds.length > 0;
    const previousNickname = member.nickname ?? null;
    const hadVerifiedRole = member.roles.cache.has(verifiedRole.id);
    const hadUnverifiedRole = member.roles.cache.has(unverifiedRole.id);
    let nicknameChanged = false;
    let verifiedAdded = false;
    let unverifiedRemoved = false;

    try {
      if (member.nickname !== nickname) {
        await member.setNickname(nickname, 'SKAW Verification: IC name registration');
        nicknameChanged = true;
      }
      if (!hadVerifiedRole) {
        await member.roles.add(verifiedRole.id, 'SKAW Verification: registration completed');
        verifiedAdded = true;
      }
      if (hadUnverifiedRole) {
        await member.roles.remove(unverifiedRole.id, 'SKAW Verification: registration completed');
        unverifiedRemoved = true;
      }

      if (previousRecord?.nameKey) removeFromNameIndex(store, previousRecord.nameKey, userId);
      const timestamp = new Date().toISOString();
      const record = {
        guildId: String(guild.id), userId, firstName, lastName,
        icName: firstName + ' ' + lastName,
        nickname, nameKey, status: 'verified',
        firstVerifiedAt: previousRecord?.firstVerifiedAt || timestamp,
        lastVerifiedAt: timestamp,
        registrationCount: (Number(previousRecord?.registrationCount) || 0) + 1,
        source: options.source || 'self-service',
        updatedBy: options.actorId ? String(options.actorId) : userId,
        duplicateWarning, duplicateUserIds,
        createdAt: previousRecord?.createdAt || timestamp,
        updatedAt: timestamp,
      };
      store.members[userId] = record;
      store.nameIndex[nameKey] = [...new Set([...(store.nameIndex[nameKey] || []), userId])];
      const action = previousRecord ? 'registration_updated' : 'registration_created';
      const log = makeLog(action, member, {
        firstName, lastName, icName: record.icName, nickname,
        source: record.source, actorId: record.updatedBy,
        duplicateWarning, duplicateUserIds, timestamp,
      });
      addLog(store, log);
      await writeStore(client, guild.id, store);

      await postVerificationStaffLog(client, guild, config, {
        ...log, action, userId, icName: record.icName, nickname,
        source: record.source, timestamp, duplicateWarning, duplicateUserIds,
      });
      return { record, duplicateWarning, duplicateUserIds, updated: Boolean(previousRecord) };
    } catch (error) {
      const rollbackErrors = [];
      if (unverifiedRemoved) await member.roles.add(unverifiedRole.id, 'SKAW Verification rollback').catch(e => rollbackErrors.push(e));
      if (verifiedAdded) await member.roles.remove(verifiedRole.id, 'SKAW Verification rollback').catch(e => rollbackErrors.push(e));
      if (nicknameChanged) await member.setNickname(previousNickname, 'SKAW Verification rollback').catch(e => rollbackErrors.push(e));
      if (rollbackErrors.length) {
        logger.error('SKAW Verification rollback was incomplete', {
          guildId: guild.id, userId, errors: rollbackErrors.map(item => item?.message || String(item)),
        });
      }
      throw new Error(
        'Registrasi belum dapat diselesaikan. Tidak ada status Verified yang disimpan. ' +
        (rollbackErrors.length ? 'Pemulihan otomatis tidak sepenuhnya berhasil; administrator perlu memeriksa role dan nickname member. ' : '') +
        (error?.message || 'Unknown error'),
      );
    }
  });
}

export async function handleVerificationModal(interaction, client) {
  if (!interaction.guild || !interaction.guildId) {
    return interaction.reply({ content: 'Formulir ini hanya dapat digunakan di dalam server.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const result = await registerSkawMember(client, interaction.guild, member, {
      firstName: interaction.fields.getTextInputValue('first_name'),
      lastName: interaction.fields.getTextInputValue('last_name'),
    }, { source: 'self-service', actorId: interaction.user.id });

    const embed = new EmbedBuilder()
      .setColor(result.duplicateWarning ? 0xF0B429 : 0x22C55E)
      .setAuthor({ name: 'SKAW GROUP · MEMBER VERIFICATION' })
      .setTitle(result.updated ? 'Registration Updated' : 'Registration Accepted')
      .setDescription(
        (result.updated ? 'Data karakter IC kamu berhasil diperbarui.' : 'Registrasi keanggotaan kamu berhasil diselesaikan.') +
        '\n\nNama IC\n' + result.record.icName +
        '\n\nDiscord Nickname\n' + result.record.nickname
      )
      .setFooter({ text: 'RIGHT SOLUTION, GREAT QUALITY' })
      .setTimestamp();
    if (result.duplicateWarning) {
      embed.addFields({
        name: 'Duplicate Name Warning',
        value: 'Nama IC ini sudah terdaftar pada ' + result.duplicateUserIds.length +
          ' akun lain. Registrasi tetap berhasil sesuai kebijakan server.',
      });
    }
    return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    return interaction.editReply({
      content: '❌ Registrasi belum berhasil.\n' + String(error?.message || 'Terjadi kesalahan. Silakan coba kembali.').slice(0, 1500),
      embeds: [], allowedMentions: { parse: [] },
    });
  }
}

export async function publishSkawVerificationPanel(client, guild) {
  requirePersistentDatabase(client);
  const config = await getSkawVerificationConfig(client, guild.id);
  if (!config.enabled) throw new Error('Jalankan /verification setup terlebih dahulu.');
  const { botMember } = await validateSetupRoles(guild, config);
  const channel = guild.channels.cache.get(config.verificationChannelId) ||
    await guild.channels.fetch(config.verificationChannelId).catch(() => null);
  assertPanelChannelPermissions(channel, botMember);

  let message = config.panelMessageId ? await channel.messages.fetch(config.panelMessageId).catch(() => null) : null;
  const payload = buildVerificationPanelPayload(config);
  if (message) await message.edit(payload);
  else message = await channel.send(payload);

  const nextConfig = { ...config, panelMessageId: String(message.id) };
  if (await client.db.set(CONFIG_KEY(guild.id), nextConfig) === false) {
    throw new Error('Panel sudah diterbitkan, tetapi ID pesannya gagal disimpan. Periksa channel lalu jalankan publish kembali.');
  }
  return { channel, message, config: nextConfig };
}

export async function applyUnverifiedRoleOnJoin(client, guild, member) {
  let configured = false;
  try {
    requirePersistentDatabase(client);
    const config = await getSkawVerificationConfig(client, guild.id);
    if (!config.enabled) return { configured: false };
    configured = true;
    if (member.roles.cache.has(String(config.verifiedRoleId))) return { configured: true, alreadyVerified: true };
    const unverifiedRole = guild.roles.cache.get(String(config.unverifiedRoleId)) ||
      await guild.roles.fetch(String(config.unverifiedRoleId)).catch(() => null);
    const botMember = await getBotMember(guild);
    assertManageRoles(botMember);
    assertRoleAssignable(guild, botMember, unverifiedRole, 'Unverified');
    if (!member.roles.cache.has(unverifiedRole.id)) {
      await member.roles.add(unverifiedRole.id, 'SKAW Verification: new member restriction');
    }
    return { configured: true, assigned: true, roleId: unverifiedRole.id };
  } catch (error) {
    logger.error('Could not assign SKAW Unverified role on member join', {
      guildId: guild.id, userId: member.id, configured, error: error?.message || error,
    });
    return { configured, assigned: false, error: error?.message || String(error) };
  }
}

export async function resetSkawVerification(client, guild, member, actorId) {
  requirePersistentDatabase(client);
  const config = await getSkawVerificationConfig(client, guild.id);
  if (!config.enabled) throw new Error('Sistem verifikasi SKAW belum diaktifkan.');
  return withGuildQueue(guild.id, async () => {
    const { verifiedRole, unverifiedRole } = await validateSetupRoles(guild, config);
    const hadVerifiedRole = member.roles.cache.has(verifiedRole.id);
    const hadUnverifiedRole = member.roles.cache.has(unverifiedRole.id);
    let unverifiedAdded = false;
    let verifiedRemoved = false;
    try {
      if (!hadUnverifiedRole) {
        await member.roles.add(unverifiedRole.id, 'SKAW Verification reset by ' + actorId);
        unverifiedAdded = true;
      }
      if (hadVerifiedRole) {
        await member.roles.remove(verifiedRole.id, 'SKAW Verification reset by ' + actorId);
        verifiedRemoved = true;
      }
      const store = await readStore(client, guild.id);
      const userId = String(member.id);
      const previous = store.members[userId] || null;
      if (previous) {
        store.members[userId] = { ...previous, status: 'pending', resetAt: new Date().toISOString(), resetBy: String(actorId) };
      }
      addLog(store, makeLog('verification_reset', member, {
        actorId: String(actorId), icName: previous?.icName || null, timestamp: new Date().toISOString(),
      }));
      await writeStore(client, guild.id, store);
      return { userId, previous, verifiedRole, unverifiedRole };
    } catch (error) {
      if (verifiedRemoved) await member.roles.add(verifiedRole.id, 'SKAW Verification reset rollback').catch(() => {});
      if (unverifiedAdded) await member.roles.remove(unverifiedRole.id, 'SKAW Verification reset rollback').catch(() => {});
      throw new Error('Reset verifikasi gagal. Perubahan role yang sempat diterapkan telah dipulihkan bila memungkinkan. ' + (error?.message || 'Unknown error'));
    }
  });
}

export async function getSkawVerificationLogs(client, guildId, limit = 10) {
  requirePersistentDatabase(client);
  const store = await readStore(client, guildId);
  return store.logs.slice(-Math.max(1, Math.min(25, Number(limit) || 10))).reverse();
}

export async function getSkawVerificationMemberRecord(client, guildId, userId) {
  requirePersistentDatabase(client);
  const store = await readStore(client, guildId);
  return store.members[String(userId)] || null;
}

export function formatVerificationLogTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Waktu tidak tersedia';
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short',
  }).format(date) + ' WIB';
}

export function buildVerificationStatusEmbed(guild, config) {
  const roleName = id => guild.roles.cache.get(String(id))?.name || 'Tidak ditemukan';
  return new EmbedBuilder()
    .setColor(config.enabled ? 0x22C55E : 0xEF4444)
    .setTitle('SKAW Verification · System Status')
    .addFields(
      { name: 'Status', value: config.enabled ? 'Enabled' : 'Disabled', inline: true },
      { name: 'Verified Role', value: roleName(config.verifiedRoleId), inline: true },
      { name: 'Unverified Role', value: roleName(config.unverifiedRoleId), inline: true },
      { name: 'Verification Channel', value: config.verificationChannelId ? '<#' + config.verificationChannelId + '>' : 'Belum diatur', inline: true },
      { name: 'Log Channel', value: config.logChannelId ? '<#' + config.logChannelId + '>' : 'Belum diatur', inline: true },
      { name: 'Panel Message', value: config.panelMessageId ? 'Published' : 'Not published', inline: true },
    )
    .setFooter({ text: 'SKAW GROUP · VERIFICATION MANAGER' })
    .setTimestamp();
}

export function buildVerificationLogsEmbed(entries) {
  const lines = entries.map(entry => {
    const action = entry.action === 'registration_created'
      ? '✅ Registrasi baru'
      : entry.action === 'registration_updated'
        ? '✏️ Pembaruan nama IC'
        : entry.action === 'verification_reset'
          ? '↩️ Reset verifikasi'
          : entry.action;
    return [
      '**' + action + '**',
      'Member: <@' + entry.userId + '> · ' + entry.userId,
      'Nama IC: **' + (entry.icName || '—') + '**',
      'Waktu: ' + formatVerificationLogTimestamp(entry.timestamp),
      entry.duplicateWarning ? '⚠️ Nama IC terdeteksi duplikat' : '',
    ].filter(Boolean).join('\n');
  });
  return new EmbedBuilder()
    .setColor(BLUE)
    .setTitle('SKAW Verification · Activity Logs')
    .setDescription(lines.join('\n\n').slice(0, 4000) || 'Belum ada aktivitas verifikasi.')
    .setFooter({ text: 'Asia/Jakarta (WIB) · Menampilkan ' + entries.length + ' aktivitas' })
    .setTimestamp();
}
