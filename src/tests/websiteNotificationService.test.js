import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import express from "express";
import { registerWebsiteNotificationRoute } from "../services/websiteNotificationService.js";

async function createServer(t, channelSend = async () => {}) {
  const previousSecret = process.env.SKAW_WEBSITE_WEBHOOK_SECRET;
  const previousChannel = process.env.SKAW_WEBSITE_NOTIFICATION_CHANNEL_ID;
  process.env.SKAW_WEBSITE_WEBHOOK_SECRET = "test-secret-with-enough-entropy-for-unit-tests";
  process.env.SKAW_WEBSITE_NOTIFICATION_CHANNEL_ID = "test-channel-id";

  const client = {
    channels: {
      fetch: async (id) => {
        assert.equal(id, "test-channel-id");
        return {
          isTextBased: () => true,
          send: channelSend,
        };
      },
    },
  };
  const app = express();
  registerWebsiteNotificationRoute(app, client);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address();

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (previousSecret === undefined) delete process.env.SKAW_WEBSITE_WEBHOOK_SECRET;
    else process.env.SKAW_WEBSITE_WEBHOOK_SECRET = previousSecret;
    if (previousChannel === undefined) delete process.env.SKAW_WEBSITE_NOTIFICATION_CHANNEL_ID;
    else process.env.SKAW_WEBSITE_NOTIFICATION_CHANNEL_ID = previousChannel;
  });

  return { url: `http://127.0.0.1:${port}/api/integrations/website/events` };
}

function signedRequest(url, payload, overrides = {}) {
  const raw = JSON.stringify(payload);
  const signature = createHmac("sha256", process.env.SKAW_WEBSITE_WEBHOOK_SECRET).update(raw).digest("hex");
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SKAW-Signature": `sha256=${signature}`,
      ...overrides,
    },
    body: raw,
  });
}

const payload = (eventId) => ({
  eventId,
  type: "inquiry.created",
  reference: "A1B2C3D4",
  summary: "A new Contact Center inquiry is ready for review.",
  createdAt: new Date().toISOString(),
});

test("rejects requests without a valid HMAC signature", async (t) => {
  const { url } = await createServer(t);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SKAW-Signature": "sha256=" + "0".repeat(64) },
    body: JSON.stringify(payload("invalid-signature-event")),
  });
  assert.equal(response.status, 401);
});

test("posts a compact notification and suppresses duplicate event IDs", async (t) => {
  let sent = 0;
  const { url } = await createServer(t, async (message) => {
    sent += 1;
    assert.equal(message.allowedMentions.parse.length, 0);
    assert.equal(message.embeds.length, 1);
    const embed = message.embeds[0].toJSON();
    assert.match(embed.title, /website inquiry/i);
    assert.match(embed.description, /A1B2C3D4/);
    assert.doesNotMatch(embed.description, /discord\.com\/users|phone|email/i);
  });
  const event = payload("dedupe-test-event-01");

  const first = await signedRequest(url, event);
  assert.equal(first.status, 202);
  const firstBody = await first.json();
  assert.equal(firstBody.success, true);

  const second = await signedRequest(url, event);
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.duplicate, true);
  assert.equal(sent, 1);
});

test("rejects event types outside the website integration contract", async (t) => {
  const { url } = await createServer(t);
  const response = await signedRequest(url, { ...payload("invalid-type-event"), type: "admin.user.deleted" });
  assert.equal(response.status, 400);
});
