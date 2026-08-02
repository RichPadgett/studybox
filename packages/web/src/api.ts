import type { StudyBoxSettings, StudyBoxSnapshot, ZoomDeviceAuthorization, ZoomOAuthStatus } from "@studybox/shared";

export async function getSnapshot(): Promise<StudyBoxSnapshot> {
  return request<StudyBoxSnapshot>("/api/snapshot");
}

export async function postAction(path: string): Promise<StudyBoxSnapshot> {
  return request<StudyBoxSnapshot>(path, { method: "POST" });
}

export async function saveSettings(settings: StudyBoxSettings): Promise<StudyBoxSettings> {
  return request<StudyBoxSettings>("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings)
  });
}

export async function startZoomDeviceAuthorization(): Promise<ZoomDeviceAuthorization> {
  return request<ZoomDeviceAuthorization>("/api/zoom/device-authorization", { method: "POST" });
}

export async function pollZoomDeviceToken(deviceCode: string): Promise<ZoomOAuthStatus> {
  return request<ZoomOAuthStatus>("/api/zoom/device-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceCode })
  });
}

export async function refreshZoomToken(): Promise<ZoomOAuthStatus> {
  return request<ZoomOAuthStatus>("/api/zoom/refresh-token", { method: "POST" });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<T>;
}
