import { Events } from 'discord.js';
import { recordExternalRolePermissionChange } from '../services/roleAccessManagerService.js';

export default {
  name: Events.GuildRoleUpdate,
  async execute(oldRole, newRole, client) {
    await recordExternalRolePermissionChange(client, oldRole, newRole);
  },
};
