import { createHmac, timingSafeEqual } from 'node:crypto';
import { EmbedBuilder } from 'discord.js';

const MAX_CLOCK_SKEW_SECONDS = 300;
const EVENT_TTL_MS = 10 * 60 * 1000;
const recentEvents = new Map();

function clean(value, limit = 120) {
  return typeof value === 'string'
    ? value.replace(/[\r\n\u0000-\u001f]+/g, ' ').trim().slice(0, limit)
    : '';
}

export function verifyWebsiteWebhookSignature({
  secret,
  timestamp,
  eventId,
  signature,
  rawBody,
  nowMs = Date.now(),
}) {
  if (!secret || !timestamp || !eventId || !signature || !Buffer.isBuffer(rawBody)) return false;
  if (!/^\d{10}$/.test(timestamp) || !/^[0-9a-f-]{36}$/i.test(eventId)) return false;
  if (!/^sha256=[0-9a-f]{64}$/i.test(signature)) return false;

  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS) {
    return false;
  }

  const expected = createHmac('sha256', secret)
    .update(timestamp + '.' + eventId + '.')
    .update(rawBody)
    .digest();
  const received = Buffer.from(signature.slice(7), 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function pruneRecentEvents(now = Date.now()) {
  for (const [id, seenAt] of recentEvents) {
    if (now - seenAt > EVENT_TTL_MS) recentEvents.delete(id);
  }
  while (recentEvents.size > 2000) {
    const oldest = recentEvents.keys().next().value;
    if (!oldest) break;
    recentEvents.delete(oldest);
  }
}

function buildWebsiteEmbed(event) {
  const isApplication = event.type === 'application.created';
  const isSupport = event.type === 'support.created';
  const data = event.data || {};
  const title = isApplication
    ? 'New SKAW career application'
    : isSupport ? 'New SKAW Support request' : 'New SKAW website inquiry';
  const description = isApplication
    ? 'A new recruitment application has been submitted through the SKAW Group website.'
    : event.type === 'partnership.created'
      ? 'A new partnership proposal has been submitted through the SKAW Group website.'
      : isSupport
        ? 'A new Support Center request has been submitted through the SKAW Group website.'
        : 'A new Contact Center inquiry has been submitted through the SKAW Group website.';
  const fields = [
    { name: 'Reference', value: clean(event.reference, 24) || 'Not available', inline: true },
    { name: 'Applicant / Sender', value: clean(data.name, 80) || 'Not provided', inline: true },
  ];

  if (event.type === 'application.created') {
    fields.push({ name: 'Position', value: clean(data.position, 100) || 'Not specified', inline: true });
  } else {
    fields.push({ name: 'Inquiry type', value: clean(data.category, 60) || 'General', inline: true });
  }

  fields.push({
    name: 'Next step',
    value: 'Open the protected SKAW website Admin dashboard to review the complete submission.',
    inline: false,
  });

  return new EmbedBuilder()
    .setColor(0x168BFF)
    .setTitle(title)
    .setDescription(description)
    .addFields(fields)
    .setURL('https://skaw-group.vercel.app/admin')
    .setFooter({ text: 'SKAW GROUP · WEBSITE INTEGRATION' })
    .setTimestamp(event.createdAt && !Number.isNaN(Date.parse(event.createdAt))
      ? new Date(event.createdAt)
      : new Date());
}

export function createWebsiteWebhookHandler(client) {
  return async (request, response) => {
    const secret = process.env.SKAW_WEBSITE_WEBHOOK_SECRET;
    if (!secret) {
      return response.status(503).json({ error: 'Website integration is not configured.' });
    }

    const rawBody = request.body;
    const timestamp = request.get('x-skaw-timestamp');
    const eventId = request.get('x-skaw-event-id');
    const signature = request.get('x-skaw-signature');

    if (!verifyWebsiteWebhookSignature({ secret, timestamp, eventId, signature, rawBody })) {
      return response.status(401).json({ error: 'Invalid webhook signature.' });
    }

    pruneRecentEvents();
    if (recentEvents.has(eventId)) {
      return response.status(200).json({ accepted: true, duplicate: true });
    }
    // Reserve the event ID before awaiting Discord so concurrent retries cannot
    // deliver the same notification twice.
    recentEvents.set(eventId, Date.now());

    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      recentEvents.delete(eventId);
      return response.status(400).json({ error: 'Invalid JSON payload.' });
    }

    const allowedTypes = new Set(['inquiry.created', 'partnership.created', 'support.created', 'application.created']);
    if (!event || event.id !== eventId || !allowedTypes.has(event.type)
      || typeof event.reference !== 'string' || !event.data || typeof event.data !== 'object') {
      recentEvents.delete(eventId);
      return response.status(400).json({ error: 'Invalid website event payload.' });
    }

    const channelId = process.env.SKAW_WEBSITE_NOTIFICATIONS_CHANNEL_ID;
    if (!channelId || !/^\d{17,20}$/.test(channelId)) {
      recentEvents.delete(eventId);
      return response.status(503).json({ error: 'Website notification channel is not configured.' });
    }

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || typeof channel.send !== 'function') {
        recentEvents.delete(eventId);
        return response.status(503).json({ error: 'Configured notification channel is unavailable.' });
      }

      await channel.send({ embeds: [buildWebsiteEmbed(event)] });
      recentEvents.set(eventId, Date.now());
      return response.status(202).json({ accepted: true });
    } catch (error) {
      client.logger?.error?.('SKAW website webhook delivery failed', {
        eventId,
        error: error instanceof Error ? error.message : String(error),
      });
      recentEvents.delete(eventId);
      return response.status(503).json({ error: 'Could not deliver website notification.' });
    }
  };
}
