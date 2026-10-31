import { handleRoleAccessSelect } from '../../../services/roleAccessManagerPanelService.js';

export default {
  name: 'skaw_ra_select',
  async execute(interaction, client, args) {
    return handleRoleAccessSelect(interaction, client, args);
  },
};
