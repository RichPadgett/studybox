export async function getSnapshot() {
    return request("/api/snapshot");
}
export async function postAction(path) {
    return request(path, { method: "POST" });
}
export async function saveSettings(settings) {
    return request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings)
    });
}
async function request(path, init) {
    const response = await fetch(path, init);
    if (!response.ok) {
        throw new Error(await response.text());
    }
    return response.json();
}
//# sourceMappingURL=api.js.map