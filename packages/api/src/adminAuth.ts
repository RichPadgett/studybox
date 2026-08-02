import { randomBytes, timingSafeEqual } from "node:crypto";
import type express from "express";
import { projectPath } from "./paths.js";
import { existsSync, readFileSync } from "node:fs";
import type { AdminSession } from "@studybox/shared";

const sessions = new Map<string, number>();
const sessionDurationMs = 12 * 60 * 60 * 1000;

export function createAdminSession(pin: string): AdminSession {
  if (!verifyPin(pin)) {
    throw new Error("Invalid admin PIN");
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAtMs = Date.now() + sessionDurationMs;
  sessions.set(token, expiresAtMs);

  return {
    token,
    expiresAt: new Date(expiresAtMs).toISOString()
  };
}

export function requireAdmin(request: express.Request, response: express.Response, next: express.NextFunction): void {
  const header = request.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token) {
    response.status(401).json({ error: "Admin authorization required" });
    return;
  }

  const expiresAtMs = sessions.get(token);
  if (!expiresAtMs || expiresAtMs <= Date.now()) {
    if (expiresAtMs) {
      sessions.delete(token);
    }
    response.status(401).json({ error: "Admin session expired" });
    return;
  }

  next();
}

function verifyPin(pin: string): boolean {
  const expected = getAdminPin();
  const pinBuffer = Buffer.from(pin);
  const expectedBuffer = Buffer.from(expected);
  return pinBuffer.length === expectedBuffer.length && timingSafeEqual(pinBuffer, expectedBuffer);
}

function getAdminPin(): string {
  loadDotEnvOnce();
  return process.env.STUDYBOX_ADMIN_PIN?.trim() || "364364";
}

let envLoaded = false;

function loadDotEnvOnce(): void {
  if (envLoaded) {
    return;
  }

  envLoaded = true;
  const path = projectPath(".env");
  if (!existsSync(path)) {
    return;
  }

  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");
    process.env[key] ??= value;
  }
}
