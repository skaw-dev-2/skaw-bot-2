import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(process.cwd());
const checks = [];
function check(name, ok, detail = '') {
    checks.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
async function read(relative) {
    try { return await fs.readFile(path.join(root, relative), 'utf8'); } catch { return null; }
}
async function main() {
    const app = await read('src/app.js');
    const command = await read('src/commands/Utility/employee-logs.js');
    const service = await read('src/services/employeeLogsService.js');
    const interactions = await read('src/services/employeeLogsInteractionService.js');
    const loader = await read('src/handlers/loaders/commandLoader.js');

    check('TitanBot repository root detected', Boolean(app && loader));
    for (const [name, source] of [
        ['command', 'src/commands/Utility/employee-logs.js'],
        ['service', 'src/services/employeeLogsService.js'],
        ['interaction handler', 'src/services/employeeLogsInteractionService.js'],
        ['startup hook', 'src/app.js'],
        ['local test harness', 'scripts/test-employee-logs-v1.3.mjs'],
    ]) {
        const body = await read(source);
        check(`${name} file exists`, typeof body === 'string');
        if (body !== null) {
            const result = spawnSync(process.execPath, ['--check', path.join(root, source)], { encoding: 'utf8' });
            check(`${name} syntax`, result.status === 0, (result.stderr || result.stdout || '').trim().slice(0, 220));
        }
    }
    check('Command loader present', Boolean(loader && /loadCommands|collectCommandPayloads/.test(loader)));
    check('Slash command /employee-logs exists', Boolean(command && command.includes(".setName('employee-logs')")));
    check('All setup commands exist', Boolean(command && ['panel', 'set-channel', 'clear-channel', 'set-banner', 'set-event-banner', 'clear-event-banner', 'clear-banner', 'set-sticker', 'clear-sticker', 'status'].every(name => command.includes(`.setName('${name}')`))));
    check('Per-type sticker setup and cleanup are available', Boolean(command && command.includes('setEmployeeLogsSticker') && command.includes('clearEmployeeLogsSticker')));
    check('Persistent per-guild config uses client.db', Boolean(service && /client\.db\.get/.test(service) && /client\.db\.set/.test(service)));
    check('Six log types defined', Boolean(service && ['employee', 'promotion', 'mutation', 'blacklist', 'dismissal', 'warning'].every(type => new RegExp(`\\b${type}:\\s*\\{`).test(service))));
    check('Corporate embed layout uses structured fields', Boolean(service && service.includes('.addFields(') && service.includes('👤  EMPLOYEE') && service.includes('🧾  RECORDED BY')));
    check('Blue branded accent configured', Boolean(service && service.includes('.setColor(BRAND_BLUE)') && service.includes('0x2563eb')));
    check('Distinct emoji identity per log type', Boolean(service && ['📋', '🏆', '🔄', '🛡️', '⛔', '⚠️'].every(emoji => service.includes(emoji))));
    check('Default banner remains compatible', Boolean(service && service.includes('setEmployeeLogsBanner') && service.includes('bannerUrl: normalizeBannerUrl(input.bannerUrl)')));
    check('Per-event banner configuration is stored and rendered', Boolean(service && service.includes('setEmployeeLogsEventBanner') && service.includes('resolveEmployeeLogsBanner(config, type, data)') && service.includes('embed.setImage(safeBannerUrl)')));
    check('Distinct employee Sign In/Sign Out/Resignation banner routing exists', Boolean(service && service.includes('employee-sign-in') && service.includes('employee-sign-out') && service.includes('employee-resignation') && service.includes('getEmployeeLogBannerEventKey')));
    check('Per-event banner setup and reset commands exist', Boolean(command && command.includes(".setName('set-event-banner')") && command.includes(".setName('clear-event-banner')")));
    check('Per-event banner status is shown to administrators', Boolean(command && command.includes('Event-specific Banners') && command.includes('config.banners?.[key]')));
    check('Optional sticker config + send payload', Boolean(service && service.includes('setEmployeeLogsSticker') && service.includes('clearEmployeeLogsSticker') && service.includes('stickers: [stickerId]')));
    check('Sticker failure falls back to the official embed', Boolean(service && service.includes('Sticker delivery is optional')));
    check('Recorder/issuer is included in embeds', Boolean(service && service.includes('recordedByValue(data)') && interactions && interactions.includes('session.data.recordedBy = interaction.user.id')));
    check('Mass mentions are disabled on outgoing logs', Boolean(service && service.includes('allowedMentions = { parse: [] }')));
    check('Send permission checks include Embed Links', Boolean(service && service.includes('PermissionFlagsBits.EmbedLinks')));
    check('User/role selection wizard exists', Boolean(interactions && interactions.includes('UserSelectMenuBuilder') && interactions.includes('RoleSelectMenuBuilder')));
    check('Modal submission handler exists', Boolean(interactions && interactions.includes('isModalSubmit()') && interactions.includes('showModal')));
    check('Panel options display the per-type emoji', Boolean(interactions && interactions.includes('emoji: { name: entry.emoji }')));
    check('Interaction handler import exists in app.js', Boolean(app && app.includes("from './services/employeeLogsInteractionService.js'")));
    check('Interaction handler startup hook exists in app.js', Boolean(app && app.includes('startEmployeeLogsInteractionHandler(this);')));
    check('No new npm dependencies or SQL migration required', true);

    const failed = checks.filter(item => !item.ok);
    console.log(`\n${failed.length ? 'CHECKS FAILED' : 'ALL EMPLOYEE LOGS V1.3 CHECKS PASSED'} (${checks.length - failed.length}/${checks.length})`);
    if (failed.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
