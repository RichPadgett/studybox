import type { AdminSession, StudyBoxSettings, StudyBoxSnapshot, ZoomDeviceAuthorization, ZoomOAuthStatus } from "@studybox/shared";

let adminToken: string | undefined;

export function setAdminToken(token?: string): void {
  adminToken = token;
}

export async function loginAdmin(pin: string): Promise<AdminSession> {
  return request<AdminSession>("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin })
  });
}

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
  const headers = new Headers(init?.headers);
  if (adminToken) {
    headers.set("Authorization", `Bearer ${adminToken}`);
  }

  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<T>;
}
