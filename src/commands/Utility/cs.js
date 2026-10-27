import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import {
  buildCompanyStructureEmbeds,
  canManageCompanyStructure,
  createCompanyStructureDraft,
  getCompanyStructureConfig,
  makeCompanyStructureCategoryKey,
  saveCompanyStructureConfig,
} from '../../services/companyStructureService.js';

function buildManagePanel(config) {
  const embed = new EmbedBuilder()
    .setColor(0x0878FF)
    .setTitle('SKAW Company Structure • Manage')
    .setDescription([
      'Use the buttons below to configure the live Company Structure message.',
      '',
      '**Channel:** ' + (config.channelId ? '<#' + config.channelId + '>' : 'Not configured'),
      '**Banner:** ' + (config.bannerUrl ? 'Configured' : 'Not configured'),
      '**Categories:** ' + config.sections.length + ' (' + config.sections.filter(section => section.enabled).length + ' enabled)',
      '**Managed message:** ' + (config.messageId ? 'Stored' : 'Not published yet'),
      '',
      'Only categories enabled in this menu are considered during the next update.',
    ].join('\n'));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('cs_manage_settings:' + config.guildId + ':panel')
      .setLabel('Set Channel & Banner')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('cs_manage_categories:' + config.guildId + ':panel')
      .setLabel('Manage Categories')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

export default {
  data: new SlashCommandBuilder()
    .setName('cs')
    .setDescription('Manage the SKAW Company Structure.')
    .addSubcommand(subcommand => subcommand
      .setName('update')
      .setDescription('Build a private preview of the Company Structure.'))
    .addSubcommandGroup(group => group
      .setName('category')
      .setDescription('Manage Company Structure categories.')
      .addSubcommand(subcommand => subcommand
        .setName('add')
        .setDescription('Add a role-backed category to the Company Structure.')
        .addStringOption(option => option
          .setName('name')
          .setDescription('Category label shown in the management panel.')
          .setRequired(true)
          .setMaxLength(80))
        .addRoleOption(option => option
          .setName('role')
          .setDescription('Discord role that supplies the member list.')
          .setRequired(true))
        .addStringOption(option => option
          .setName('section')
          .setDescription('Where this category belongs in the structure.')
          .setRequired(true)
          .addChoices(
            { name: 'Management position', value: 'management' },
            { name: 'Division', value: 'division' },
            { name: 'Workshop', value: 'workshop' },
            { name: 'Partner Business', value: 'partner' },
          ))))
    .addSubcommand(subcommand => subcommand
      .setName('manage')
      .setDescription('Open the Company Structure configuration panel.')),

  async execute(interaction, guildConfig, client) {
    const allowed = await canManageCompanyStructure(interaction);
    if (!allowed) {
      return interaction.reply({
        content: 'Only SKAW Management or a server Administrator/Manager can use Company Structure controls.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const subcommand = interaction.options.getSubcommand();
    const group = interaction.options.getSubcommandGroup(false);

    try {
      if (subcommand === 'update' && !group) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const draft = await createCompanyStructureDraft(client, interaction.guild, interaction.user.id);
        const embeds = buildCompanyStructureEmbeds(draft.snapshot, draft.config, { preview: true });
        const missingRoles = draft.snapshot.missingRoles.length > 0;

        const editButton = new ButtonBuilder()
          .setCustomId('cs_edit_members:' + draft.id + ':' + interaction.user.id)
          .setLabel('Edit Members')
          .setStyle(ButtonStyle.Secondary);
        const publishButton = new ButtonBuilder()
          .setCustomId('cs_publish:' + draft.id + ':' + interaction.user.id)
          .setLabel('Publish')
          .setStyle(ButtonStyle.Success)
          .setDisabled(missingRoles);
        const cancelButton = new ButtonBuilder()
          .setCustomId('cs_cancel:' + draft.id + ':' + interaction.user.id)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Danger);

        await interaction.editReply({
          embeds,
          components: [new ActionRowBuilder().addComponents(editButton, publishButton, cancelButton)],
          allowedMentions: { parse: [] },
        });
        return;
      }

      if (group === 'category' && subcommand === 'add') {
        const config = await getCompanyStructureConfig(client, interaction.guildId);
        const name = interaction.options.getString('name', true).trim();
        const role = interaction.options.getRole('role', true);
        const kind = interaction.options.getString('section', true);

        if (config.sections.some(section => section.roleId === role.id)) {
          return interaction.reply({
            content: 'That role is already configured. Use /cs manage to edit or enable its category instead.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const highestOrder = config.sections.reduce((max, section) => Math.max(max, Number(section.order) || 0), 0);
        const key = makeCompanyStructureCategoryKey(role.id, name);
        config.sections.push({
          key,
          title: name,
          roleId: role.id,
          kind,
          customTitle: true,
          order: highestOrder + 10,
          enabled: true,
        });
        await saveCompanyStructureConfig(client, interaction.guildId, config);

        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setColor(0x2ECC71)
            .setTitle('Company Structure category added')
            .setDescription('Added **' + name + '** using role <@&' + role.id + '>.\nSection type: **' + kind + '**.\nRun /cs update to review the new structure.')],
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }

      if (subcommand === 'manage' && !group) {
        const config = await getCompanyStructureConfig(client, interaction.guildId);
        return interaction.reply({
          ...buildManagePanel(config),
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }

      return interaction.reply({
        content: 'That Company Structure action is not supported.',
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      return interaction.followUp({
        content: 'Company Structure error: ' + (error?.message || 'Unknown error.'),
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  },
};
