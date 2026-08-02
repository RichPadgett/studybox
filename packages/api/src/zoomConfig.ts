import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ZoomRuntimeStatus } from "@studybox/shared";

export interface ZoomConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  accountId?: string;
  webhookSecretToken?: string;
  meetingMode: "mock" | "runner";
  sdkArch: "linux-arm64" | "linux-x86_64" | "unknown";
  runnerPath?: string;
}

export function getZoomConfig(): ZoomConfig {
  return {
    clientId: readEnv("ZOOM_CLIENT_ID"),
    clientSecret: readEnv("ZOOM_CLIENT_SECRET"),
    redirectUri: readEnv("ZOOM_REDIRECT_URI"),
    accountId: readEnv("ZOOM_ACCOUNT_ID"),
    webhookSecretToken: readEnv("ZOOM_WEBHOOK_SECRET_TOKEN"),
    meetingMode: readEnv("ZOOM_MEETING_MODE") === "runner" ? "runner" : "mock",
    sdkArch: parseSdkArch(readEnv("ZOOM_SDK_ARCH")),
    runnerPath: readEnv("ZOOM_RUNNER_PATH")
  };
}

export function getZoomRuntimeStatus(config = getZoomConfig()): ZoomRuntimeStatus {
  const runnerPath = config.runnerPath ? resolve(process.cwd(), config.runnerPath) : undefined;
  const clientIdConfigured = Boolean(config.clientId);
  const clientSecretConfigured = Boolean(config.clientSecret);

  return {
    mode: config.meetingMode,
    configured: clientIdConfigured && clientSecretConfigured,
    clientIdConfigured,
    clientSecretConfigured,
    webhookSecretConfigured: Boolean(config.webhookSecretToken),
    redirectUri: config.redirectUri,
    runnerPath,
    runnerAvailable: runnerPath ? existsSync(runnerPath) : false,
    sdkArch: config.sdkArch
  };
}

function readEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function parseSdkArch(value: string | undefined): ZoomConfig["sdkArch"] {
  if (value === "linux-arm64" || value === "linux-x86_64") {
    return value;
  }

  return "unknown";
}
