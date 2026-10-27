import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  buildCompanyStructureEmbeds,
  canManageCompanyStructure,
  deleteCompanyStructureDraft,
  getCompanyStructureConfig,
  getCompanyStructureDraft,
  getDraftSnapshotView,
  publishCompanyStructureDraft,
  saveCompanyStructureConfig,
} from '../../../services/companyStructureService.js';

async function checkControlAccess(interaction, guildId, ownerId = null) {
  if (!interaction.guild || interaction.guildId !== guildId) {
    await interaction.reply({ content: 'This control belongs to a different server.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return false;
  }
  if (ownerId && ownerId !== interaction.user.id) {
    await interaction.reply({ content: 'Only the person who opened this control can use it.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return false;
  }
  if (!(await canManageCompanyStructure(interaction))) {
    await interaction.reply({ content: 'Only SKAW Management or a server Administrator/Manager can use this control.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return false;
  }
  return true;
}

function buildCategoryEditModal(guildId, ownerId, section) {
  const modal = new ModalBuilder()
    .setCustomId('cs_category_modal:' + guildId + ':' + ownerId + ':' + section.key)
    .setTitle('Edit Company Structure category');

  const name = new TextInputBuilder()
    .setCustomId('name')
    .setLabel('Category title')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(80)
    .setValue(section.title);

  const roleId = new TextInputBuilder()
    .setCustomId('role_id')
    .setLabel('Discord Role ID')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(20)
    .setValue(section.roleId);

  const order = new TextInputBuilder()
    .setCustomId('order')
    .setLabel('Order number (smaller = earlier)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(5)
    .setValue(String(section.order));

  modal.addComponents(
    new ActionRowBuilder().addComponents(name),
    new ActionRowBuilder().addComponents(roleId),
    new ActionRowBuilder().addComponents(order),
  );
  return modal;
}

const publishButton = {
  name: 'cs_publish',
  async execute(interaction, client, args) {
    const [draftId, ownerId] = args;
    if (ownerId !== interaction.user.id) {
      return interaction.reply({ content: 'Only the person who created this preview can publish it.', flags: MessageFlags.Ephemeral });
    }
    const draft = getCompanyStructureDraft(draftId);
    if (!draft || draft.ownerId !== interaction.user.id) {
      return interaction.reply({ content: 'This preview expired. Run /cs update to create a new one.', flags: MessageFlags.Ephemeral });
    }
    if (!(await canManageCompanyStructure(interaction))) {
      return interaction.reply({ content: 'Only SKAW Management or a server Administrator/Manager can publish the structure.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await publishCompanyStructureDraft(client, draft);
      deleteCompanyStructureDraft(draftId);
      const message = result.action === 'edited'
        ? 'The existing Company Structure message was updated.'
        : 'The Company Structure message was published.';
      const persistenceNote = result.configSaved
        ? ''
        : '\n⚠️ The message was published, but its ID could not be saved. Check the database before the next update to avoid a duplicate.';
      const dbWarning = client.db?.isDegraded?.()
        ? '\n⚠️ Database is running in memory fallback mode; settings may not survive a restart.'
        : '';
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(result.configSaved ? 0x2ECC71 : 0xE67E22)
          .setTitle('Company Structure published')
          .setDescription(message + '\nChannel: <#' + result.channelId + '>' + persistenceNote + dbWarning)],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0xE74C3C).setTitle('Publish failed').setDescription(error.message || 'Could not publish Company Structure.')],
      });
    }
  },
};

const cancelButton = {
  name: 'cs_cancel',
  async execute(interaction, client, args) {
    const [draftId, ownerId] = args;
    if (ownerId !== interaction.user.id) {
      return interaction.reply({ content: 'Only the person who created this preview can cancel it.', flags: MessageFlags.Ephemeral });
    }
    deleteCompanyStructureDraft(draftId);
    return interaction.update({
      content: 'Company Structure preview cancelled. Nothing was published.',
      embeds: [],
      components: [],
    });
  },
};

const editMembersButton = {
  name: 'cs_edit_members',
  async execute(interaction, client, args) {
    const [draftId, ownerId] = args;
    if (ownerId !== interaction.user.id) {
      return interaction.reply({ content: 'Only the person who created this preview can edit it.', flags: MessageFlags.Ephemeral });
    }
    if (!(await canManageCompanyStructure(interaction))) {
      return interaction.reply({ content: 'Only SKAW Management or a server Administrator/Manager can edit the preview.', flags: MessageFlags.Ephemeral });
    }
    const draft = getCompanyStructureDraft(draftId);
    if (!draft) {
      return interaction.reply({ content: 'This preview expired. Run /cs update again.', flags: MessageFlags.Ephemeral });
    }

    const view = getDraftSnapshotView(draft);
    const available = view.sections.filter(section => section.enabled && section.roleExists).slice(0, 25);

    if (available.length === 0) {
      return interaction.reply({
        content: 'There are no populated categories to edit in this preview. Update Discord role assignments first, or add/configure a category using /cs manage.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId('cs_edit_select:' + draftId + ':' + ownerId)
      .setPlaceholder('Choose a category whose preview roster you want to edit')
      .addOptions(available.map(section => ({
        label: section.title.slice(0, 100),
        description: (section.members.length + ' preview entries • role ' + section.roleId).slice(0, 100),
        value: section.key,
      })));

    return interaction.reply({
      content: 'Select a category. These edits affect this preview only and will be replaced by Discord role data on the next /cs update.',
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral,
    });
  },
};

const manageSettingsButton = {
  name: 'cs_manage_settings',
  async execute(interaction, client, args) {
    const guildId = args[0];
    if (!(await checkControlAccess(interaction, guildId))) return;
    const config = await getCompanyStructureConfig(client, guildId);

    const modal = new ModalBuilder()
      .setCustomId('cs_settings_modal:' + guildId + ':' + interaction.user.id)
      .setTitle('Company Structure settings');

    const channel = new TextInputBuilder()
      .setCustomId('channel_id')
      .setLabel('Target text channel ID')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(20)
      .setValue(config.channelId);

    const banner = new TextInputBuilder()
      .setCustomId('banner_url')
      .setLabel('Public banner image URL (blank disables it)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(500)
      .setPlaceholder('https://...');

    if (config.bannerUrl) banner.setValue(config.bannerUrl);

    modal.addComponents(
      new ActionRowBuilder().addComponents(channel),
      new ActionRowBuilder().addComponents(banner),
    );
    return interaction.showModal(modal);
  },
};

const manageCategoriesButton = {
  name: 'cs_manage_categories',
  async execute(interaction, client, args) {
    const guildId = args[0];
    if (!(await checkControlAccess(interaction, guildId))) return;
    const config = await getCompanyStructureConfig(client, guildId);
    const groups = [
      {
        name: 'Management positions',
        value: 'management',
        count: config.sections.filter(section => section.kind === 'management' || section.kind === 'managementFallback').length,
      },
      {
        name: 'Divisions & partner business',
        value: 'division',
        count: config.sections.filter(section => section.kind === 'division' || section.kind === 'partner').length,
      },
      {
        name: 'Workshops',
        value: 'workshop',
        count: config.sections.filter(section => section.kind === 'workshop').length,
      },
    ].filter(group => group.count > 0);

    const menu = new StringSelectMenuBuilder()
      .setCustomId('cs_category_group_select:' + guildId + ':' + interaction.user.id)
      .setPlaceholder('Choose a group of categories')
      .addOptions(groups.map(group => ({
        label: group.name,
        description: group.count + ' categories',
        value: group.value,
      })));

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x0878FF)
        .setTitle('Manage Company Structure categories')
        .setDescription('Choose a group, then select a category to edit, enable/disable, or remove it. Disabled categories are ignored by /cs update.')],
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral,
    });
  },
};

const editCategoryButton = {
  name: 'cs_category_edit',
  async execute(interaction, client, args) {
    const [guildId, ownerId, sectionKey] = args;
    if (!(await checkControlAccess(interaction, guildId, ownerId))) return;
    const config = await getCompanyStructureConfig(client, guildId);
    const section = config.sections.find(item => item.key === sectionKey);
    if (!section) {
      return interaction.reply({ content: 'That category no longer exists. Open /cs manage again.', flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(buildCategoryEditModal(guildId, ownerId, section));
  },
};

const toggleCategoryButton = {
  name: 'cs_category_toggle',
  async execute(interaction, client, args) {
    const [guildId, ownerId, sectionKey] = args;
    if (!(await checkControlAccess(interaction, guildId, ownerId))) return;
    const config = await getCompanyStructureConfig(client, guildId);
    const section = config.sections.find(item => item.key === sectionKey);
    if (!section) {
      return interaction.reply({ content: 'That category no longer exists.', flags: MessageFlags.Ephemeral });
    }

    section.enabled = !section.enabled;
    await saveCompanyStructureConfig(client, guildId, config);
    return interaction.update({
      content: 'Category **' + section.title + '** is now **' + (section.enabled ? 'enabled' : 'disabled') + '**. Run /cs update to review the resulting structure.',
      embeds: [],
      components: [],
    });
  },
};

const removeCategoryButton = {
  name: 'cs_category_remove',
  async execute(interaction, client, args) {
    const [guildId, ownerId, sectionKey] = args;
    if (!(await checkControlAccess(interaction, guildId, ownerId))) return;
    const config = await getCompanyStructureConfig(client, guildId);
    const section = config.sections.find(item => item.key === sectionKey);
    if (!section) {
      return interaction.reply({ content: 'That category no longer exists.', flags: MessageFlags.Ephemeral });
    }

    config.sections = config.sections.filter(item => item.key !== sectionKey);
    await saveCompanyStructureConfig(client, guildId, config);
    return interaction.update({
      content: 'Removed category **' + section.title + '** from the Company Structure configuration. The Discord role itself was not changed.',
      embeds: [],
      components: [],
    });
  },
};

export default [
  publishButton,
  cancelButton,
  editMembersButton,
  manageSettingsButton,
  manageCategoriesButton,
  editCategoryButton,
  toggleCategoryButton,
  removeCategoryButton,
];
