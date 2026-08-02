import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StudyBoxSettings } from "@studybox/shared";
import { projectPath } from "./paths.js";

const settingsPath = projectPath("data/settings.json");

export const defaultSettings: StudyBoxSettings = {
  schedule: {
    dayOfWeek: "Saturday",
    time: "11:00",
    timezone: "America/New_York",
    autoStartMeeting: true,
    autoStartRecording: true
  },
  moderation: {
    mode: "moderated",
    joinMuted: true,
    raiseHandRequired: true,
    assistantApprovesSpeakers: true
  },
  zoom: {
    meetingNumber: "",
    displayName: "StudyBox",
    clientIdConfigured: false,
    sdkSecretConfigured: false,
    webhookSecretConfigured: false,
    redirectUri: "https://studybox.enochscalendar.com/zoom/oauth/callback",
    deviceOAuthEnabled: true
  },
  audio: {
    inputDevice: "DJI Mic Receiver (Mock)",
    gain: 70,
    monitorEnabled: false
  },
  wifi: {
    ssid: "",
    configured: false
  },
  cloudflare: {
    tunnelEnabled: false,
    hostname: ""
  },
  oled: {
    brightness: 80,
    rotate180: false
  }
};

export class SettingsStore {
  private settings = defaultSettings;

  async load(): Promise<StudyBoxSettings> {
    try {
      const raw = await readFile(settingsPath, "utf8");
      this.settings = { ...defaultSettings, ...JSON.parse(raw) } as StudyBoxSettings;
    } catch {
      await this.save(defaultSettings);
    }

    return this.settings;
  }

  get(): StudyBoxSettings {
    return this.settings;
  }

  async save(settings: StudyBoxSettings): Promise<StudyBoxSettings> {
    this.settings = settings;
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));
    return this.settings;
  }
}
