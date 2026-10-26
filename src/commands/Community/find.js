import { EmbedBuilder, MessageFlags, SlashCommandBuilder, escapeMarkdown } from 'discord.js';
import {
    ensureEmployeeDirectoryBackfilled,
} from '../../services/employeeLogsService.js';
import {
    formatDirectoryTimestamp,
    getEmployeeDirectoryIndex,
    getEmployeeDirectoryRecord,
    parseDiscordUserId,
    refreshEmployeeDirectoryDisplayName,
    searchEmployeeDirectory,
} from '../../services/employeeDirectoryService.js';
import { SKAW_EMPLOYEE_ROLE_CATALOG } from '../../services/employeeLogsAutoRoleService.js';

const BLACKLIST_ROLE_ID = '1414628838557614222';
const RETIRED_ROLE_ID = '1429469335654633593';
const CIVILIAN_ROLE_ID = '1415329997396119603';
const WARNING_ROLE_IDS = new Set(['1429470453575061515', '1429470577286189176']);
const COLORS = Object.freeze({ active: 0x16a34a, former: 0x64748b, incomplete: 0xd97706, notRegistered: 0x64748b });

function normalizeText(value) {
    return String(value ?? '').trim().toLocaleLowerCase('en-US').normalize('NFKC');
}

function safeText(value, max = 500) {
    return escapeMarkdown(String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max));
}

function safeDate(value) {
    return value ? formatDirectoryTimestamp(value) : 'Not recorded';
}

function getLiveMemberInfo(member) {
    if (!member) return { position: null, isBlacklisted: false, isRetired: false, hasWarning: false, isEmployeeCandidate: false };
    const roleIds = [...(member.roles?.cache?.keys?.() || [])].map(String);
    const positions = roleIds
        .map(id => ({ id, meta: SKAW_EMPLOYEE_ROLE_CATALOG[id], role: member.guild?.roles?.cache?.get?.(id) }))
        .filter(item => item.meta?.active === true && item.meta.position !== false)
        .sort((a, b) => (b.meta.level ?? 0) - (a.meta.level ?? 0));
    const position = positions[0]
        ? {
            id: positions[0].id,
            name: String(positions[0].role?.name || positions[0].meta?.name || `<@&${positions[0].id}>`),
        }
        : null;
    const isBlacklisted = roleIds.includes(BLACKLIST_ROLE_ID);
    const isRetired = roleIds.includes(RETIRED_ROLE_ID);
    const hasWarning = roleIds.some(id => WARNING_ROLE_IDS.has(id));
    const hasOtherEmployeeRole = roleIds.some(id => {
        const meta = SKAW_EMPLOYEE_ROLE_CATALOG[id];
        return meta && id !== CIVILIAN_ROLE_ID && (meta.active === true || meta.kind === 'retired' || meta.kind === 'blacklist' || meta.kind === 'warning');
    });
    return {
        position,
        isBlacklisted,
        isRetired,
        hasWarning,
        isEmployeeCandidate: Boolean(position || isBlacklisted || isRetired || hasWarning || hasOtherEmployeeRole),
    };
}

function getStatus(record, liveInfo) {
    if (liveInfo.position) return record?.firstSignInAt ? 'ACTIVE' : 'INCOMPLETE RECORD';
    if (record?.status === 'former') return 'FORMER EMPLOYEE';
    if (record?.status === 'active') return 'INCOMPLETE RECORD';
    if (record || liveInfo.isEmployeeCandidate) return 'INCOMPLETE RECORD';
    return 'NOT REGISTERED';
}

function roleValue(position, preferMention = false) {
    if (!position) return 'Not recorded';
    if (preferMention && /^\d{17,20}$/.test(String(position.id || ''))) return `<@&${position.id}>`;
    if (/^<@&\d{17,20}>$/.test(String(position.name || ''))) return position.name;
    return safeText(position.name || 'Not recorded', 200);
}

function buildNotRegisteredEmbed(query) {
    return new EmbedBuilder()
        .setColor(COLORS.notRegistered)
        .setAuthor({ name: 'SKAW GROUP · PEOPLE OPERATIONS' })
        .setTitle('SKAW EMPLOYEE PROFILE')
        .setDescription([
            '**SEARCH QUERY**',
            safeText(query, 100),
            '',
            '**STATUS**',
            'NOT REGISTERED',
            '',
            'No employee record was found in SKAW Employee Logs.',
        ].join('\n'))
        .setFooter({ text: 'EMPLOYEE DIRECTORY · PRIVATE RESULT' });
}

function buildAmbiguousEmbed(query, matches) {
    const lines = matches.slice(0, 10).map((record, index) => {
        const status = record.status === 'active' ? 'ACTIVE'
            : record.status === 'former' ? 'FORMER EMPLOYEE'
                : 'INCOMPLETE RECORD';
        return `**${index + 1}. ${safeText(record.displayName, 80)}** (<@${record.userId}>)\n-# ${status} · ID: ${record.userId}`;
    });
    return new EmbedBuilder()
        .setColor(0x2563eb)
        .setAuthor({ name: 'SKAW GROUP · PEOPLE OPERATIONS' })
        .setTitle('MULTIPLE EMPLOYEES FOUND')
        .setDescription([
            `More than one record matches **${safeText(query, 100)}**.`,
            'Select the correct person from the command autocomplete list, or search using their Discord User ID.',
            '',
            ...lines,
        ].join('\n'))
        .setFooter({ text: 'EMPLOYEE DIRECTORY · PRIVATE RESULT' });
}

function buildProfileEmbed(record, member, query) {
    const liveInfo = getLiveMemberInfo(member);
    const status = getStatus(record, liveInfo);
    const isActive = status === 'ACTIVE';
    const isFormer = status === 'FORMER EMPLOYEE';
    const displayName = member?.displayName || record?.displayName || 'Unknown member';
    const userId = String(record?.userId || member?.id || parseDiscordUserId(query) || '');
    const currentPosition = liveInfo.position || (status === 'ACTIVE' ? record?.currentPosition : null);
    const lastPosition = record?.lastKnownPosition || record?.currentPosition || null;
    const position = liveInfo.position || (isActive ? currentPosition : lastPosition);
    const hasLivePosition = Boolean(liveInfo.position);

    let blacklistStatus = 'No recorded blacklist';
    if (liveInfo.isBlacklisted) blacklistStatus = 'Currently blacklisted';
    else if (record?.everBlacklisted) blacklistStatus = 'Previously blacklisted';
    else if (!record && status === 'INCOMPLETE RECORD') blacklistStatus = 'No blacklist record';

    const statusColor = isActive ? COLORS.active
        : isFormer ? COLORS.former
            : COLORS.incomplete;
    const fields = [
        { name: 'EMPLOYMENT STATUS', value: status, inline: true },
        { name: hasLivePosition || isActive ? 'CURRENT POSITION' : isFormer ? 'LAST KNOWN POSITION' : 'LAST RECORDED POSITION', value: roleValue(position, hasLivePosition || isActive), inline: true },
        { name: 'FIRST SIGN-IN', value: safeDate(record?.firstSignInAt), inline: true },
        { name: 'LAST SIGN-IN', value: safeDate(record?.lastSignInAt), inline: true },
        { name: 'LAST SIGN-OUT', value: safeDate(record?.lastSignOutAt), inline: true },
        { name: 'BLACKLIST STATUS', value: blacklistStatus, inline: true },
    ];
    if (isFormer) {
        fields.push({
            name: record?.lastExitType === 'resignation' ? 'RESIGNATION REASON'
                : record?.lastExitType === 'dismissal' ? 'DISMISSAL REASON'
                    : 'SIGN-OUT REASON',
            value: record?.lastSignOutReason ? safeText(record.lastSignOutReason, 900) : 'Not recorded',
            inline: false,
        });
    }

    return new EmbedBuilder()
        .setColor(statusColor)
        .setAuthor({ name: 'SKAW GROUP · PEOPLE OPERATIONS' })
        .setTitle('SKAW EMPLOYEE PROFILE')
        .setDescription([
            '**EMPLOYEE**',
            `${safeText(displayName, 100)}${userId ? ` (**<@${userId}>**)` : ''}`,
            '',
            record?.history?.length ? `-# Employee record history: ${record.history.length} recent event(s)` : '-# Employee record history is incomplete or unavailable',
        ].join('\n'))
        .addFields(fields)
        .setFooter({ text: 'EMPLOYEE DIRECTORY · PRIVATE RESULT' });
}

async function fetchMember(guild, userId) {
    if (!guild || !/^\d{17,20}$/.test(String(userId || ''))) return null;
    return guild.members?.cache?.get?.(String(userId))
        || await guild.members?.fetch?.(String(userId)).catch(() => null)
        || null;
}

function getCachedEmployeeMembers(guild, query) {
    const needle = normalizeText(query);
    if (!guild?.members?.cache || !needle) return [];
    return [...guild.members.cache.values()].filter(member => {
        const info = getLiveMemberInfo(member);
        return info.isEmployeeCandidate && normalizeText(member.displayName).includes(needle);
    });
}

async function getProfileForQuery(interaction, query) {
    const guildId = interaction.guildId;
    const directId = parseDiscordUserId(query);
    if (directId) {
        let record = await getEmployeeDirectoryRecord(interaction.client, guildId, directId);
        const member = await fetchMember(interaction.guild, directId);
        const liveInfo = getLiveMemberInfo(member);
        if (record) {
            if (member?.displayName) {
                record = await refreshEmployeeDirectoryDisplayName(interaction.client, guildId, directId, member.displayName) || record;
            }
            return { record, member };
        }
        if (member && liveInfo.isEmployeeCandidate) return { record: null, member };
        return { notRegistered: true, query };
    }

    const matches = await searchEmployeeDirectory(interaction.client, guildId, query, { limit: 25 });
    const needle = normalizeText(query);
    const exactMatches = matches.filter(item => normalizeText(item.displayName) === needle);
    if (exactMatches.length === 1) {
        const record = exactMatches[0];
        const member = await fetchMember(interaction.guild, record.userId);
        const refreshed = member?.displayName
            ? await refreshEmployeeDirectoryDisplayName(interaction.client, guildId, record.userId, member.displayName)
            : null;
        return { record: refreshed || record, member };
    }
    if (matches.length === 1) {
        const record = matches[0];
        const member = await fetchMember(interaction.guild, record.userId);
        const refreshed = member?.displayName
            ? await refreshEmployeeDirectoryDisplayName(interaction.client, guildId, record.userId, member.displayName)
            : null;
        return { record: refreshed || record, member };
    }
    if (matches.length > 1) return { ambiguous: true, matches, query };

    const liveMatches = getCachedEmployeeMembers(interaction.guild, query);
    if (liveMatches.length === 1) {
        const member = liveMatches[0];
        let record = await getEmployeeDirectoryRecord(interaction.client, guildId, member.id);
        if (record) {
            record = await refreshEmployeeDirectoryDisplayName(interaction.client, guildId, member.id, member.displayName) || record;
        }
        return { record, member };
    }
    if (liveMatches.length > 1) {
        return {
            ambiguous: true,
            matches: liveMatches.map(member => ({ userId: member.id, displayName: member.displayName, status: 'unknown' })),
            query,
        };
    }
    return { notRegistered: true, query };
}

function autocompleteStatus(record) {
    return record?.status === 'active' ? 'ACTIVE'
        : record?.status === 'former' ? 'FORMER'
            : 'INCOMPLETE';
}

async function buildAutocompleteChoices(interaction, focused) {
    const guildId = interaction.guildId;
    const needle = normalizeText(focused);
    const choices = new Map();
    if (String(focused || '').trim()) {
        const rawQuery = String(focused).trim().slice(0, 100);
        choices.set(rawQuery, { name: `Search text: ${rawQuery}`.slice(0, 100), value: rawQuery });
    }

    try {
        const index = await getEmployeeDirectoryIndex(interaction.client, guildId);
        const indexed = index
            .filter(item => !needle || normalizeText(item.displayName).includes(needle))
            .sort((a, b) => {
                const exact = Number(normalizeText(b.displayName) === needle) - Number(normalizeText(a.displayName) === needle);
                return exact || String(a.displayName).localeCompare(String(b.displayName), 'en', { sensitivity: 'base' });
            });
        for (const item of indexed) {
            if (choices.size >= 25) break;
            choices.set(String(item.userId), {
                name: `${item.displayName || 'Unknown member'} — ${autocompleteStatus(item)}`.slice(0, 100),
                value: String(item.userId),
            });
        }
    } catch (error) {
        console.warn('[Employee Directory] Autocomplete index lookup failed:', error?.message || error);
    }

    const liveMembers = [...(interaction.guild?.members?.cache?.values?.() || [])]
        .filter(member => getLiveMemberInfo(member).isEmployeeCandidate)
        .filter(member => !needle || normalizeText(member.displayName).includes(needle))
        .sort((a, b) => String(a.displayName).localeCompare(String(b.displayName), 'en', { sensitivity: 'base' }));
    for (const member of liveMembers) {
        if (choices.size >= 25) break;
        const id = String(member.id);
        if (choices.has(id)) continue;
        choices.set(id, {
            name: `${member.displayName || 'Unknown member'} — INCOMPLETE`.slice(0, 100),
            value: id,
        });
    }
    return [...choices.values()].slice(0, 25);
}

export default {
    category: 'Community',
    data: new SlashCommandBuilder()
        .setName('find')
        .setDescription('Search SKAW employee records privately.')
        .addStringOption(option => option
            .setName('employee')
            .setDescription('Search by server display name, pasted mention, or Discord User ID.')
            .setRequired(false)
            .setAutocomplete(true))
        .addUserOption(option => option
            .setName('user')
            .setDescription('Select a Discord account directly using the user picker.')
            .setRequired(false)),

    async autocomplete(interaction) {
        try {
            const focused = interaction.options.getFocused() || '';
            const choices = await buildAutocompleteChoices(interaction, focused);
            return interaction.respond(choices);
        } catch (error) {
            console.error('[Employee Directory] Autocomplete failed:', error?.message || error);
            return interaction.respond([]).catch(() => {});
        }
    },

    async execute(interaction) {
        if (!interaction.inGuild?.() || !interaction.guildId) {
            return interaction.reply({
                content: 'This command can only be used inside the SKAW Discord server.',
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
        }

        // Discord cannot make one slash-command option act as both free text and a User picker.
        // Keep the existing autocomplete text option and add a separate User option.
        const employeeQuery = String(interaction.options.getString('employee', false) ?? '').trim();
        const selectedUser = interaction.options.getUser?.('user', false) ?? null;

        if (employeeQuery && selectedUser) {
            return interaction.reply({
                content: 'Please use only one search option: `employee` for a name/mention/User ID, or `user` to select a Discord account.',
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
        }
        if (!employeeQuery && !selectedUser) {
            return interaction.reply({
                content: 'Choose a person using `employee` (name, mention, or User ID) or select an account with `user`.',
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
        }

        const query = selectedUser ? String(selectedUser.id) : employeeQuery;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            await ensureEmployeeDirectoryBackfilled(interaction.client, interaction.guild);
            const result = await getProfileForQuery(interaction, query);
            let embed;
            if (result.notRegistered) {
                embed = buildNotRegisteredEmbed(result.query);
            } else if (result.ambiguous) {
                embed = buildAmbiguousEmbed(result.query, result.matches);
            } else {
                embed = buildProfileEmbed(result.record, result.member, query);
            }
            return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
        } catch (error) {
            console.error('[Employee Directory] /find failed:', error?.stack || error);
            return interaction.editReply({
                content: 'Employee directory is temporarily unavailable. Please try again later.',
                embeds: [],
                allowedMentions: { parse: [] },
            });
        }
    },
};
