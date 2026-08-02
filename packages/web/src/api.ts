import type { StudyBoxSettings, StudyBoxSnapshot } from "@studybox/shared";

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<T>;
}
