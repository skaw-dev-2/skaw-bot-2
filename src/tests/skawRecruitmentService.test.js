import test from 'node:test';
import assert from 'node:assert/strict';
import {
  slugifyRecruitmentProfile,
  normalizeRecruitmentPrefix,
  formatRecruitmentSequence,
  normalizeRecruitmentStatus,
  escapeRecruitmentHtml,
  buildRecruitmentTranscriptHtml,
  fetchRecruitmentTranscriptMessages,
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

test('transcript pagination fetches older pages and reports capped history', async () => {
  const message = (id, time) => ({
    id,
    createdTimestamp: time,
    createdAt: new Date(time),
    author: { tag: id },
    content: id,
    attachments: new Map(),
    embeds: [],
  });
  const calls = [];
  const channel = {
    messages: {
      async fetch({ limit, before }) {
        calls.push({ limit, before });
        if (!before) return new Map([
          ['3', message('3', 3000)],
          ['2', message('2', 2000)],
        ]);
        return new Map([['1', message('1', 1000)]]);
      },
    },
  };
  const result = await fetchRecruitmentTranscriptMessages(channel, 2);
  assert.equal(result.messageCount, 2);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.messages.map(item => item.id), ['2', '3']);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].before, '2');
});

test('transcript HTML visibly marks a capped export', () => {
  const html = buildRecruitmentTranscriptHtml({
    applicationId: 'SKAW-REC-000009',
    applicantTag: 'Applicant Three',
    profileSnapshot: { name: 'Trucker' },
  }, [], { truncated: true });
  assert.match(html, /Transcript dibatasi hingga 0 pesan terbaru/);
});
