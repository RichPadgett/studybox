import { createHmac, timingSafeEqual } from "node:crypto";
import type { LogEntry } from "@studybox/shared";
import type { ZoomConfig } from "./zoomConfig.js";

export interface ZoomWebhookBody {
  event?: string;
  event_ts?: number;
  payload?: {
    plainToken?: string;
    object?: Record<string, unknown>;
  };
}

export interface ZoomWebhookValidationResponse {
  plainToken: string;
  encryptedToken: string;
}

export interface ZoomWebhookRecord {
  event: string;
  eventTs?: number;
  meetingId?: string;
  participantName?: string;
  participantId?: string;
}

export function createValidationResponse(body: ZoomWebhookBody, config: ZoomConfig): ZoomWebhookValidationResponse {
  const plainToken = body.payload?.plainToken;
  if (!plainToken) {
    throw new Error("Zoom webhook validation payload is missing plainToken.");
  }

  return {
    plainToken,
    encryptedToken: createHmac("sha256", requireWebhookSecret(config)).update(plainToken).digest("hex")
  };
}

export function verifyZoomWebhookSignature(headers: Record<string, string | string[] | undefined>, rawBody: string, config: ZoomConfig): boolean {
  const signature = headerValue(headers["x-zm-signature"]);
  const timestamp = headerValue(headers["x-zm-request-timestamp"]);
  if (!signature || !timestamp) {
    return false;
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > 300) {
    return false;
  }

  const message = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", requireWebhookSecret(config)).update(message).digest("hex")}`;
  return safeEqual(signature, expected);
}

export function toWebhookRecord(body: ZoomWebhookBody): ZoomWebhookRecord {
  const object = body.payload?.object;
  const participant = object?.participant as Record<string, unknown> | undefined;

  return {
    event: body.event ?? "unknown",
    eventTs: body.event_ts,
    meetingId: stringValue(object?.id) ?? stringValue(object?.uuid),
    participantName: stringValue(participant?.user_name) ?? stringValue(participant?.name),
    participantId: stringValue(participant?.id) ?? stringValue(participant?.user_id)
  };
}

export function webhookRecordToLog(record: ZoomWebhookRecord): Pick<LogEntry, "source" | "level" | "message"> {
  const participant = record.participantName ? ` (${record.participantName})` : "";
  const meeting = record.meetingId ? ` for meeting ${record.meetingId}` : "";
  return {
    source: "meeting",
    level: "info",
    message: `Zoom webhook ${record.event}${participant}${meeting}`
  };
}

function requireWebhookSecret(config: ZoomConfig): string {
  if (!config.webhookSecretToken) {
    throw new Error("ZOOM_WEBHOOK_SECRET_TOKEN is required for Zoom webhooks.");
  }

  return config.webhookSecretToken;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}
