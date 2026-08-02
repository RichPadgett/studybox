import { createHmac } from "node:crypto";
import type { ZoomConfig } from "./zoomConfig.js";

export interface ZoomSdkJwtOptions {
  expiresInSeconds?: number;
  issuedAt?: number;
}

export function createZoomSdkJwt(config: ZoomConfig, options: ZoomSdkJwtOptions = {}): string {
  if (!config.clientId || !config.clientSecret) {
    throw new Error("ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET are required to create a Meeting SDK JWT.");
  }

  const issuedAt = options.issuedAt ?? Math.floor(Date.now() / 1000);
  const expiresInSeconds = options.expiresInSeconds ?? 60 * 60 * 2;
  const payload = {
    appKey: config.clientId,
    sdkKey: config.clientId,
    mn: "",
    role: 1,
    iat: issuedAt,
    exp: issuedAt + expiresInSeconds,
    tokenExp: issuedAt + expiresInSeconds
  };

  return signJwt({ alg: "HS256", typ: "JWT" }, payload, config.clientSecret);
}

function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, secret: string): string {
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", secret).update(unsignedToken).digest("base64url");
  return `${unsignedToken}.${signature}`;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
