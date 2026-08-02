import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ZoomRuntimeStatus } from "@studybox/shared";
import { projectPath } from "./paths.js";
import { ZoomOAuthStore } from "./zoomOAuthStore.js";

export interface ZoomConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  accountId?: string;
  webhookSecretToken?: string;
  meetingMode: "mock" | "runner";
  sdkArch: "linux-arm64" | "linux-x86_64" | "unknown";
  runnerPath?: string;
  runnerCommand?: string;
  runnerArgs: string[];
}

export function getZoomConfig(): ZoomConfig {
  loadDotEnv();
  return {
    clientId: readEnv("ZOOM_CLIENT_ID"),
    clientSecret: readEnv("ZOOM_CLIENT_SECRET"),
    redirectUri: readEnv("ZOOM_REDIRECT_URI"),
    accountId: readEnv("ZOOM_ACCOUNT_ID"),
    webhookSecretToken: readEnv("ZOOM_WEBHOOK_SECRET_TOKEN"),
    meetingMode: readEnv("ZOOM_MEETING_MODE") === "runner" ? "runner" : "mock",
    sdkArch: parseSdkArch(readEnv("ZOOM_SDK_ARCH")),
    runnerPath: readEnv("ZOOM_RUNNER_PATH"),
    runnerCommand: readEnv("ZOOM_RUNNER_COMMAND"),
    runnerArgs: parseArgs(readEnv("ZOOM_RUNNER_ARGS"))
  };
}

export function getZoomRuntimeStatus(config = getZoomConfig()): ZoomRuntimeStatus {
  const runnerPath = config.runnerPath ? resolve(projectPath(), config.runnerPath) : undefined;
  const clientIdConfigured = Boolean(config.clientId);
  const clientSecretConfigured = Boolean(config.clientSecret);
  const oauthStore = new ZoomOAuthStore();

  return {
    mode: config.meetingMode,
    configured: clientIdConfigured && clientSecretConfigured,
    clientIdConfigured,
    clientSecretConfigured,
    webhookSecretConfigured: Boolean(config.webhookSecretToken),
    redirectUri: config.redirectUri,
    runnerPath,
    runnerAvailable: runnerPath ? existsSync(runnerPath) : false,
    sdkArch: config.sdkArch,
    oauth: oauthStore.getStatus()
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

function parseArgs(value: string | undefined): string[] {
  return value?.split(" ").map((item) => item.trim()).filter(Boolean) ?? [];
}

let envLoaded = false;

function loadDotEnv(): void {
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
