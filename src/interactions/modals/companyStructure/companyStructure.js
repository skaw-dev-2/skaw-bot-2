import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionsBitField,
} from 'discord.js';
import {
  buildCompanyStructureEmbeds,
  canManageCompanyStructure,
  getCompanyStructureConfig,
  getCompanyStructureDraft,
  getDraftSnapshotView,
  saveCompanyStructureConfig,
  setCompanyStructureDraftRoster,
} from '../../../services/companyStructureService.js';

async function checkModalAccess(interaction, guildId, ownerId) {
  if (!interaction.guild || interaction.guildId !== guildId || interaction.user.id !== ownerId) {
    await interaction.reply({ content: 'This form belongs to another user or server.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return false;
  }
  if (!(await canManageCompanyStructure(interaction))) {
    await interaction.reply({ content: 'Only SKAW Management or a server Administrator/Manager can use this form.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return false;
  }
  return true;
}

function buildPreviewControls(draft, snapshot) {
  const missingRoles = snapshot.missingRoles.length > 0;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('cs_edit_members:' + draft.id + ':' + draft.ownerId)
      .setLabel('Edit Members')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('cs_publish:' + draft.id + ':' + draft.ownerId)
      .setLabel('Publish')
      .setStyle(ButtonStyle.Success)
      .setDisabled(missingRoles),
    new ButtonBuilder()
      .setCustomId('cs_cancel:' + draft.id + ':' + draft.ownerId)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger),
  );
}

const settingsModal = {
  name: 'cs_settings_modal',
  async execute(interaction, client, args) {
    const [guildId, ownerId] = args;
    if (!(await checkModalAccess(interaction, guildId, ownerId))) return;

    try {
      const channelId = interaction.fields.getTextInputValue('channel_id').trim();
      const bannerInput = interaction.fields.getTextInputValue('banner_url').trim();
      const footerImageInput = interaction.fields.getTextInputValue('footer_image_url').trim();
      if (!/^\d{17,20}$/.test(channelId)) {
        throw new Error('Please enter a valid Discord text channel ID.');
      }

      const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || channel.isDMBased() || typeof channel.send !== 'function') {
        throw new Error('That channel was not found in this server or is not a text channel.');
      }

      const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
      const permissions = channel.permissionsFor(botMember || interaction.client.user);
      const required = PermissionsBitField.Flags.ViewChannel
        | PermissionsBitField.Flags.SendMessages
        | PermissionsBitField.Flags.EmbedLinks;
      if (!permissions || !permissions.has(required)) {
        throw new Error('The bot needs View Channel, Send Messages, and Embed Links permissions in the selected channel.');
      }

      const parseOptionalImageUrl = (value, label) => {
        if (!value || ['none', 'off', 'clear'].includes(value.toLowerCase())) return null;
        let parsed;
        try {
          parsed = new URL(value);
        } catch {
          throw new Error(label + ' must be a public image URL starting with https:// or http://. Leave blank or use "none" to disable it.');
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          throw new Error(label + ' must use http:// or https://.');
        }
        return parsed.toString();
      };
      const bannerUrl = parseOptionalImageUrl(bannerInput, 'Banner');
      const footerImageUrl = parseOptionalImageUrl(footerImageInput, 'Footer image');

      const config = await getCompanyStructureConfig(client, guildId);
      config.channelId = channelId;
      config.bannerUrl = bannerUrl;
      config.bannerConfigured = true;
      config.footerImageUrl = footerImageUrl;
      await saveCompanyStructureConfig(client, guildId, config);

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x2ECC71)
          .setTitle('Company Structure settings saved')
          .setDescription('Target channel: <#' + channelId + '>\nBanner: ' + (bannerUrl ? 'Configured' : 'Disabled') + '\nFooter image: ' + (footerImageUrl ? 'Configured' : 'Disabled') + '\n\nFooter image appears below the structure text in its final embed. Run /cs update to preview the next publication.')],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xE74C3C).setTitle('Settings not saved').setDescription(error.message || 'Could not save these settings.')],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};

const categoryModal = {
  name: 'cs_category_modal',
  async execute(interaction, client, args) {
    const [guildId, ownerId, sectionKey] = args;
    if (!(await checkModalAccess(interaction, guildId, ownerId))) return;

    try {
      const title = interaction.fields.getTextInputValue('name').trim();
      const roleId = interaction.fields.getTextInputValue('role_id').trim();
      const order = Number(interaction.fields.getTextInputValue('order').trim());

      if (!title || title.length > 80) throw new Error('Category title must be 1–80 characters.');
      if (!/^\d{17,20}$/.test(roleId)) throw new Error('Please enter a valid Discord Role ID.');
      if (!Number.isInteger(order) || order < 0 || order > 99999) throw new Error('Order must be a whole number from 0 to 99999.');

      const config = await getCompanyStructureConfig(client, guildId);
      const section = config.sections.find(item => item.key === sectionKey);
      if (!section) throw new Error('This category no longer exists.');

      if (config.sections.some(item => item.key !== sectionKey && item.roleId === roleId)) {
        throw new Error('That role is already assigned to another category.');
      }

      const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
      if (!role) throw new Error('That Role ID does not exist in this server. Select an existing role.');

      section.title = title;
      section.customTitle = true;
      section.roleId = roleId;
      section.order = order;
      await saveCompanyStructureConfig(client, guildId, config);

      return interaction.reply({
        content: 'Updated **' + title + '** using role <@&' + roleId + '>. Run /cs update to review the change.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xE74C3C).setTitle('Category not updated').setDescription(error.message || 'Could not update this category.')],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};

const rosterModal = {
  name: 'cs_roster_modal',
  async execute(interaction, client, args) {
    const [draftId, ownerId, sectionKey] = args;
    if (ownerId !== interaction.user.id) {
      return interaction.reply({ content: 'Only the person who created this preview can edit it.', flags: MessageFlags.Ephemeral });
    }

    const draft = getCompanyStructureDraft(draftId);
    if (!draft || draft.guildId !== interaction.guildId) {
      return interaction.reply({ content: 'This preview expired. Run /cs update again.', flags: MessageFlags.Ephemeral });
    }
    if (!(await canManageCompanyStructure(interaction))) {
      return interaction.reply({ content: 'Only SKAW Management or a server Administrator/Manager can edit the preview.', flags: MessageFlags.Ephemeral });
    }

    try {
      const rawRoster = interaction.fields.getTextInputValue('roster');
      setCompanyStructureDraftRoster(draft, sectionKey, rawRoster);
      const snapshot = getDraftSnapshotView(draft);
      const embeds = buildCompanyStructureEmbeds(snapshot, draft.config, { preview: true });

      const components = [buildPreviewControls(draft, snapshot)];
      const updatePayload = { embeds, components, allowedMentions: { parse: [] } };
      // Use the original /cs update interaction webhook to edit its ephemeral
      // response. Do not call Message.edit() on an ephemeral preview message.
      if (draft.previewInteraction?.token && typeof draft.previewInteraction.editReply === 'function') {
        await draft.previewInteraction.editReply(updatePayload);
        return interaction.reply({
          content: 'Preview roster saved and the original preview has been refreshed. These edits apply only to this draft; the next /cs update reads Discord roles again.',
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.reply({
        content: 'Preview roster saved, but the original preview session is no longer available (for example, after a bot restart). Run /cs update to create a new preview.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xE74C3C).setTitle('Preview edit failed').setDescription(error.message || 'Could not update this preview.')],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};

export default [settingsModal, categoryModal, rosterModal];
