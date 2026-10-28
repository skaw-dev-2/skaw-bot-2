import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import {
  buildRoleAssignmentPlan, canManageRoleTemplates, getRoleHierarchyViolations,
  getRoleTemplateConfig, getRoleTemplateBySlug,
} from '../../services/roleTemplateService.js';

async function prepareGuildRoles(guild) {
  await guild.members.fetchMe().catch(() => null);
  await guild.roles.fetch().catch(() => null);
}
function ephemeral(content) {
  return { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
}

export default {
  data: new SlashCommandBuilder()
    .setName('role')
    .setDescription('Assign an enabled role template to a member')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option
      .setName('template')
      .setDescription('The enabled role template to apply')
      .setRequired(true)
      .setAutocomplete(true))
    .addUserOption(option => option
      .setName('member')
      .setDescription('Member who will receive the template roles')
      .setRequired(true))
    .addRoleOption(option => option
      .setName('workshop')
      .setDescription('Optional workshop placement role for a Mechanic')
      .setRequired(false)),

  async autocomplete(interaction, client) {
    try {
      if (!interaction.guildId) return interaction.respond([]);
      const config = await getRoleTemplateConfig(client, interaction.guildId);
      const focused = String(interaction.options.getFocused() || '').toLowerCase();
      const choices = config.templates
        .filter(template => template.enabled && template.roleIds.length > 0)
        .filter(template => template.name.toLowerCase().includes(focused) || template.slug.includes(focused))
        .slice(0, 25)
        .map(template => ({
          name: (template.name + ' · ' + template.roleIds.length + ' roles').slice(0, 100),
          value: template.slug,
        }));
      await interaction.respond(choices);
    } catch {
      await interaction.respond([]).catch(() => {});
    }
  },

  async execute(interaction, guildConfig, client) {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply(ephemeral('This command can only be used in a server.'));
      return;
    }
    if (!canManageRoleTemplates(interaction.memberPermissions)) {
      await interaction.reply(ephemeral('Access denied. Administrator or Manage Server permission is required.'));
      return;
    }

    try {
      const guild = interaction.guild;
      await prepareGuildRoles(guild);
      const actor = await guild.members.fetch(interaction.user.id).catch(() => null);
      if (!actor) throw new Error('Could not verify your server member profile.');
      const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
      if (!botMember?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
        throw new Error('The bot needs the Manage Roles permission.');
      }

      const config = await getRoleTemplateConfig(client, guild.id);
      const templateKey = interaction.options.getString('template', true).toLowerCase();
      const template = getRoleTemplateBySlug(config, templateKey) ||
        config.templates.find(item => item.name.toLowerCase() === templateKey) || null;
      if (!template) throw new Error('Template not found. Open !rolepanel to check the template key.');
      if (!template.enabled || !template.roleIds.length) {
        throw new Error('This template is disabled or has no roles. Enable it in !rolepanel first.');
      }

      const targetUser = interaction.options.getUser('member', true);
      const target = await guild.members.fetch(targetUser.id).catch(() => null);
      if (!target) throw new Error('Could not find that member in this server.');

      const requestedWorkshopRole = typeof interaction.options.getRole === 'function'
        ? interaction.options.getRole('workshop', false)
        : null;
      let workshopRole = null;
      if (requestedWorkshopRole) {
        if (!/mechanic/i.test(template.name + ' ' + template.slug)) {
          throw new Error('The workshop placement option can only be used with a Mechanic template.');
        }
        workshopRole = guild.roles.cache.get(String(requestedWorkshopRole.id)) ||
          await guild.roles.fetch(String(requestedWorkshopRole.id)).catch(() => null);
        if (!workshopRole) throw new Error('Could not find the selected workshop role in this server.');
      }

      // Keep workshop placement separate from the saved template; it is an optional, per-assignment role.
      const assignmentTemplate = {
        ...template,
        roleIds: [...new Set([...template.roleIds.map(String), ...(workshopRole ? [String(workshopRole.id)] : [])])],
      };
      const roleEntries = await Promise.all(assignmentTemplate.roleIds.map(async id => {
        const role = guild.roles.cache.get(String(id)) || await guild.roles.fetch(String(id)).catch(() => null);
        return [String(id), role];
      }));
      const roleMap = new Map(roleEntries.filter(([, role]) => role).map(([id, role]) => [id, role]));
      const availableRoles = assignmentTemplate.roleIds.map(id => roleMap.get(String(id))).filter(Boolean);

      const hierarchyViolations = getRoleHierarchyViolations(actor, availableRoles, guild.ownerId);
      if (hierarchyViolations.length) {
        throw new Error('Rank protection blocked this assignment. Your highest role must be above: ' +
          hierarchyViolations.map(role => role.name).join(', ') + '. No roles were changed.');
      }

      const plan = buildRoleAssignmentPlan(assignmentTemplate, roleMap, target.roles.cache.keys(), guild.id);
      if (plan.unavailable.length) {
        const names = plan.unavailable.map(item => item.role?.name || item.id);
        throw new Error('The template contains missing or unassignable roles (' + names.join(', ') +
          '). Check role existence and ensure the bot role is above every template role. No roles were changed.');
      }

      if (plan.toAdd.length) {
        await target.roles.add(plan.toAdd.map(role => role.id), 'SKAW GROUP Role Template: ' + template.name + ' applied by ' + interaction.user.tag);
      }

      const templateRoleIds = new Set(template.roleIds.map(String));
      const addedTemplateRoles = plan.toAdd.filter(role => templateRoleIds.has(String(role.id))).map(role => role.name);
      const existingTemplateRoles = plan.alreadyHad.filter(role => templateRoleIds.has(String(role.id))).map(role => role.name);
      const workshopWasAdded = workshopRole && plan.toAdd.some(role => String(role.id) === String(workshopRole.id));
      const workshopAlreadyPresent = workshopRole && plan.alreadyHad.some(role => String(role.id) === String(workshopRole.id));
      const lines = [
        '**Role template applied successfully.**',
        'Template: **' + template.name + '**',
        'Member: **' + target.user.tag + '**',
        addedTemplateRoles.length ? 'Added template roles: ' + addedTemplateRoles.join(', ') : 'Added template roles: none (already present).',
      ];
      if (existingTemplateRoles.length) lines.push('Template roles already present: ' + existingTemplateRoles.join(', '));
      if (workshopRole) {
        lines.push('Workshop placement: **' + workshopRole.name + '** (' +
          (workshopWasAdded ? 'added' : workshopAlreadyPresent ? 'already present' : 'unchanged') + ')');
      }
      lines.push('No existing roles were removed.');
      await interaction.reply(ephemeral(lines.join('\n')));
    } catch (error) {
      await interaction.reply(ephemeral('❌ ' + String(error?.message || 'Could not apply the role template.').slice(0, 1700))).catch(async () => {
        await interaction.followUp(ephemeral('❌ ' + String(error?.message || 'Could not apply the role template.').slice(0, 1700))).catch(() => {});
      });
    }
  },
};
