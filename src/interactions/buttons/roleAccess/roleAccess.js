import { handleRoleAccessButton } from '../../../services/roleAccessManagerPanelService.js';

export default {
  name: 'skaw_ra',
  async execute(interaction, client, args) {
    return handleRoleAccessButton(interaction, client, args);
  },
};
