import cors from "cors";
import express from "express";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { createAdminSession, getAdminSession, requireAdmin } from "./adminAuth.js";
import { StudyBoxAppliance } from "./appliance.js";
import { LogStore } from "./logStore.js";
import { LibraryShareStore } from "./libraryShares.js";
import { SettingsStore } from "./settingsStore.js";
import { getZoomConfig, getZoomRuntimeStatus } from "./zoomConfig.js";
import { ZoomOAuthClient } from "./zoomOAuthClient.js";
import { ZoomOAuthStore } from "./zoomOAuthStore.js";
import { createZoomSdkJwt } from "./zoomSdkJwt.js";
import { ZoomZakService } from "./zoomZakService.js";
import { createValidationResponse, toWebhookRecord, verifyZoomWebhookSignature, webhookRecordToLog, type ZoomWebhookBody } from "./zoomWebhook.js";

const port = Number(process.env.PORT ?? 4000);
const execFileAsync = promisify(execFile);
const app = express();
const appliance = new StudyBoxAppliance(new SettingsStore(), new LogStore());
const zoomOAuthStore = new ZoomOAuthStore();
const libraryShares = new LibraryShareStore(process.env.STUDYBOX_LIBRARY_SHARES_PATH ?? "/var/lib/studybox/library/shares.json");
const webAdminContext = { source: "web" as const, actor: "admin" };
let backupRetryInProgress = false;

app.use(cors());
app.use(express.json({
  verify: (request, _response, buffer) => {
    (request as express.Request & { rawBody?: string }).rawBody = buffer.toString("utf8");
  }
}));

app.get("/api/snapshot", async (request, response, next) => {
  try {
    await appliance.syncMeetingState();
    response.json(appliance.snapshot(getDashboardViewerId(request)));
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/login", async (request, response, next) => {
  try {
    const session = createAdminSession(String(request.body?.pin ?? ""));
    await appliance.recordAudit({
      source: "web",
      actor: "admin",
      level: "info",
      action: "admin.login",
      result: "success",
      message: "Admin PIN accepted"
    });
    response.json(session);
  } catch (error) {
    await appliance.recordAudit({
      source: "web",
      actor: "admin",
      level: "warn",
      action: "admin.login",
      result: "failure",
      message: "Admin PIN rejected"
    });
    response.status(401).json({ error: error instanceof Error ? error.message : "Invalid admin PIN" });
  }
});

app.get("/api/admin/session", requireAdmin, (request, response) => {
  response.json(getAdminSession(request));
});

app.get("/api/zoom/status", (_request, response) => {
  response.json(getZoomRuntimeStatus());
});

app.post("/api/zoom/webhooks", async (request, response, next) => {
  try {
    const body = request.body as ZoomWebhookBody;
    const config = getZoomConfig();

    if (body.event === "endpoint.url_validation") {
      await appliance.recordAudit({
        source: "zoom-webhook",
        level: "info",
        action: "zoom.webhook.urlValidation",
        result: "success",
        message: "Zoom webhook URL validation received"
      });
      response.json(createValidationResponse(body, config));
      return;
    }

    const rawBody = (request as express.Request & { rawBody?: string }).rawBody ?? JSON.stringify(request.body);
    if (!verifyZoomWebhookSignature(request.headers, rawBody, config)) {
      await appliance.recordAudit({
        source: "zoom-webhook",
        level: "warn",
        action: "zoom.webhook.signature",
        result: "failure",
        message: "Invalid Zoom webhook signature"
      });
      response.status(401).json({ error: "Invalid Zoom webhook signature" });
      return;
    }

    const log = webhookRecordToLog(toWebhookRecord(body));
    await appliance.recordAudit({
      source: "zoom-webhook",
      level: log.level,
      action: `zoom.webhook.${body.event}`,
      result: "success",
      message: log.message
    });
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/zoom/device-authorization", requireAdmin, async (_request, response, next) => {
  try {
    const client = new ZoomOAuthClient(getZoomConfig());
    const authorization = await client.requestDeviceAuthorization();
    await appliance.recordAudit({
      ...webAdminContext,
      level: "info",
      action: "zoom.oauth.deviceAuthorization",
      result: "success",
      message: "Zoom device authorization started"
    });
    response.json(authorization);
  } catch (error) {
    next(error);
  }
});

app.post("/api/zoom/device-token", requireAdmin, async (request, response, next) => {
  try {
    const deviceCode = String(request.body?.deviceCode ?? "");
    if (!deviceCode) {
      response.status(400).json({ error: "deviceCode is required" });
      return;
    }

    const client = new ZoomOAuthClient(getZoomConfig());
    const token = await client.pollDeviceToken(deviceCode);
    try {
      token.user = await client.getCurrentUser(token.accessToken, token.apiUrl);
    } catch {
      token.user = undefined;
    }
    await zoomOAuthStore.save(token);
    await appliance.recordAudit({
      ...webAdminContext,
      level: "info",
      action: "zoom.oauth.deviceToken",
      result: "success",
      message: "Zoom account authorized"
    });
    response.json(zoomOAuthStore.getStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/zoom/refresh-token", requireAdmin, async (_request, response, next) => {
  try {
    const currentToken = zoomOAuthStore.get();
    if (!currentToken) {
      response.status(400).json({ error: "Zoom OAuth token has not been authorized yet" });
      return;
    }

    const client = new ZoomOAuthClient(getZoomConfig());
    const token = await client.refreshToken(currentToken.refreshToken);
    try {
      token.user = await client.getCurrentUser(token.accessToken, token.apiUrl);
    } catch {
      token.user = currentToken.user;
    }
    await zoomOAuthStore.save(token);
    await appliance.recordAudit({
      ...webAdminContext,
      level: "info",
      action: "zoom.oauth.refreshToken",
      result: "success",
      message: "Zoom OAuth token refreshed"
    });
    response.json(zoomOAuthStore.getStatus());
  } catch (error) {
    next(error);
  }
});

app.get("/api/zoom/zak/status", requireAdmin, async (_request, response, next) => {
  try {
    response.json(await new ZoomZakService().getZakStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/zoom/sdk-jwt", requireAdmin, (_request, response, next) => {
  try {
    response.json({
      token: createZoomSdkJwt(getZoomConfig()),
      expiresInSeconds: 7200
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/buttons/page", requireAdmin, async (_request, response, next) => {
  try {
    response.json(await appliance.pressPage());
  } catch (error) {
    next(error);
  }
});

app.post("/api/buttons/action", requireAdmin, async (_request, response, next) => {
  try {
    response.json(await appliance.pressAction());
  } catch (error) {
    next(error);
  }
});

app.post("/api/meeting/start", requireAdmin, async (_request, response, next) => {
  try {
    response.json(await appliance.startMeeting(webAdminContext));
  } catch (error) {
    next(error);
  }
});

app.post("/api/meeting/join-requests", async (request, response, next) => {
  try {
    const displayName = String(request.body?.displayName ?? "");
    response.json(await appliance.requestParticipantJoin(displayName, { source: "web", actor: "participant" }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/meeting/end", requireAdmin, async (_request, response, next) => {
  try {
    response.json(await appliance.endMeeting(webAdminContext));
  } catch (error) {
    next(error);
  }
});

app.post("/api/meeting/waiting/:participantId/admit", requireAdmin, async (request, response, next) => {
  try {
    response.json(await appliance.admitParticipant(request.params.participantId, webAdminContext));
  } catch (error) {
    next(error);
  }
});

app.post("/api/meeting/raised-hands/:participantId/dismiss", requireAdmin, async (request, response, next) => {
  try {
    response.json(await appliance.dismissRaisedHand(request.params.participantId, webAdminContext));
  } catch (error) {
    next(error);
  }
});

app.post("/api/meeting/raised-hands/:participantId/allow", requireAdmin, async (request, response, next) => {
  try {
    response.json(await appliance.allowParticipantToSpeak(request.params.participantId, webAdminContext));
  } catch (error) {
    next(error);
  }
});

app.post("/api/meeting/participants/:participantId/mute", requireAdmin, async (request, response, next) => {
  try {
    response.json(await appliance.muteParticipant(request.params.participantId, webAdminContext));
  } catch (error) {
    next(error);
  }
});

app.post("/api/meeting/participants/:participantId/host", requireAdmin, async (request, response, next) => {
  try {
    response.json(await appliance.makeParticipantHost(request.params.participantId, webAdminContext));
  } catch (error) {
    next(error);
  }
});

app.post("/api/meeting/screen-share/allow", requireAdmin, async (request, response, next) => {
  try {
    response.json(await appliance.allowScreenShare(webAdminContext));
  } catch (error) {
    next(error);
  }
});

app.post("/api/meeting/participants/:participantId/podcast-inclusion", requireAdmin, async (request, response, next) => {
  try {
    response.json(await appliance.setRemoteSpeakerPodcastInclusion(request.params.participantId, Boolean(request.body?.included), webAdminContext));
  } catch (error) {
    next(error);
  }
});

app.post("/api/audio/teacher-input", requireAdmin, async (request, response, next) => {
  try {
    response.json(await appliance.setTeacherAudioDevice(String(request.body?.deviceId ?? ""), webAdminContext));
  } catch (error) {
    next(error);
  }
});

app.post("/api/audio/audience-input", requireAdmin, async (request, response, next) => {
  try {
    response.json(await appliance.setAudienceAudioDevice(String(request.body?.deviceId ?? ""), webAdminContext));
  } catch (error) {
    next(error);
  }
});

app.post("/api/audio/speaker-output", requireAdmin, async (request, response, next) => {
  try {
    response.json(await appliance.setSpeakerAudioDevice(String(request.body?.deviceId ?? ""), webAdminContext));
  } catch (error) {
    next(error);
  }
});

app.post("/api/podcast/start", requireAdmin, async (_request, response, next) => {
  try {
    response.json(await appliance.startRecording(webAdminContext));
  } catch (error) {
    next(error);
  }
});

app.post("/api/podcast/pause", requireAdmin, async (_request, response, next) => {
  try {
    response.json(await appliance.pauseRecording(webAdminContext));
  } catch (error) {
    next(error);
  }
});

app.post("/api/podcast/resume", requireAdmin, async (_request, response, next) => {
  try {
    response.json(await appliance.resumeRecording(webAdminContext));
  } catch (error) {
    next(error);
  }
});

app.post("/api/podcast/stop", requireAdmin, async (_request, response, next) => {
  try {
    response.json(await appliance.stopRecording(webAdminContext));
  } catch (error) {
    next(error);
  }
});

app.get("/api/podcast/recordings/:recordingId/download", requireAdmin, async (request, response, next) => {
  try {
    const recordingFile = await appliance.getRecordingFile(request.params.recordingId, webAdminContext);
    if (recordingFile) {
      const fileStats = await stat(recordingFile.filePath);
      response
        .setHeader("Content-Type", recordingFile.mimeType)
        .setHeader("Content-Length", fileStats.size.toString())
        .setHeader("Content-Disposition", `attachment; filename="${recordingFile.fileName}"`);
      createReadStream(recordingFile.filePath).pipe(response);
      return;
    }

    const download = await appliance.getRecordingDownload(request.params.recordingId, webAdminContext);
    if (!download) {
      response.status(404).json({ error: "Recording not found" });
      return;
    }

    const content = Buffer.from(download.contentBase64, "base64");
    response
      .setHeader("Content-Type", download.mimeType)
      .setHeader("Content-Length", content.length.toString())
      .setHeader("Content-Disposition", `attachment; filename="${download.fileName}"`)
      .send(content);
  } catch (error) {
    next(error);
  }
});

app.get("/api/podcast/recordings/:recordingId/assets/:assetKind/download", requireAdmin, async (request, response, next) => {
  try {
    const assetKind = request.params.assetKind === "zoom" ? "zoom" : request.params.assetKind === "audio" ? "audio" : undefined;
    if (!assetKind) {
      response.status(400).json({ error: "Recording asset must be audio or zoom" });
      return;
    }

    const recordingFile = await appliance.getRecordingFile(request.params.recordingId, webAdminContext, assetKind);
    if (recordingFile) {
      const fileStats = await stat(recordingFile.filePath);
      response
        .setHeader("Content-Type", recordingFile.mimeType)
        .setHeader("Content-Length", fileStats.size.toString())
        .setHeader("Content-Disposition", `attachment; filename="${recordingFile.fileName}"`);
      createReadStream(recordingFile.filePath).pipe(response);
      return;
    }

    const archiveUrl = await appliance.getRecordingAssetUrl(request.params.recordingId, assetKind, webAdminContext);
    if (archiveUrl) {
      response.redirect(302, archiveUrl);
      return;
    }

    const download = await appliance.getRecordingAssetDownload(request.params.recordingId, assetKind, webAdminContext);
    if (!download) {
      response.status(404).json({ error: "Recording asset not found" });
      return;
    }

    const content = Buffer.from(download.contentBase64, "base64");
    response
      .setHeader("Content-Type", download.mimeType)
      .setHeader("Content-Length", content.length.toString())
      .setHeader("Content-Disposition", `attachment; filename="${download.fileName}"`)
      .send(content);
  } catch (error) {
    next(error);
  }
});

app.post("/api/backup/sync", requireAdmin, async (_request, response, next) => {
  try {
    response.json(await appliance.syncBackups(webAdminContext));
  } catch (error) {
    next(error);
  }
});

app.get("/api/library", requireAdmin, (_request, response) => {
  response.json(appliance.library.getState());
});

app.get("/api/library/search", requireAdmin, async (request, response, next) => {
  try {
    const query = String(request.query.q ?? "").trim();
    if (!query) {
      response.json([]);
      return;
    }
    response.json(await appliance.library.search(query, Math.min(Number(request.query.limit ?? 30) || 30, 100)));
  } catch (error) {
    next(error);
  }
});

app.get("/api/library/public", (_request, response) => {
  response.json({ documents: appliance.library.getState().documents });
});

app.get("/api/library/public/search", async (request, response, next) => {
  try {
    const query = String(request.query.q ?? "").trim();
    response.json(query ? await appliance.library.search(query, 50) : []);
  } catch (error) {
    next(error);
  }
});

app.get("/api/library/public/:recordingId/assets/:assetKind/download", async (request, response, next) => {
  try {
    const assetKind = request.params.assetKind === "zoom" ? "zoom" : request.params.assetKind === "audio" ? "audio" : undefined;
    if (!assetKind || !appliance.library.getDocument(request.params.recordingId)) {
      response.status(404).json({ error: "Public recording asset not found" });
      return;
    }
    const recordingFile = await appliance.getRecordingFile(request.params.recordingId, { source: "web" }, assetKind);
    if (recordingFile) {
      const fileStats = await stat(recordingFile.filePath);
      response.setHeader("Content-Type", recordingFile.mimeType).setHeader("Content-Length", fileStats.size.toString()).setHeader("Content-Disposition", `attachment; filename="${recordingFile.fileName}"`);
      createReadStream(recordingFile.filePath).pipe(response);
      return;
    }
    const archiveUrl = await appliance.getRecordingAssetUrl(request.params.recordingId, assetKind, { source: "web" });
    if (archiveUrl) {
      response.redirect(302, archiveUrl);
      return;
    }
    response.status(404).json({ error: "Public recording asset not found" });
  } catch (error) {
    next(error);
  }
});

app.get("/api/library/public/:recordingId", async (request, response, next) => {
  try {
    const document = appliance.library.getDocument(request.params.recordingId);
    if (!document) {
      response.status(404).json({ error: "Transcript not found" });
      return;
    }
    response.json({ document, fullText: await appliance.library.readFullText(request.params.recordingId) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/library/public/:recordingId/audio/:chunkIndex", async (request, response, next) => {
  try {
    const chunkIndex = Number(request.params.chunkIndex);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      response.status(400).json({ error: "Invalid audio chunk" });
      return;
    }
    const filePath = appliance.library.getAudioChunkPath(request.params.recordingId, chunkIndex);
    if (!filePath) {
      response.status(404).json({ error: "Audio chunk not found" });
      return;
    }
    const fileStats = await stat(filePath);
    response.setHeader("Content-Type", "audio/mp4");
    response.setHeader("Content-Length", fileStats.size);
    response.setHeader("Content-Disposition", `inline; filename="section-${chunkIndex + 1}.m4a"`);
    createReadStream(filePath).pipe(response);
  } catch (error) {
    next(error);
  }
});

app.get("/api/library/:recordingId", requireAdmin, async (request, response, next) => {
  try {
    const document = appliance.library.getDocument(request.params.recordingId);
    if (!document) {
      response.status(404).json({ error: "Transcript not found" });
      return;
    }
    response.json({ document, fullText: await appliance.library.readFullText(request.params.recordingId) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/library/:recordingId/audio/:chunkIndex", requireAdmin, async (request, response, next) => {
  try {
    const chunkIndex = Number(request.params.chunkIndex);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      response.status(400).json({ error: "Invalid audio chunk" });
      return;
    }
    const filePath = appliance.library.getAudioChunkPath(request.params.recordingId, chunkIndex);
    if (!filePath) {
      response.status(404).json({ error: "Audio chunk not found" });
      return;
    }
    const fileStats = await stat(filePath);
    response.setHeader("Content-Type", "audio/mp4");
    response.setHeader("Content-Length", fileStats.size);
    createReadStream(filePath).pipe(response);
  } catch (error) {
    next(error);
  }
});

app.post("/api/library/:recordingId/share", requireAdmin, async (request, response, next) => {
  try {
    if (!appliance.library.getDocument(request.params.recordingId)) {
      response.status(404).json({ error: "Transcript not found" });
      return;
    }
    const share = await libraryShares.create(request.params.recordingId);
    response.json({ token: share.token, url: `/share/${share.token}` });
  } catch (error) {
    next(error);
  }
});

app.get("/api/library/share/:token", async (request, response, next) => {
  try {
    const share = libraryShares.get(request.params.token);
    const document = share ? appliance.library.getDocument(share.recordingId) : undefined;
    if (!share || !document) {
      response.status(404).json({ error: "Shared transcript not found" });
      return;
    }
    response.json({ document, fullText: await appliance.library.readFullText(share.recordingId) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/library/share/:token/audio/:chunkIndex", async (request, response, next) => {
  try {
    const share = libraryShares.get(request.params.token);
    if (!share || !appliance.library.getDocument(share.recordingId)) {
      response.status(404).json({ error: "Shared transcript not found" });
      return;
    }
    const chunkIndex = Number(request.params.chunkIndex);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      response.status(400).json({ error: "Invalid audio chunk" });
      return;
    }
    const filePath = appliance.library.getAudioChunkPath(share.recordingId, chunkIndex);
    if (!filePath) {
      response.status(404).json({ error: "Audio chunk not found" });
      return;
    }
    const fileStats = await stat(filePath);
    response.setHeader("Content-Type", "audio/mp4");
    response.setHeader("Content-Length", fileStats.size);
    response.setHeader("Content-Disposition", `attachment; filename="section-${chunkIndex + 1}.m4a"`);
    createReadStream(filePath).pipe(response);
  } catch (error) {
    next(error);
  }
});

app.put("/api/settings", requireAdmin, async (request, response, next) => {
  try {
    response.json(await appliance.updateSettings(request.body, webAdminContext));
  } catch (error) {
    next(error);
  }
});

app.get("/api/network/wifi", requireAdmin, async (_request, response, next) => {
  try {
    const { stdout } = await execFileAsync("sudo", ["-n", "/opt/studybox/scripts/studybox-wifi-scan.py"], { timeout: 12_000 });
    response.json(JSON.parse(stdout));
  } catch (error) {
    next(error);
  }
});

app.post("/api/network/wifi", requireAdmin, async (request, response, next) => {
  try {
    const ssid = String(request.body?.ssid ?? "").trim();
    const password = String(request.body?.password ?? "");
    if (!ssid || (password.length > 0 && password.length < 8)) {
      response.status(400).json({ error: "A network name and a valid password are required" });
      return;
    }
    await execFileAsync("sudo", ["-n", "/opt/studybox/scripts/studybox-wifi-connect.py", ssid, password], { timeout: 20_000 });
    const saved = await appliance.updateSettings({
      ...appliance.getSettings(),
      wifi: { ssid, configured: true }
    }, webAdminContext);
    response.json({ settings: saved, message: `Saved ${ssid} for automatic connection` });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  response.status(500).json({ error: message });
});

await libraryShares.load();
await appliance.initialize();
startBackupRetryLoop();

app.listen(port, () => {
  console.log(`StudyBox API listening on http://localhost:${port}`);
});

function getDashboardViewerId(request: express.Request): string | undefined {
  return request.header("x-studybox-viewer-id")?.trim() || undefined;
}

function startBackupRetryLoop(): void {
  const retrySeconds = Number(process.env.STUDYBOX_BACKUP_RETRY_SECONDS ?? 300);
  if (!Number.isFinite(retrySeconds) || retrySeconds <= 0) {
    return;
  }

  const timer = setInterval(() => {
    if (backupRetryInProgress) {
      return;
    }

    backupRetryInProgress = true;
    void appliance.retryBackups()
      .catch((error: unknown) => {
        console.error("Backup retry failed", error);
      })
      .finally(() => {
        backupRetryInProgress = false;
      });
  }, retrySeconds * 1000);
  timer.unref();
}
