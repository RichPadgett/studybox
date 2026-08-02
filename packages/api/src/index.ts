import cors from "cors";
import express from "express";
import { createAdminSession, requireAdmin } from "./adminAuth.js";
import { StudyBoxAppliance } from "./appliance.js";
import { SettingsStore } from "./settingsStore.js";
import { getZoomConfig, getZoomRuntimeStatus } from "./zoomConfig.js";
import { ZoomOAuthClient } from "./zoomOAuthClient.js";
import { ZoomOAuthStore } from "./zoomOAuthStore.js";
import { createZoomSdkJwt } from "./zoomSdkJwt.js";
import { ZoomZakService } from "./zoomZakService.js";
import { createValidationResponse, toWebhookRecord, verifyZoomWebhookSignature, webhookRecordToLog, type ZoomWebhookBody } from "./zoomWebhook.js";

const port = Number(process.env.PORT ?? 4000);
const app = express();
const appliance = new StudyBoxAppliance(new SettingsStore());
const zoomOAuthStore = new ZoomOAuthStore();

app.use(cors());
app.use(express.json({
  verify: (request, _response, buffer) => {
    (request as express.Request & { rawBody?: string }).rawBody = buffer.toString("utf8");
  }
}));

app.get("/api/snapshot", (_request, response) => {
  response.json(appliance.snapshot());
});

app.post("/api/admin/login", (request, response, next) => {
  try {
    response.json(createAdminSession(String(request.body?.pin ?? "")));
  } catch (error) {
    response.status(401).json({ error: error instanceof Error ? error.message : "Invalid admin PIN" });
  }
});

app.get("/api/zoom/status", (_request, response) => {
  response.json(getZoomRuntimeStatus());
});

app.post("/api/zoom/webhooks", (request, response, next) => {
  try {
    const body = request.body as ZoomWebhookBody;
    const config = getZoomConfig();

    if (body.event === "endpoint.url_validation") {
      response.json(createValidationResponse(body, config));
      return;
    }

    const rawBody = (request as express.Request & { rawBody?: string }).rawBody ?? JSON.stringify(request.body);
    if (!verifyZoomWebhookSignature(request.headers, rawBody, config)) {
      response.status(401).json({ error: "Invalid Zoom webhook signature" });
      return;
    }

    const log = webhookRecordToLog(toWebhookRecord(body));
    appliance.recordExternalLog(log.source, log.level, log.message);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/zoom/device-authorization", requireAdmin, async (_request, response, next) => {
  try {
    const client = new ZoomOAuthClient(getZoomConfig());
    response.json(await client.requestDeviceAuthorization());
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
    response.json(await appliance.startMeeting());
  } catch (error) {
    next(error);
  }
});

app.post("/api/meeting/end", requireAdmin, async (_request, response, next) => {
  try {
    response.json(await appliance.endMeeting());
  } catch (error) {
    next(error);
  }
});

app.post("/api/meeting/waiting/:participantId/admit", requireAdmin, async (request, response, next) => {
  try {
    response.json(await appliance.admitParticipant(request.params.participantId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/meeting/raised-hands/:participantId/dismiss", requireAdmin, async (request, response, next) => {
  try {
    response.json(await appliance.dismissRaisedHand(request.params.participantId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/meeting/raised-hands/:participantId/allow", requireAdmin, async (request, response, next) => {
  try {
    response.json(await appliance.allowParticipantToSpeak(request.params.participantId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/meeting/participants/:participantId/mute", requireAdmin, async (request, response, next) => {
  try {
    response.json(await appliance.muteParticipant(request.params.participantId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/podcast/start", requireAdmin, async (_request, response, next) => {
  try {
    response.json(await appliance.startRecording());
  } catch (error) {
    next(error);
  }
});

app.post("/api/podcast/pause", requireAdmin, async (_request, response, next) => {
  try {
    response.json(await appliance.pauseRecording());
  } catch (error) {
    next(error);
  }
});

app.post("/api/podcast/resume", requireAdmin, async (_request, response, next) => {
  try {
    response.json(await appliance.resumeRecording());
  } catch (error) {
    next(error);
  }
});

app.post("/api/podcast/stop", requireAdmin, async (_request, response, next) => {
  try {
    response.json(await appliance.stopRecording());
  } catch (error) {
    next(error);
  }
});

app.put("/api/settings", requireAdmin, async (request, response, next) => {
  try {
    response.json(await appliance.updateSettings(request.body));
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  response.status(500).json({ error: message });
});

await appliance.initialize();

app.listen(port, () => {
  console.log(`StudyBox API listening on http://localhost:${port}`);
});
