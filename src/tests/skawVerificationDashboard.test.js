import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVerificationDashboardPayload } from '../services/skawVerificationDashboardService.js';

function makeGuild() {
  const roles = new Map([
    ['11111111111111111', { id: '11111111111111111', name: 'Verified' }],
    ['22222222222222222', { id: '22222222222222222', name: 'Unverified' }],
    ['33333333333333333', { id: '33333333333333333', name: 'SKAW Community' }],
  ]);
  return { roles: { cache: roles } };
}

const config = {
  enabled: true,
  verificationChannelId: '44444444444444444',
  logChannelId: null,
  panelMessageId: '55555555555555555',
  verifiedRoleId: '11111111111111111',
  verifiedRoleIds: ['11111111111111111', '33333333333333333'],
  unverifiedRoleId: '22222222222222222',
  panelTitle: 'SKAW Group Verification',
  panelDescription: 'Register your IC name.',
  guideText: 'Enter your first and last IC name.',
  imageUrl: 'https://example.com/banner.png',
  footerText: 'RIGHT SOLUTION, GREAT QUALITY',
  footerIconUrl: null,
  embedColor: '#1A9EF3',
};

function customIds(payload) {
  return payload.components.flatMap(row => row.toJSON().components.map(component => component.custom_id));
}

test('dashboard navigation exposes every agreed management page and publish action', () => {
  const payload = buildVerificationDashboardPayload({
    guild: makeGuild(), ownerId: '99999999999999999', config,
  });
  const ids = customIds(payload);
  for (const page of ['overview', 'general', 'roles', 'appearance', 'guide', 'members', 'activity', 'preview']) {
    assert.ok(ids.includes('skaw_vf_admin:99999999999999999:page_' + page));
  }
  assert.ok(ids.includes('skaw_vf_admin:99999999999999999:publish'));
});


test('general settings keeps each channel select menu in its own action row', () => {
  const payload = buildVerificationDashboardPayload({
    guild: makeGuild(), ownerId: '99999999999999999', config, page: 'general',
  });
  const rows = payload.components.map(row => row.toJSON().components);
  assert.equal(rows.length, 5);
  for (const row of rows) {
    const hasSelect = row.some(component => component.custom_id.endsWith(':select_verification_channel')
      || component.custom_id.endsWith(':select_log_channel'));
    if (hasSelect) assert.equal(row.length, 1);
  }
  assert.ok(rows.some(row => row.some(component => component.custom_id.endsWith(':toggle_system'))));
});

test('role management dashboard exposes separate Unverified and multi-role selectors', () => {
  const payload = buildVerificationDashboardPayload({
    guild: makeGuild(), ownerId: '99999999999999999', config, page: 'roles',
  });
  const components = payload.components.flatMap(row => row.toJSON().components);
  const unverified = components.find(component => component.custom_id.endsWith(':select_unverified_role'));
  const rewards = components.find(component => component.custom_id.endsWith(':select_reward_roles'));
  assert.ok(unverified);
  assert.ok(rewards);
  assert.equal(unverified.max_values, 1);
  assert.equal(rewards.max_values, 25);
});

test('member management dashboard exposes a user selector and selected-member actions', () => {
  const payload = buildVerificationDashboardPayload({
    guild: makeGuild(), ownerId: '99999999999999999', config,
    page: 'members', selectedMemberId: '88888888888888888',
  });
  const ids = customIds(payload);
  assert.ok(ids.includes('skaw_vf_admin:99999999999999999:select_member'));
  assert.ok(ids.includes('skaw_vf_admin:99999999999999999:manual_88888888888888888'));
  assert.ok(ids.includes('skaw_vf_admin:99999999999999999:reset_88888888888888888'));
  assert.ok(ids.includes('skaw_vf_admin:99999999999999999:sync_88888888888888888'));
});

test('panel designer preview is generated as a single public-style embed', () => {
  const payload = buildVerificationDashboardPayload({
    guild: makeGuild(), ownerId: '99999999999999999', config, page: 'preview',
  });
  assert.equal(payload.embeds.length, 1);
  const embed = payload.embeds[0].toJSON();
  assert.equal(embed.title, 'SKAW Group Verification');
  assert.equal(embed.image.url, 'https://example.com/banner.png');
  assert.equal(embed.footer.text, 'RIGHT SOLUTION, GREAT QUALITY');
});
