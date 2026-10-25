import { Events } from 'discord.js';
import { handleEmployeeLogsRoleUpdate } from '../services/employeeLogsAutoRoleService.js';

export default {
    name: Events.GuildMemberUpdate,
    async execute(oldMember, newMember, explicitClient) {
        try {
            await handleEmployeeLogsRoleUpdate(oldMember, newMember, explicitClient || newMember?.client);
        } catch (error) {
            console.error('[Employee Auto Logs] Unhandled guildMemberUpdate error:', error?.stack || error);
        }
    },
};
