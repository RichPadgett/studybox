import type { AdminSession, StudyBoxSettings, StudyBoxSnapshot, ZoomDeviceAuthorization, ZoomOAuthStatus } from "@studybox/shared";

let adminToken: string | undefined;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

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

export async function validateAdminSession(): Promise<AdminSession> {
  return request<AdminSession>("/api/admin/session");
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

export async function downloadRecording(recordingId: string): Promise<void> {
  const response = await fetch(`/api/podcast/recordings/${encodeURIComponent(recordingId)}/download`, {
    headers: authorizedHeaders()
  });
  if (!response.ok) {
    throw await createApiError(response);
  }

  const blob = await response.blob();
  const fileName = getDownloadFileName(response.headers.get("Content-Disposition")) ?? `${recordingId}.wav`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = authorizedHeaders(init?.headers);
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    throw await createApiError(response);
  }

  return response.json() as Promise<T>;
}

function authorizedHeaders(headersInit?: HeadersInit): Headers {
  const headers = new Headers(headersInit);
  if (adminToken) {
    headers.set("Authorization", `Bearer ${adminToken}`);
  }
  return headers;
}

function getDownloadFileName(contentDisposition: string | null): string | undefined {
  const match = contentDisposition?.match(/filename="?(?<fileName>[^";]+)"?/);
  return match?.groups?.fileName;
}

async function createApiError(response: Response): Promise<ApiError> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { error?: string };
    return new ApiError(response.status, parsed.error ?? body);
  } catch {
    return new ApiError(response.status, body);
  }
}
