import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  buildCompanyStructureEmbeds,
  canManageCompanyStructure,
  getCompanyStructureConfig,
  getCompanyStructureDraft,
  getDraftSnapshotView,
} from '../../../services/companyStructureService.js';

async function checkAccess(interaction, guildId, ownerId) {
  if (interaction.guildId !== guildId || interaction.user.id !== ownerId) {
    await interaction.reply({ content: 'This control belongs to another user or server.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return false;
  }
  if (!(await canManageCompanyStructure(interaction))) {
    await interaction.reply({ content: 'Only SKAW Management or a server Administrator/Manager can use this control.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return false;
  }
  return true;
}

const editRosterSelect = {
  name: 'cs_edit_select',
  async execute(interaction, client, args) {
    const [draftId, ownerId] = args;
    if (ownerId !== interaction.user.id) {
      return interaction.reply({ content: 'Only the person who created this preview can edit it.', flags: MessageFlags.Ephemeral });
    }

    const draft = getCompanyStructureDraft(draftId);
    if (!draft || draft.guildId !== interaction.guildId) {
      return interaction.reply({ content: 'This preview expired. Run /cs update again.', flags: MessageFlags.Ephemeral });
    }

    const sectionKey = interaction.values?.[0];
    const section = getDraftSnapshotView(draft).sections.find(item => item.key === sectionKey);
    if (!section) {
      return interaction.reply({ content: 'That category is no longer available in this preview.', flags: MessageFlags.Ephemeral });
    }

    const rosterText = section.members.join('\n');
    if (rosterText.length > 3900) {
      return interaction.reply({
        content: 'This category has too many names to fit safely in one Discord modal. Use Discord role assignments to make the change, then run /cs update again.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const modal = new ModalBuilder()
      .setCustomId('cs_roster_modal:' + draftId + ':' + ownerId + ':' + sectionKey)
      .setTitle(('Edit preview • ' + section.title).slice(0, 45));

    const roster = new TextInputBuilder()
      .setCustomId('roster')
      .setLabel('One display name per line')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(3900)
      .setPlaceholder('Enter one name per line. Remove a line to remove that preview entry.');

    if (rosterText) roster.setValue(rosterText);

    modal.addComponents(new ActionRowBuilder().addComponents(roster));
    return interaction.showModal(modal);
  },
};

function getSectionsForGroup(config, group) {
  if (group === 'management') {
    return config.sections.filter(section => section.kind === 'management' || section.kind === 'managementFallback');
  }
  if (group === 'workshop') {
    return config.sections.filter(section => section.kind === 'workshop');
  }
  return config.sections.filter(section => section.kind === 'division' || section.kind === 'partner');
}

function buildCategoryListRow(guildId, ownerId, group, page, sections) {
  const pageSize = 23;
  const pageCount = Math.max(1, Math.ceil(sections.length / pageSize));
  const pageItems = sections.slice(page * pageSize, (page + 1) * pageSize);
  const options = pageItems.map(section => ({
    label: (section.title + (section.enabled ? '' : ' • DISABLED')).slice(0, 100),
    description: ('Role ID: ' + section.roleId + ' • Order: ' + section.order).slice(0, 100),
    value: section.key,
  }));

  if (page + 1 < pageCount) {
    options.push({
      label: 'Next page →',
      description: 'More categories in this group',
      value: '__next',
    });
  }
  if (page > 0) {
    options.push({
      label: '← Previous page',
      description: 'Return to the previous page',
      value: '__previous',
    });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId('cs_category_list_select:' + guildId + ':' + ownerId + ':' + group + ':' + page)
    .setPlaceholder('Select a category to manage')
    .addOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

const categoryGroupSelect = {
  name: 'cs_category_group_select',
  async execute(interaction, client, args) {
    const [guildId, ownerId] = args;
    if (!(await checkAccess(interaction, guildId, ownerId))) return;
    const group = interaction.values?.[0];
    const config = await getCompanyStructureConfig(client, guildId);
    const sections = getSectionsForGroup(config, group).sort((a, b) => a.order - b.order);

    if (sections.length === 0) {
      return interaction.update({ content: 'No categories exist in that group.', embeds: [], components: [] });
    }

    return interaction.update({
      content: 'Choose a category to edit, enable/disable, or remove. Page 1 of ' + Math.max(1, Math.ceil(sections.length / 23)) + '.',
      embeds: [],
      components: [buildCategoryListRow(guildId, ownerId, group, 0, sections)],
    });
  },
};

const categoryListSelect = {
  name: 'cs_category_list_select',
  async execute(interaction, client, args) {
    const [guildId, ownerId, group, pageValue] = args;
    if (!(await checkAccess(interaction, guildId, ownerId))) return;
    const selected = interaction.values?.[0];
    const config = await getCompanyStructureConfig(client, guildId);
    const sections = getSectionsForGroup(config, group).sort((a, b) => a.order - b.order);
    const page = Number(pageValue) || 0;

    if (selected === '__next' || selected === '__previous') {
      const nextPage = selected === '__next' ? page + 1 : Math.max(0, page - 1);
      return interaction.update({
        content: 'Choose a category to edit, enable/disable, or remove. Page ' + (nextPage + 1) + ' of ' + Math.max(1, Math.ceil(sections.length / 24)) + '.',
        embeds: [],
        components: [buildCategoryListRow(guildId, ownerId, group, nextPage, sections)],
      });
    }

    const section = sections.find(item => item.key === selected);
    if (!section) {
      return interaction.update({ content: 'That category no longer exists. Open /cs manage again.', embeds: [], components: [] });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('cs_category_edit:' + guildId + ':' + ownerId + ':' + section.key)
        .setLabel('Edit')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('cs_category_toggle:' + guildId + ':' + ownerId + ':' + section.key)
        .setLabel(section.enabled ? 'Disable' : 'Enable')
        .setStyle(section.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('cs_category_remove:' + guildId + ':' + ownerId + ':' + section.key)
        .setLabel('Remove')
        .setStyle(ButtonStyle.Danger),
    );

    return interaction.update({
      content: '**' + section.title + '**\nRole ID: ' + section.roleId + '\nType: ' + section.kind + '\nOrder: ' + section.order + '\nStatus: ' + (section.enabled ? 'Enabled' : 'Disabled') + '\n\nEditing this category changes Company Structure configuration only; it does not change the Discord role or role assignments.',
      embeds: [],
      components: [row],
    });
  },
};

export default [editRosterSelect, categoryGroupSelect, categoryListSelect];
