import { Events } from 'discord.js';
import { recordExternalChannelPermissionChange } from '../services/roleAccessManagerService.js';

export default {
  name: Events.ChannelUpdate,
  async execute(oldChannel, newChannel, client) {
    await recordExternalChannelPermissionChange(client, oldChannel, newChannel);
  },
};
