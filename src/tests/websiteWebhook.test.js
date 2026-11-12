import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { verifyWebsiteWebhookSignature } from '../integrations/websiteWebhook.js';

function signedRequest(secret, rawBody, timestamp = String(Math.floor(Date.now() / 1000)), eventId = randomUUID()) {
  const digest = createHmac('sha256', secret)
    .update(timestamp + '.' + eventId + '.')
    .update(rawBody)
    .digest('hex');
  return { secret, timestamp, eventId, signature: 'sha256=' + digest, rawBody };
}

test('accepts a valid signed SKAW website event', () => {
  const rawBody = Buffer.from(JSON.stringify({ id: 'event' }));
  const request = signedRequest('test-secret', rawBody);
  assert.equal(verifyWebsiteWebhookSignature(request), true);
});

test('rejects a modified request body', () => {
  const request = signedRequest('test-secret', Buffer.from('original'));
  request.rawBody = Buffer.from('modified');
  assert.equal(verifyWebsiteWebhookSignature(request), false);
});

test('rejects an incorrect secret and malformed signature', () => {
  const request = signedRequest('test-secret', Buffer.from('{}'));
  assert.equal(verifyWebsiteWebhookSignature({ ...request, secret: 'wrong-secret' }), false);
  assert.equal(verifyWebsiteWebhookSignature({ ...request, signature: 'sha256=bad' }), false);
});

test('rejects requests outside the five-minute timestamp window', () => {
  const oldTimestamp = String(Math.floor(Date.now() / 1000) - 301);
  const request = signedRequest('test-secret', Buffer.from('{}'), oldTimestamp);
  assert.equal(verifyWebsiteWebhookSignature(request), false);
});

test('rejects missing signature inputs', () => {
  assert.equal(verifyWebsiteWebhookSignature({ secret: 'test-secret' }), false);
});
