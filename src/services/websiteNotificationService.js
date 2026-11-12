import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import { EmbedBuilder } from "discord.js";
import { logger } from "../utils/logger.js";

const EVENT_TYPES = new Set(["inquiry.created", "application.created"]);
const seenEvents = new Map();
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;

function safeText(value, limit = 240) {
  return typeof value === "string"
    ? value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit)
    : "";
}

function validSignature(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || typeof signature !== "string" || !signature.startsWith("sha256=")) return false;
  const supplied = signature.slice(7);
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const actual = Buffer.from(supplied, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function registerWebsiteNotificationRoute(app, client) {
  app.post(
    "/api/integrations/website/events",
    express.raw({ type: "application/json", limit: "8kb" }),
    async (req, res) => {
      const secret = process.env.SKAW_WEBSITE_WEBHOOK_SECRET;
      const channelId = process.env.SKAW_WEBSITE_NOTIFICATION_CHANNEL_ID;

      if (!secret || !channelId) {
        return res.status(503).json({ error: "Website notification integration is not configured." });
      }

      if (!validSignature(req.body, req.get("x-skaw-signature"), secret)) {
        return res.status(401).json({ error: "Invalid signature." });
      }

      let body;
      try {
        body = JSON.parse(req.body.toString("utf8"));
      } catch {
        return res.status(400).json({ error: "Invalid JSON payload." });
      }

      const eventId = safeText(body?.eventId, 100);
      const type = safeText(body?.type, 40);
      const reference = safeText(body?.reference, 24);
      const summary = safeText(body?.summary, 180);
      const createdAt = safeText(body?.createdAt, 40);

      if (!eventId || !EVENT_TYPES.has(type) || !reference) {
        return res.status(400).json({ error: "Required event fields are invalid." });
      }

      const now = Date.now();
      for (const [id, timestamp] of seenEvents) {
        if (now - timestamp > MAX_EVENT_AGE_MS) seenEvents.delete(id);
      }
      if (seenEvents.has(eventId)) {
        return res.status(200).json({ success: true, duplicate: true });
      }

      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased?.() || typeof channel.send !== "function") {
          return res.status(503).json({ error: "Notification channel is unavailable." });
        }

        const title = type === "inquiry.created"
          ? "New website inquiry received"
          : "New career application received";
        const description = [
          summary || (type === "inquiry.created" ? "A new Contact Center inquiry is ready for review." : "A new career application is ready for review."),
          "",
          `**Reference:** ${reference}`,
          "**Next step:** Review the submission in the SKAW Group website admin dashboard.",
        ].join("\n");

        const embed = new EmbedBuilder()
          .setColor(0x1A9EF3)
          .setTitle(title)
          .setDescription(description)
          .setFooter({ text: "SKAW GROUP / WEBSITE INTEGRATION" })
          .setTimestamp(Number.isNaN(Date.parse(createdAt)) ? new Date() : new Date(createdAt));

        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        seenEvents.set(eventId, now);
        return res.status(202).json({ success: true });
      } catch (error) {
        logger.warn("Website notification delivery failed:", error instanceof Error ? error.message : "unknown");
        return res.status(503).json({ error: "Notification could not be delivered." });
      }
    },
  );
}
