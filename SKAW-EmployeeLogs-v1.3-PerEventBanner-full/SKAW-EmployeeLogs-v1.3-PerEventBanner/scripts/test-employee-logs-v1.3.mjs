import assert from 'node:assert/strict';
import {
    EMPLOYEE_LOG_TYPES,
    buildEmployeeLogBody,
    buildEmployeeLogEmbed,
    clearEmployeeLogsSticker,
    clearEmployeeLogsEventBanner,
    getEmployeeLogBannerEventKey,
    resolveEmployeeLogsBanner,
    getEmployeeLogsConfig,
    sendEmployeeLog,
    setEmployeeLogsChannel,
    setEmployeeLogsSticker,
    setEmployeeLogsBanner,
    setEmployeeLogsEventBanner,
} from '../src/services/employeeLogsService.js';

const GUILD_ID = '123456789012345678';
const MEMBER_ID = '234567890123456789';
const POSITION_ID = '345678901234567890';
const ROLE_A = '456789012345678901';
const ROLE_B = '567890123456789012';
const RECORDER_ID = '678901234567890123';
const BANNER = 'https://cdn.example.com/skaw-default-banner.png';
const SIGN_IN_BANNER = 'https://cdn.example.com/skaw-sign-in.png';
const SIGN_OUT_BANNER = 'https://cdn.example.com/skaw-sign-out.png';
const PROMOTION_BANNER = 'https://cdn.example.com/skaw-promotion.png';
const validData = {
    employee: { userId: MEMBER_ID, position: POSITION_ID, logs: 'Sign In', recordedBy: RECORDER_ID },
    promotion: { userId: MEMBER_ID, previousRank: ROLE_A, nextRank: ROLE_B, recordedBy: RECORDER_ID },
    mutation: { userId: MEMBER_ID, fromRole: ROLE_A, toRole: ROLE_B, logs: 'Requested by employee.', recordedBy: RECORDER_ID },
    blacklist: { userId: MEMBER_ID, position: POSITION_ID, reason: 'Repeated policy violations.', recordedBy: RECORDER_ID },
    dismissal: { userId: MEMBER_ID, position: POSITION_ID, reason: 'Employment status reviewed.', recordedBy: RECORDER_ID },
    warning: { userId: MEMBER_ID, position: POSITION_ID, warn: '1/2', reason: 'Duty reports not submitted.', recordedBy: RECORDER_ID },
};

for (const [type, template] of Object.entries(EMPLOYEE_LOG_TYPES)) {
    const embed = buildEmployeeLogEmbed(type, validData[type], BANNER).toJSON();
    assert.ok(embed.title.includes(template.title), `${type} has a title`);
    assert.equal(embed.color, 0x2563eb, `${type} uses SKAW blue`);
    assert.ok(embed.fields.length >= 3, `${type} has structured fields`);
    assert.ok(embed.footer.text.includes('SKAW GROUP'), `${type} has a branded footer`);
    assert.equal(embed.image.url, BANNER, `${type} supports the banner`);
    assert.ok(embed.fields.some(field => /RECORDED BY|ISSUED BY/.test(field.name)), `${type} includes issuer identity`);
    assert.ok(buildEmployeeLogBody(type, validData[type]).length > 10, `${type} retains plain text formatter`);
}

assert.throws(() => buildEmployeeLogEmbed('warning', { ...validData.warning, warn: '2/1' }), /tidak boleh lebih besar/i);
assert.throws(() => buildEmployeeLogEmbed('promotion', { ...validData.promotion, nextRank: ROLE_A }), /tidak boleh sama/i);
assert.throws(() => buildEmployeeLogEmbed('employee', { ...validData.employee, logs: '@everyone test' }), /@everyone/i);

assert.equal(getEmployeeLogBannerEventKey('employee', { logs: 'Sign In' }), 'employee-sign-in');
assert.equal(getEmployeeLogBannerEventKey('employee', { logs: 'signed in for duty' }), 'employee-sign-in');
assert.equal(getEmployeeLogBannerEventKey('employee', { logs: 'Sign-Out' }), 'employee-sign-out');
assert.equal(getEmployeeLogBannerEventKey('employee', { logs: 'Personal Resignation' }), 'employee-resignation');
assert.equal(getEmployeeLogBannerEventKey('employee', { logs: 'Attended staff meeting' }), 'employee-other');
assert.equal(getEmployeeLogBannerEventKey('promotion', validData.promotion), 'promotion');

const store = new Map();
const client = {
    user: { id: '789012345678901234' },
    db: {
        async get(key, fallback) { return store.has(key) ? structuredClone(store.get(key)) : structuredClone(fallback); },
        async set(key, value) { store.set(key, structuredClone(value)); },
    },
    channels: {
        async fetch(id) {
            assert.equal(id, '890123456789012345');
            return channel;
        },
    },
};
let stickerFirstAttempt = false;
let lastPayload;
const channel = {
    id: '890123456789012345',
    guildId: GUILD_ID,
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    async send(payload) {
        lastPayload = payload;
        if (payload.stickers?.length && !stickerFirstAttempt) {
            stickerFirstAttempt = true;
            const error = new Error('mock invalid sticker');
            error.code = 50035;
            throw error;
        }
        return { id: '901234567890123456', channelId: this.id, payload };
    },
};
const guild = { id: GUILD_ID, members: { me: { id: client.user.id }, fetchMe: async () => ({ id: client.user.id }) } };

await setEmployeeLogsBanner(client, GUILD_ID, BANNER, RECORDER_ID);
await setEmployeeLogsEventBanner(client, GUILD_ID, 'employee-sign-in', SIGN_IN_BANNER, RECORDER_ID);
await setEmployeeLogsEventBanner(client, GUILD_ID, 'employee-sign-out', SIGN_OUT_BANNER, RECORDER_ID);
await setEmployeeLogsEventBanner(client, GUILD_ID, 'promotion', PROMOTION_BANNER, RECORDER_ID);
let bannerConfig = await getEmployeeLogsConfig(client, GUILD_ID);
assert.equal(resolveEmployeeLogsBanner(bannerConfig, 'employee', { logs: 'Sign In' }), SIGN_IN_BANNER);
assert.equal(resolveEmployeeLogsBanner(bannerConfig, 'employee', { logs: 'Sign Out' }), SIGN_OUT_BANNER);
assert.equal(resolveEmployeeLogsBanner(bannerConfig, 'promotion', validData.promotion), PROMOTION_BANNER);
assert.equal(resolveEmployeeLogsBanner(bannerConfig, 'mutation', validData.mutation), BANNER, 'global banner is fallback for unconfigured event');
await clearEmployeeLogsEventBanner(client, GUILD_ID, 'employee-sign-in', RECORDER_ID);
bannerConfig = await getEmployeeLogsConfig(client, GUILD_ID);
assert.equal(resolveEmployeeLogsBanner(bannerConfig, 'employee', { logs: 'Sign In' }), BANNER, 'clearing an event banner returns to default fallback');

await setEmployeeLogsChannel(client, GUILD_ID, 'employee', channel.id, RECORDER_ID);
await setEmployeeLogsEventBanner(client, GUILD_ID, 'employee-sign-in', SIGN_IN_BANNER, RECORDER_ID);
await setEmployeeLogsSticker(client, GUILD_ID, 'employee', '912345678901234567', RECORDER_ID);
let config = await getEmployeeLogsConfig(client, GUILD_ID);
assert.equal(config.channels.employee, channel.id);
assert.equal(config.stickers.employee, '912345678901234567');
const sent = await sendEmployeeLog(client, guild, 'employee', validData.employee);
assert.equal(sent.stickerSent, false, 'invalid optional sticker should not block the embed');
assert.ok(sent.stickerWarning);
assert.equal(lastPayload.embeds.length, 1, 'fallback sends one embed');
assert.equal(lastPayload.embeds[0].toJSON().image.url, SIGN_IN_BANNER, 'sendEmployeeLog applies the matching event banner');
assert.equal(lastPayload.stickers, undefined, 'fallback sends no invalid sticker');
assert.deepEqual(lastPayload.allowedMentions, { parse: [] });
await clearEmployeeLogsSticker(client, GUILD_ID, 'employee', RECORDER_ID);
config = await getEmployeeLogsConfig(client, GUILD_ID);
assert.equal(config.stickers.employee, undefined);

console.log('ALL EMPLOYEE LOGS V1.3 UNIT TESTS PASSED (6 embeds, per-event banners, global fallback, activity matching, validation, config persistence, sticker fallback).');
