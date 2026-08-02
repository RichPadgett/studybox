import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Activity, AudioLines, ClipboardList, Disc3, Gauge, Hand, Mic, MonitorDot, Network, Radio, Save, Settings, Square, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getSnapshot, postAction, saveSettings } from "./api.js";
const navItems = [
    { id: "dashboard", label: "Dashboard", icon: Gauge },
    { id: "meeting", label: "Meeting", icon: Users },
    { id: "podcast", label: "Podcast", icon: Mic },
    { id: "audio", label: "Audio", icon: AudioLines },
    { id: "recordings", label: "Recordings", icon: Disc3 },
    { id: "settings", label: "Settings", icon: Settings },
    { id: "diagnostics", label: "Diagnostics", icon: Activity },
    { id: "logs", label: "Logs", icon: ClipboardList },
    { id: "network", label: "Network", icon: Network }
];
export function App() {
    const [snapshot, setSnapshot] = useState();
    const [activeNav, setActiveNav] = useState("dashboard");
    const [error, setError] = useState();
    const [saving, setSaving] = useState(false);
    async function refresh() {
        try {
            setSnapshot(await getSnapshot());
            setError(undefined);
        }
        catch (caught) {
            setError(caught instanceof Error ? caught.message : "Unable to reach StudyBox API");
        }
    }
    async function run(path) {
        try {
            setSnapshot(await postAction(path));
            setError(undefined);
        }
        catch (caught) {
            setError(caught instanceof Error ? caught.message : "Command failed");
        }
    }
    async function persistSettings(settings) {
        setSaving(true);
        try {
            await saveSettings(settings);
            await refresh();
        }
        catch (caught) {
            setError(caught instanceof Error ? caught.message : "Settings save failed");
        }
        finally {
            setSaving(false);
        }
    }
    useEffect(() => {
        void refresh();
        const timer = window.setInterval(() => void refresh(), 3000);
        return () => window.clearInterval(timer);
    }, []);
    if (!snapshot) {
        return (_jsxs("main", { className: "loading", children: [_jsx(MonitorDot, { size: 28 }), _jsx("span", { children: error ?? "Connecting to StudyBox..." })] }));
    }
    return (_jsxs("div", { className: "appShell", children: [_jsxs("aside", { className: "sidebar", children: [_jsxs("div", { className: "brand", children: [_jsx(Radio, { size: 24 }), _jsxs("div", { children: [_jsx("strong", { children: "StudyBox" }), _jsx("span", { children: "Mock Appliance" })] })] }), _jsx("nav", { children: navItems.map((item) => {
                            const Icon = item.icon;
                            return (_jsxs("button", { className: activeNav === item.id ? "active" : "", onClick: () => setActiveNav(item.id), title: item.label, children: [_jsx(Icon, { size: 18 }), _jsx("span", { children: item.label })] }, item.id));
                        }) })] }), _jsxs("main", { className: "main", children: [_jsxs("header", { className: "topbar", children: [_jsxs("div", { children: [_jsx("h1", { children: navItems.find((item) => item.id === activeNav)?.label }), _jsx("p", { children: statusCopy(snapshot) })] }), _jsx(StatusPill, { status: snapshot.systemStatus })] }), error ? _jsx("div", { className: "errorBanner", children: error }) : null, _jsxs("section", { className: "contentGrid", children: [_jsxs("div", { className: "primaryPane", children: [activeNav === "dashboard" ? _jsx(Dashboard, { snapshot: snapshot, run: run }) : null, activeNav === "meeting" ? _jsx(Meeting, { snapshot: snapshot, run: run }) : null, activeNav === "podcast" ? _jsx(Podcast, { snapshot: snapshot, run: run }) : null, activeNav === "audio" ? _jsx(Audio, { snapshot: snapshot }) : null, activeNav === "recordings" ? _jsx(Recordings, { snapshot: snapshot }) : null, activeNav === "settings" ? _jsx(SettingsView, { snapshot: snapshot, saving: saving, save: persistSettings }) : null, activeNav === "diagnostics" ? _jsx(Diagnostics, { snapshot: snapshot }) : null, activeNav === "logs" ? _jsx(Logs, { logs: snapshot.logs }) : null, activeNav === "network" ? _jsx(NetworkView, { snapshot: snapshot }) : null] }), _jsxs("aside", { className: "appliancePane", children: [_jsx(OledSimulator, { snapshot: snapshot, run: run }), _jsx(LedPanel, { snapshot: snapshot })] })] })] })] }));
}
function Dashboard({ snapshot, run }) {
    return (_jsxs("div", { className: "stack", children: [_jsxs("div", { className: "metricGrid", children: [_jsx(Metric, { label: "Meeting", value: snapshot.meeting.status, detail: `${snapshot.meeting.participants.length} participants` }), _jsx(Metric, { label: "Waiting", value: snapshot.meeting.waitingRoom.length.toString(), detail: `${snapshot.meeting.raisedHands.length} raised hands` }), _jsx(Metric, { label: "Podcast", value: snapshot.podcast.status, detail: formatDuration(snapshot.podcast.elapsedSeconds) }), _jsx(Metric, { label: "Next Meeting", value: `${snapshot.settings.schedule.dayOfWeek}`, detail: snapshot.settings.schedule.time })] }), _jsxs("div", { className: "toolbar", children: [_jsx(Command, { icon: _jsx(Users, { size: 17 }), label: snapshot.meeting.status === "live" ? "End Meeting" : "Start Meeting", onClick: () => run(snapshot.meeting.status === "live" ? "/api/meeting/end" : "/api/meeting/start") }), _jsx(Command, { icon: _jsx(Mic, { size: 17 }), label: podcastPrimaryAction(snapshot), onClick: () => run(podcastPrimaryPath(snapshot)) }), _jsx(Command, { icon: _jsx(Square, { size: 17 }), label: "Stop Recording", onClick: () => run("/api/podcast/stop"), disabled: snapshot.podcast.status === "idle" })] }), _jsx(Meeting, { snapshot: snapshot, run: run, compact: true })] }));
}
function Meeting({ snapshot, run, compact = false }) {
    return (_jsxs("div", { className: "stack", children: [!compact ? (_jsx("div", { className: "toolbar", children: _jsx(Command, { icon: _jsx(Users, { size: 17 }), label: snapshot.meeting.status === "live" ? "End Meeting" : "Start Meeting", onClick: () => run(snapshot.meeting.status === "live" ? "/api/meeting/end" : "/api/meeting/start") }) })) : null, _jsxs("div", { className: "twoColumn", children: [_jsx(Panel, { title: "Participants", children: _jsx(List, { children: snapshot.meeting.participants.map((participant) => (_jsxs("li", { children: [_jsx("span", { children: participant.displayName }), participant.status === "raised-hand" ? (_jsxs("button", { className: "inlineButton", onClick: () => run(`/api/meeting/raised-hands/${participant.id}/dismiss`), children: [_jsx(Hand, { size: 14 }), " Clear"] })) : (_jsx("small", { children: "Joined" }))] }, participant.id))) }) }), _jsx(Panel, { title: "Waiting Room", children: _jsx(List, { empty: "No one waiting", children: snapshot.meeting.waitingRoom.map((participant) => (_jsxs("li", { children: [_jsx("span", { children: participant.displayName }), _jsx("button", { className: "inlineButton", onClick: () => run(`/api/meeting/waiting/${participant.id}/admit`), children: "Admit" })] }, participant.id))) }) })] })] }));
}
function Podcast({ snapshot, run }) {
    return (_jsxs("div", { className: "stack", children: [_jsxs("div", { className: "recordingSurface", children: [_jsx("span", { children: snapshot.podcast.status }), _jsx("strong", { children: formatDuration(snapshot.podcast.elapsedSeconds) })] }), _jsxs("div", { className: "toolbar", children: [_jsx(Command, { icon: _jsx(Mic, { size: 17 }), label: podcastPrimaryAction(snapshot), onClick: () => run(podcastPrimaryPath(snapshot)) }), _jsx(Command, { icon: _jsx(Square, { size: 17 }), label: "Stop Recording", onClick: () => run("/api/podcast/stop"), disabled: snapshot.podcast.status === "idle" })] })] }));
}
function Audio({ snapshot }) {
    return (_jsxs("div", { className: "stack", children: [_jsx(Panel, { title: "Input", children: _jsxs("div", { className: "formGrid", children: [_jsxs("label", { children: ["Device", _jsx("input", { value: snapshot.settings.audio.inputDevice, readOnly: true })] }), _jsxs("label", { children: ["Gain", _jsx("input", { value: `${snapshot.settings.audio.gain}%`, readOnly: true })] }), _jsxs("label", { children: ["Monitor", _jsx("input", { value: snapshot.settings.audio.monitorEnabled ? "Enabled" : "Disabled", readOnly: true })] })] }) }), _jsx(Panel, { title: "Level", children: _jsx("div", { className: "levelMeter", children: _jsx("span", { style: { width: `${snapshot.metrics.cpuPercent + 20}%` } }) }) })] }));
}
function Recordings({ snapshot }) {
    return (_jsx(Panel, { title: "Recordings", children: _jsx(List, { empty: "No recordings", children: snapshot.podcast.recordings.map((recording) => (_jsxs("li", { children: [_jsx("span", { children: recording.title }), _jsxs("small", { children: [formatDuration(recording.durationSeconds), " \u00B7 ", formatBytes(recording.sizeBytes)] })] }, recording.id))) }) }));
}
function SettingsView({ snapshot, saving, save }) {
    const [draft, setDraft] = useState(snapshot.settings);
    useEffect(() => setDraft(snapshot.settings), [snapshot.settings]);
    return (_jsxs("div", { className: "stack", children: [_jsx(Panel, { title: "Schedule", children: _jsxs("div", { className: "formGrid", children: [_jsxs("label", { children: ["Day", _jsx("input", { value: draft.schedule.dayOfWeek, onChange: (event) => setDraft({ ...draft, schedule: { ...draft.schedule, dayOfWeek: event.target.value } }) })] }), _jsxs("label", { children: ["Time", _jsx("input", { type: "time", value: draft.schedule.time, onChange: (event) => setDraft({ ...draft, schedule: { ...draft.schedule, time: event.target.value } }) })] }), _jsxs("label", { children: ["Timezone", _jsx("input", { value: draft.schedule.timezone, onChange: (event) => setDraft({ ...draft, schedule: { ...draft.schedule, timezone: event.target.value } }) })] })] }) }), _jsx(Panel, { title: "Zoom", children: _jsxs("div", { className: "formGrid", children: [_jsxs("label", { children: ["Meeting Number", _jsx("input", { value: draft.zoom.meetingNumber, onChange: (event) => setDraft({ ...draft, zoom: { ...draft.zoom, meetingNumber: event.target.value } }) })] }), _jsxs("label", { children: ["Display Name", _jsx("input", { value: draft.zoom.displayName, onChange: (event) => setDraft({ ...draft, zoom: { ...draft.zoom, displayName: event.target.value } }) })] })] }) }), _jsx("div", { className: "toolbar", children: _jsx(Command, { icon: _jsx(Save, { size: 17 }), label: saving ? "Saving" : "Save Settings", onClick: () => save(draft), disabled: saving }) })] }));
}
function Diagnostics({ snapshot }) {
    return (_jsxs("div", { className: "metricGrid", children: [_jsx(Metric, { label: "CPU", value: `${snapshot.metrics.cpuPercent}%`, detail: "mock telemetry" }), _jsx(Metric, { label: "SSD", value: `${snapshot.metrics.ssdPercent}%`, detail: "NVMe storage" }), _jsx(Metric, { label: "WiFi", value: snapshot.metrics.wifiConnected ? "Connected" : "Offline", detail: snapshot.settings.wifi.ssid || "Ethernet preferred" }), _jsx(Metric, { label: "Temperature", value: `${snapshot.metrics.temperatureC}C`, detail: "Pi active cooler" })] }));
}
function Logs({ logs }) {
    return (_jsx(Panel, { title: "Logs", children: _jsx(List, { empty: "No logs yet", children: logs.map((log) => (_jsxs("li", { children: [_jsx("span", { children: log.message }), _jsxs("small", { children: [log.source, " \u00B7 ", new Date(log.timestamp).toLocaleTimeString()] })] }, log.id))) }) }));
}
function NetworkView({ snapshot }) {
    return (_jsxs("div", { className: "metricGrid", children: [_jsx(Metric, { label: "WiFi", value: snapshot.settings.wifi.configured ? snapshot.settings.wifi.ssid : "Not configured", detail: snapshot.metrics.wifiConnected ? "Connected" : "Offline" }), _jsx(Metric, { label: "Tunnel", value: snapshot.settings.cloudflare.tunnelEnabled ? "Enabled" : "Disabled", detail: snapshot.settings.cloudflare.hostname || "No hostname" }), _jsx(Metric, { label: "Access", value: "Local", detail: "Cloudflare Tunnel later" }), _jsx(Metric, { label: "API", value: "Online", detail: "localhost:4000" })] }));
}
function OledSimulator({ snapshot, run }) {
    const currentPage = useMemo(() => snapshot.oled.pages.find((page) => page.id === snapshot.oled.currentPageId) ?? snapshot.oled.pages[0], [snapshot]);
    return (_jsxs(Panel, { title: "OLED", children: [_jsxs("div", { className: "oled", children: [_jsx("strong", { children: currentPage.title }), currentPage.lines.map((line) => _jsx("span", { children: line }, line)), currentPage.actionLabel ? _jsx("em", { children: currentPage.actionLabel }) : null] }), _jsxs("div", { className: "buttonRow", children: [_jsx("button", { onClick: () => run("/api/buttons/page"), children: "PAGE" }), _jsx("button", { onClick: () => run("/api/buttons/action"), children: "ACTION" })] })] }));
}
function LedPanel({ snapshot }) {
    const systemColor = snapshot.systemStatus === "ready" ? "green" : snapshot.systemStatus === "meeting-live" ? "blue" : snapshot.systemStatus === "attention" ? "yellow" : "red";
    return (_jsx(Panel, { title: "LEDs", children: _jsxs("div", { className: "ledRows", children: [_jsxs("span", { children: [_jsx("i", { className: `led ${systemColor}` }), "System ", systemColor] }), _jsxs("span", { children: [_jsx("i", { className: `led ${snapshot.podcast.status === "recording" ? "red" : "off"}` }), "REC ", snapshot.podcast.status] })] }) }));
}
function Panel({ title, children }) {
    return _jsxs("section", { className: "panel", children: [_jsx("h2", { children: title }), children] });
}
function Metric({ label, value, detail }) {
    return _jsxs("div", { className: "metric", children: [_jsx("span", { children: label }), _jsx("strong", { children: value }), _jsx("small", { children: detail })] });
}
function Command({ icon, label, onClick, disabled = false }) {
    return _jsxs("button", { className: "command", onClick: onClick, disabled: disabled, children: [icon, _jsx("span", { children: label })] });
}
function List({ children, empty = "Empty" }) {
    return _jsx("ul", { className: "list", children: Array.isArray(children) && children.length === 0 ? _jsx("li", { children: _jsx("small", { children: empty }) }) : children });
}
function StatusPill({ status }) {
    return _jsx("span", { className: `statusPill ${status}`, children: status });
}
function statusCopy(snapshot) {
    if (snapshot.systemStatus === "attention")
        return "Waiting room or raised hand needs attention";
    if (snapshot.meeting.status === "live")
        return "Meeting is live";
    return "Ready for the next scheduled study";
}
function podcastPrimaryAction(snapshot) {
    if (snapshot.podcast.status === "recording")
        return "Pause Recording";
    if (snapshot.podcast.status === "paused")
        return "Resume Recording";
    return "Start Recording";
}
function podcastPrimaryPath(snapshot) {
    if (snapshot.podcast.status === "recording")
        return "/api/podcast/pause";
    if (snapshot.podcast.status === "paused")
        return "/api/podcast/resume";
    return "/api/podcast/start";
}
function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600).toString().padStart(2, "0");
    const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
    const remainingSeconds = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${hours}:${minutes}:${remainingSeconds}`;
}
function formatBytes(bytes) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
//# sourceMappingURL=App.js.map