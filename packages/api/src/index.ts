import cors from "cors";
import express from "express";
import { StudyBoxAppliance } from "./appliance.js";
import { SettingsStore } from "./settingsStore.js";
import { getZoomConfig, getZoomRuntimeStatus } from "./zoomConfig.js";
import { ZoomOAuthClient } from "./zoomOAuthClient.js";
import { ZoomOAuthStore } from "./zoomOAuthStore.js";
import { createZoomSdkJwt } from "./zoomSdkJwt.js";

const port = Number(process.env.PORT ?? 4000);
const app = express();
const appliance = new StudyBoxAppliance(new SettingsStore());
const zoomOAuthStore = new ZoomOAuthStore();

app.use(cors());
app.use(express.json());

app.get("/api/snapshot", (_request, response) => {
  response.json(appliance.snapshot());
});

app.get("/api/zoom/status", (_request, response) => {
  response.json(getZoomRuntimeStatus());
});

app.post("/api/zoom/device-authorization", async (_request, response, next) => {
  try {
    const client = new ZoomOAuthClient(getZoomConfig());
    response.json(await client.requestDeviceAuthorization());
  } catch (error) {
    next(error);
  }
});

app.post("/api/zoom/device-token", async (request, response, next) => {
  try {
    const deviceCode = String(request.body?.deviceCode ?? "");
    if (!deviceCode) {
      response.status(400).json({ error: "deviceCode is required" });
      return;
    }

    const client = new ZoomOAuthClient(getZoomConfig());
    const token = await client.pollDeviceToken(deviceCode);
    token.user = await client.getCurrentUser(token.accessToken, token.apiUrl);
    await zoomOAuthStore.save(token);
    response.json(zoomOAuthStore.getStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/zoom/refresh-token", async (_request, response, next) => {
  try {
    const currentToken = zoomOAuthStore.get();
    if (!currentToken) {
      response.status(400).json({ error: "Zoom OAuth token has not been authorized yet" });
      return;
    }

    const client = new ZoomOAuthClient(getZoomConfig());
    const token = await client.refreshToken(currentToken.refreshToken);
    token.user = await client.getCurrentUser(token.accessToken, token.apiUrl);
    await zoomOAuthStore.save(token);
    response.json(zoomOAuthStore.getStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/zoom/sdk-jwt", (_request, response, next) => {
  try {
    response.json({
      token: createZoomSdkJwt(getZoomConfig()),
      expiresInSeconds: 7200
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/buttons/page", async (_request, response, next) => {
  try {
    response.json(await appliance.pressPage());
  } catch (error) {
    next(error);
  }
});

app.post("/api/buttons/action", async (_request, response, next) => {
  try {
    response.json(await appliance.pressAction());
  } catch (error) {
    next(error);
  }
});

app.post("/api/meeting/start", async (_request, response, next) => {
  try {
    response.json(await appliance.startMeeting());
  } catch (error) {
    next(error);
  }
});

app.post("/api/meeting/end", async (_request, response, next) => {
  try {
    response.json(await appliance.endMeeting());
  } catch (error) {
    next(error);
  }
});

app.post("/api/meeting/waiting/:participantId/admit", async (request, response, next) => {
  try {
    response.json(await appliance.admitParticipant(request.params.participantId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/meeting/raised-hands/:participantId/dismiss", async (request, response, next) => {
  try {
    response.json(await appliance.dismissRaisedHand(request.params.participantId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/podcast/start", async (_request, response, next) => {
  try {
    response.json(await appliance.startRecording());
  } catch (error) {
    next(error);
  }
});

app.post("/api/podcast/pause", async (_request, response, next) => {
  try {
    response.json(await appliance.pauseRecording());
  } catch (error) {
    next(error);
  }
});

app.post("/api/podcast/resume", async (_request, response, next) => {
  try {
    response.json(await appliance.resumeRecording());
  } catch (error) {
    next(error);
  }
});

app.post("/api/podcast/stop", async (_request, response, next) => {
  try {
    response.json(await appliance.stopRecording());
  } catch (error) {
    next(error);
  }
});

app.put("/api/settings", async (request, response, next) => {
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
