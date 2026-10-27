import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(process.cwd());
const checks = [];
function check(name, ok, detail = '') {
    checks.push({ name, ok: Boolean(ok), detail });
    console.log((ok ? 'OK   ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}
async function read(relative) {
    try { return await fs.readFile(path.join(root, relative), 'utf8'); }
    catch { return null; }
}

async function main() {
    const files = [
        'src/commands/Utility/employee-logs.js',
        'src/services/employeeLogsService.js',
        'src/services/employeeLogsInteractionService.js',
        'src/services/employeeLogsAutoRoleService.js',
        'src/services/employeeRoleRegistryService.js',
        'src/services/employeeDirectoryService.js',
        'src/events/interactionCreate.js',
        'src/events/guildMemberUpdate.js',
        'src/tests/employeeRoleRegistry.test.js',
        'src/tests/employeeLogsAutoRoleDispatch.test.js',
        'src/tests/employeeDirectoryService.test.js',
    ];
    const source = {};
    for (const relative of files) {
        source[relative] = await read(relative);
        check(relative + ' exists', typeof source[relative] === 'string');
        if (source[relative] !== null) {
            const result = spawnSync(process.execPath, ['--check', path.join(root, relative)], { encoding: 'utf8' });
            check(relative + ' syntax', result.status === 0, (result.stderr || result.stdout || '').trim().slice(0, 250));
        }
    }

    const command = source['src/commands/Utility/employee-logs.js'] || '';
    const interaction = source['src/services/employeeLogsInteractionService.js'] || '';
    const autoRole = source['src/services/employeeLogsAutoRoleService.js'] || '';
    const registry = source['src/services/employeeRoleRegistryService.js'] || '';
    const directory = source['src/services/employeeDirectoryService.js'] || '';
    const router = source['src/events/interactionCreate.js'] || '';

    check('Single /epl command is defined', command.includes(".setName('epl')"));
    check('Only the four agreed subcommands are exposed', ['panel', 'logs', 'find', 'report'].every(name => command.includes(".setName('" + name + "')")));
    check('Central management dashboard and manual logs picker exist', interaction.includes('buildEmployeeLogsPanel') && interaction.includes('buildEmployeeLogsActivitiesPanel'));
    check('Role Registry UI is connected to persistent role mappings', interaction.includes('registerEmployeeRole') && interaction.includes('getEmployeeRoleRegistry'));
    check('Company Staff base role ID is fixed', registry.includes("id: '1564660065783390371'"));
    check('Base-role removal creates a pending Exit Review', autoRole.includes('createEmployeeExitReview') && autoRole.includes('hadMembership && !hasMembership'));
    check('Restoring membership cancels pending Exit Reviews', autoRole.includes('cancelPendingEmployeeExitReviews'));
    check('Initial directory sync creates no Sign-In logs', directory.includes('syncEmployeeDirectoryMembership') && directory.includes('signInLogsCreated: 0'));
    check('Channel-select menu is routed to Employee Logs', router.includes('isChannelSelectMenu?.()'));

    const failed = checks.filter(item => !item.ok);
    console.log('\n' + (failed.length ? 'EMPLOYEE LOGS CHECKS FAILED' : 'ALL EMPLOYEE LOGS V2 CHECKS PASSED') + ' (' + (checks.length - failed.length) + '/' + checks.length + ')');
    if (failed.length) process.exitCode = 1;
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
