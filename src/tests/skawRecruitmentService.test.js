import test from 'node:test';
import assert from 'node:assert/strict';
import {
  slugifyRecruitmentProfile,
  normalizeRecruitmentPrefix,
  formatRecruitmentSequence,
  normalizeRecruitmentStatus,
  escapeRecruitmentHtml,
  buildRecruitmentTranscriptHtml,
} from '../services/skawRecruitmentService.js';

test('profile keys are stable URL/channel-safe slugs', () => {
  assert.equal(slugifyRecruitmentProfile('Business Partnership & Retail'), 'business-partnership-retail');
  assert.equal(slugifyRecruitmentProfile('  SKAW   Motors  '), 'skaw-motors');
});

test('channel prefixes are normalized and validated', () => {
  assert.equal(normalizeRecruitmentPrefix('SKAW Workshop Division'), 'skaw-workshop-division');
  assert.throws(() => normalizeRecruitmentPrefix('---'), /prefix/i);
});

test('global sequence formatting is padded without truncating larger values', () => {
  assert.equal(formatRecruitmentSequence(7), '000007');
  assert.equal(formatRecruitmentSequence(12345, 4), '12345');
  assert.throws(() => formatRecruitmentSequence(0), /nomor/i);
});

test('application statuses are validated independently of ticket status', () => {
  assert.equal(normalizeRecruitmentStatus('under_review'), 'under_review');
  assert.throws(() => normalizeRecruitmentStatus('closed'), /status/i);
});

test('transcript HTML escapes untrusted content', () => {
  const html = escapeRecruitmentHtml('<script>alert("x")</script>');
  assert.equal(html, '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
});

test('transcript builder accepts the service camelCase application model', () => {
  const html = buildRecruitmentTranscriptHtml({
    applicationId: 'SKAW-REC-000007',
    applicantTag: 'Applicant <one>',
    profileSnapshot: { name: 'Mechanic' },
  }, [{
    author: { tag: 'Member <tag>' },
    createdAt: new Date('2026-11-06T00:00:00.000Z'),
    content: '<b>hello</b>',
    attachments: new Map(),
    embeds: [],
  }]);
  assert.match(html, /SKAW-REC-000007/);
  assert.match(html, /Applicant &lt;one&gt;/);
  assert.match(html, /Member &lt;tag&gt;/);
  assert.match(html, /&lt;b&gt;hello&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<script>|<b>hello<\/b>/);
});

test('transcript builder also supports raw PostgreSQL snake_case rows', () => {
  const html = buildRecruitmentTranscriptHtml({
    application_id: 'SKAW-REC-000008',
    applicant_tag: 'Applicant Two',
    profile_snapshot: { name: 'Builder' },
  }, []);
  assert.match(html, /SKAW-REC-000008/);
  assert.match(html, /Applicant Two/);
  assert.match(html, /Builder/);
});
