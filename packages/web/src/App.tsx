import type { AdminSession, LogEntry, StudyBoxSettings, StudyBoxSnapshot, ZoomDeviceAuthorization } from "@studybox/shared";
import {
  Activity,
  AudioLines,
  ClipboardList,
  Disc3,
  Download,
  Gauge,
  Hand,
  KeyRound,
  Mic,
  MonitorDot,
  Network,
  Radio,
  Save,
  ShieldCheck,
  Settings,
  Square,
  Users
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, downloadRecording, getSnapshot, loginAdmin, pollZoomDeviceToken, postAction, refreshZoomToken, saveSettings, setAdminToken, startZoomDeviceAuthorization, validateAdminSession } from "./api.js";

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
] as const;

type NavId = (typeof navItems)[number]["id"];
const adminSessionStorageKey = "studybox.adminSession";

export function App() {
  const [snapshot, setSnapshot] = useState<StudyBoxSnapshot>();
  const [activeNav, setActiveNav] = useState<NavId>("dashboard");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [adminSession, setAdminSession] = useState<AdminSession>();
  const adminUnlocked = isAdminSessionActive(adminSession);

  async function refresh() {
    try {
      setSnapshot(await getSnapshot());
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to reach StudyBox API");
    }
  }

  async function run(path: string) {
    if (!adminUnlocked) {
      setError("Enter the admin PIN before using StudyBox controls.");
      return;
    }

    try {
      setSnapshot(await postAction(path));
      setError(undefined);
    } catch (caught) {
      if (isAdminAuthError(caught)) {
        lockAdmin();
      }
      setError(caught instanceof Error ? caught.message : "Command failed");
    }
  }

  async function persistSettings(settings: StudyBoxSettings) {
    if (!adminUnlocked) {
      setError("Enter the admin PIN before saving settings.");
      return;
    }

    setSaving(true);
    try {
      await saveSettings(settings);
      await refresh();
    } catch (caught) {
      if (isAdminAuthError(caught)) {
        lockAdmin();
      }
      setError(caught instanceof Error ? caught.message : "Settings save failed");
    } finally {
      setSaving(false);
    }
  }

  async function unlockAdmin(pin: string) {
    try {
      const session = await loginAdmin(pin);
      setAdminToken(session.token);
      setAdminSession(session);
      window.localStorage.setItem(adminSessionStorageKey, JSON.stringify(session));
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Admin unlock failed");
    }
  }

  function lockAdmin() {
    setAdminSession(undefined);
    setAdminToken(undefined);
    window.localStorage.removeItem(adminSessionStorageKey);
  }

  useEffect(() => {
    const stored = readStoredAdminSession();
    if (stored) {
      setAdminToken(stored.token);
      void validateAdminSession()
        .then((session) => {
          setAdminSession(session);
          window.localStorage.setItem(adminSessionStorageKey, JSON.stringify(session));
        })
        .catch(() => {
          lockAdmin();
        });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, []);

  if (!snapshot) {
    return (
      <main className="loading">
        <MonitorDot size={28} />
        <span>{error ?? "Connecting to StudyBox..."}</span>
      </main>
    );
  }

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brand">
          <Radio size={24} />
          <div>
            <strong>StudyBox</strong>
            <span>Mock Appliance</span>
          </div>
        </div>
        <nav>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button className={activeNav === item.id ? "active" : ""} key={item.id} onClick={() => setActiveNav(item.id)} title={item.label}>
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1>{navItems.find((item) => item.id === activeNav)?.label}</h1>
            <p>{statusCopy(snapshot)}</p>
          </div>
          <div className="topbarActions">
            <AdminUnlock session={adminSession} unlock={unlockAdmin} lock={lockAdmin} />
            <StatusPill status={snapshot.systemStatus} />
          </div>
        </header>

        {error ? <div className="errorBanner">{error}</div> : null}

        <section className="contentGrid">
          <div className="primaryPane">
            {activeNav === "dashboard" ? <Dashboard snapshot={snapshot} run={run} /> : null}
            {activeNav === "meeting" ? <Meeting snapshot={snapshot} run={run} /> : null}
            {activeNav === "podcast" ? <Podcast snapshot={snapshot} run={run} /> : null}
            {activeNav === "audio" ? <Audio snapshot={snapshot} /> : null}
            {activeNav === "recordings" ? <Recordings snapshot={snapshot} adminUnlocked={adminUnlocked} setError={setError} lockAdmin={lockAdmin} /> : null}
            {activeNav === "settings" ? <SettingsView snapshot={snapshot} saving={saving} save={persistSettings} adminUnlocked={adminUnlocked} lockAdmin={lockAdmin} /> : null}
            {activeNav === "diagnostics" ? <Diagnostics snapshot={snapshot} /> : null}
            {activeNav === "logs" ? <Logs logs={snapshot.logs} /> : null}
            {activeNav === "network" ? <NetworkView snapshot={snapshot} /> : null}
          </div>

          <aside className="appliancePane">
            <OledSimulator snapshot={snapshot} run={run} />
            <LedPanel snapshot={snapshot} />
          </aside>
        </section>
      </main>
    </div>
  );
}

function Dashboard({ snapshot, run }: { snapshot: StudyBoxSnapshot; run: (path: string) => Promise<void> }) {
  return (
    <div className="stack">
      <div className="metricGrid">
        <Metric label="Meeting" value={snapshot.meeting.status} detail={`${snapshot.meeting.participants.length} participants`} />
        <Metric label="Waiting" value={snapshot.meeting.waitingRoom.length.toString()} detail={`${snapshot.meeting.raisedHands.length} raised hands`} />
        <Metric label="Podcast" value={snapshot.podcast.status} detail={formatDuration(snapshot.podcast.elapsedSeconds)} />
        <Metric label="Next Meeting" value={`${snapshot.settings.schedule.dayOfWeek}`} detail={snapshot.settings.schedule.time} />
      </div>
      <div className="toolbar">
        <Command icon={<Users size={17} />} label={snapshot.meeting.status === "live" ? "End Meeting" : "Start Meeting"} onClick={() => run(snapshot.meeting.status === "live" ? "/api/meeting/end" : "/api/meeting/start")} />
        <Command icon={<Mic size={17} />} label={podcastPrimaryAction(snapshot)} onClick={() => run(podcastPrimaryPath(snapshot))} />
        <Command icon={<Square size={17} />} label="Finish Recording" onClick={() => run("/api/podcast/stop")} disabled={snapshot.podcast.status === "idle"} />
      </div>
      <Meeting snapshot={snapshot} run={run} compact />
    </div>
  );
}

function Meeting({ snapshot, run, compact = false }: { snapshot: StudyBoxSnapshot; run: (path: string) => Promise<void>; compact?: boolean }) {
  return (
    <div className="stack">
      <div className="metricGrid compactMetrics">
        <Metric label="Moderation" value={snapshot.meeting.moderationMode} detail="default meeting mode" />
        <Metric label="Remote Speaker" value={snapshot.meeting.activeSpeaker?.displayName ?? "None"} detail={snapshot.meeting.activeSpeaker ? "ACTION mutes speaker" : "raised hand required"} />
      </div>
      {snapshot.meeting.activeSpeaker ? (
        <div className="toolbar">
          <Command icon={<Mic size={17} />} label={`Mute ${snapshot.meeting.activeSpeaker.displayName}`} onClick={() => run(`/api/meeting/participants/${snapshot.meeting.activeSpeaker?.id}/mute`)} />
        </div>
      ) : null}
      {!compact ? (
        <div className="toolbar">
          <Command icon={<Users size={17} />} label={snapshot.meeting.status === "live" ? "End Meeting" : "Start Meeting"} onClick={() => run(snapshot.meeting.status === "live" ? "/api/meeting/end" : "/api/meeting/start")} />
        </div>
      ) : null}
      <div className="twoColumn">
        <Panel title="Participants">
          <List>
            {snapshot.meeting.participants.map((participant) => (
              <li key={participant.id}>
                <span>{participant.displayName}</span>
                {participant.status === "raised-hand" ? (
                  <span className="inlineActions">
                    <button className="inlineButton" onClick={() => run(`/api/meeting/raised-hands/${participant.id}/allow`)}>
                      <Mic size={14} /> Allow
                    </button>
                    <button className="inlineButton secondary" onClick={() => run(`/api/meeting/raised-hands/${participant.id}/dismiss`)}>
                      <Hand size={14} /> Clear
                    </button>
                  </span>
                ) : (
                  <small>{participant.audioState ?? "joined"}</small>
                )}
              </li>
            ))}
          </List>
        </Panel>
      <Panel title="Waiting Room">
          <List empty="No one waiting">
            {snapshot.meeting.waitingRoom.map((participant) => (
              <li key={participant.id}>
                <span>{participant.displayName}</span>
                <button className="inlineButton" onClick={() => run(`/api/meeting/waiting/${participant.id}/admit`)}>
                  Admit
                </button>
              </li>
            ))}
          </List>
      </Panel>
      <Panel title="Raised Hands">
        <List empty="No raised hands">
          {snapshot.meeting.raisedHands.map((participant) => (
            <li key={participant.id}>
              <span>{participant.displayName}</span>
              <button className="inlineButton" onClick={() => run(`/api/meeting/raised-hands/${participant.id}/allow`)}>
                Allow to Speak
              </button>
            </li>
          ))}
        </List>
      </Panel>
      </div>
    </div>
  );
}

function Podcast({ snapshot, run }: { snapshot: StudyBoxSnapshot; run: (path: string) => Promise<void> }) {
  return (
    <div className="stack">
      <div className="recordingSurface">
        <span>{snapshot.podcast.status}</span>
        <strong>{formatDuration(snapshot.podcast.elapsedSeconds)}</strong>
      </div>
      <div className="toolbar">
        <Command icon={<Mic size={17} />} label={podcastPrimaryAction(snapshot)} onClick={() => run(podcastPrimaryPath(snapshot))} />
        <Command icon={<Square size={17} />} label="Finish Recording" onClick={() => run("/api/podcast/stop")} disabled={snapshot.podcast.status === "idle"} />
      </div>
    </div>
  );
}

function Audio({ snapshot }: { snapshot: StudyBoxSnapshot }) {
  return (
    <div className="stack">
      <Panel title="Input">
        <div className="formGrid">
          <label>Device<input value={snapshot.settings.audio.inputDevice} readOnly /></label>
          <label>Gain<input value={`${snapshot.settings.audio.gain}%`} readOnly /></label>
          <label>Monitor<input value={snapshot.settings.audio.monitorEnabled ? "Enabled" : "Disabled"} readOnly /></label>
        </div>
      </Panel>
      <Panel title="Level">
        <div className="levelMeter"><span style={{ width: `${snapshot.metrics.cpuPercent + 20}%` }} /></div>
      </Panel>
    </div>
  );
}

function Recordings({ snapshot, adminUnlocked, setError, lockAdmin }: { snapshot: StudyBoxSnapshot; adminUnlocked: boolean; setError: (error?: string) => void; lockAdmin: () => void }) {
  async function download(recordingId: string) {
    if (!adminUnlocked) {
      setError("Enter the admin PIN before downloading recordings.");
      return;
    }

    try {
      await downloadRecording(recordingId);
      setError(undefined);
    } catch (caught) {
      if (isAdminAuthError(caught)) {
        lockAdmin();
      }
      setError(caught instanceof Error ? caught.message : "Recording download failed");
    }
  }

  return (
    <Panel title="Recordings">
      <List empty="No recordings">
        {snapshot.podcast.recordings.map((recording) => (
          <li key={recording.id}>
            <span className="listMain">
              <span>{recording.title}</span>
              <small>{formatDuration(recording.durationSeconds)} · {formatBytes(recording.sizeBytes)}</small>
            </span>
            <button className="inlineButton" onClick={() => void download(recording.id)} disabled={!adminUnlocked}>
              <Download size={14} /> Download
            </button>
          </li>
        ))}
      </List>
    </Panel>
  );
}

function SettingsView({ snapshot, saving, save, adminUnlocked, lockAdmin }: { snapshot: StudyBoxSnapshot; saving: boolean; save: (settings: StudyBoxSettings) => Promise<void>; adminUnlocked: boolean; lockAdmin: () => void }) {
  const [draft, setDraft] = useState(snapshot.settings);
  const [deviceAuthorization, setDeviceAuthorization] = useState<ZoomDeviceAuthorization>();
  const [authMessage, setAuthMessage] = useState<string>();

  useEffect(() => setDraft(snapshot.settings), [snapshot.settings]);

  async function startDeviceAuthorization() {
    try {
      setAuthMessage(undefined);
      setDeviceAuthorization(await startZoomDeviceAuthorization());
    } catch (caught) {
      if (isAdminAuthError(caught)) {
        lockAdmin();
      }
      setAuthMessage(caught instanceof Error ? caught.message : "Unable to start Zoom authorization");
    }
  }

  async function completeDeviceAuthorization() {
    if (!deviceAuthorization) {
      return;
    }

    try {
      const status = await pollZoomDeviceToken(deviceAuthorization.deviceCode);
      setAuthMessage(status.authorized ? "Zoom account authorized" : "Authorization pending");
    } catch (caught) {
      if (isAdminAuthError(caught)) {
        lockAdmin();
      }
      setAuthMessage(caught instanceof Error ? caught.message : "Unable to poll Zoom authorization");
    }
  }

  async function refreshAuthorization() {
    try {
      const status = await refreshZoomToken();
      setAuthMessage(status.authorized ? "Zoom token refreshed" : "Zoom authorization expired");
    } catch (caught) {
      if (isAdminAuthError(caught)) {
        lockAdmin();
      }
      setAuthMessage(caught instanceof Error ? caught.message : "Unable to refresh Zoom authorization");
    }
  }

  return (
    <div className="stack">
      <Panel title="Schedule">
        <div className="formGrid">
          <label>Day<input value={draft.schedule.dayOfWeek} onChange={(event) => setDraft({ ...draft, schedule: { ...draft.schedule, dayOfWeek: event.target.value as StudyBoxSettings["schedule"]["dayOfWeek"] } })} /></label>
          <label>Time<input type="time" value={draft.schedule.time} onChange={(event) => setDraft({ ...draft, schedule: { ...draft.schedule, time: event.target.value } })} /></label>
          <label>Timezone<input value={draft.schedule.timezone} onChange={(event) => setDraft({ ...draft, schedule: { ...draft.schedule, timezone: event.target.value } })} /></label>
        </div>
      </Panel>
      <Panel title="Zoom">
        <div className="formGrid">
          <label>Meeting Number<input value={draft.zoom.meetingNumber} onChange={(event) => setDraft({ ...draft, zoom: { ...draft.zoom, meetingNumber: event.target.value } })} /></label>
          <label>Display Name<input value={draft.zoom.displayName} onChange={(event) => setDraft({ ...draft, zoom: { ...draft.zoom, displayName: event.target.value } })} /></label>
          <label>Redirect URI<input value={draft.zoom.redirectUri ?? ""} onChange={(event) => setDraft({ ...draft, zoom: { ...draft.zoom, redirectUri: event.target.value } })} /></label>
        </div>
      </Panel>
      <Panel title="Zoom Runtime">
        <div className="metricGrid compactMetrics">
          <Metric label="Mode" value={snapshot.zoom.mode} detail="env controlled" />
          <Metric label="SDK Arch" value={snapshot.zoom.sdkArch} detail="target package" />
          <Metric label="Credentials" value={snapshot.zoom.configured ? "Ready" : "Missing"} detail="Client ID and secret" />
          <Metric label="Runner" value={snapshot.zoom.runnerAvailable ? "Available" : "Missing"} detail={snapshot.zoom.runnerPath ?? "Not configured"} />
        </div>
      </Panel>
      <Panel title="Zoom Account">
        <div className="metricGrid compactMetrics">
          <Metric label="Authorized" value={snapshot.zoom.oauth.authorized ? "Yes" : "No"} detail={snapshot.zoom.oauth.expiresAt ? new Date(snapshot.zoom.oauth.expiresAt).toLocaleString() : "Device OAuth not completed"} />
          <Metric label="User" value={snapshot.zoom.oauth.user?.displayName ?? "Unknown"} detail={snapshot.zoom.oauth.user?.email ?? "No Zoom user stored"} />
        </div>
        {deviceAuthorization ? (
          <div className="deviceAuth">
            <label>User Code<input value={deviceAuthorization.userCode} readOnly /></label>
            <a href={deviceAuthorization.verificationUriComplete} target="_blank" rel="noreferrer">Open Zoom Authorization</a>
            <small>Expires {new Date(deviceAuthorization.expiresAt).toLocaleTimeString()}</small>
          </div>
        ) : null}
        {authMessage ? <p className="inlineNotice">{authMessage}</p> : null}
        <div className="toolbar">
          <Command icon={<Settings size={17} />} label="Start Device OAuth" onClick={() => void startDeviceAuthorization()} disabled={!adminUnlocked || !snapshot.zoom.configured} />
          <Command icon={<Save size={17} />} label="Poll Authorization" onClick={() => void completeDeviceAuthorization()} disabled={!adminUnlocked || !deviceAuthorization} />
          <Command icon={<Activity size={17} />} label="Refresh Token" onClick={() => void refreshAuthorization()} disabled={!adminUnlocked || !snapshot.zoom.oauth.authorized} />
        </div>
      </Panel>
      <div className="toolbar">
        <Command icon={<Save size={17} />} label={saving ? "Saving" : "Save Settings"} onClick={() => save(draft)} disabled={saving || !adminUnlocked} />
      </div>
    </div>
  );
}

function AdminUnlock({ session, unlock, lock }: { session?: AdminSession; unlock: (pin: string) => Promise<void>; lock: () => void }) {
  const [pin, setPin] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const active = isAdminSessionActive(session);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUnlocking(true);
    try {
      await unlock(pin);
      setPin("");
    } finally {
      setUnlocking(false);
    }
  }

  if (active && session) {
    return (
      <div className="adminBadge">
        <ShieldCheck size={16} />
        <span>Admin until {new Date(session.expiresAt).toLocaleTimeString()}</span>
        <button onClick={lock}>Lock</button>
      </div>
    );
  }

  return (
    <form className="adminUnlock" onSubmit={(event) => void submit(event)}>
      <KeyRound size={16} />
      <input
        aria-label="Admin PIN"
        inputMode="numeric"
        placeholder="Admin PIN"
        type="password"
        value={pin}
        onChange={(event) => setPin(event.target.value)}
      />
      <button disabled={unlocking || pin.trim().length === 0}>{unlocking ? "..." : "Unlock"}</button>
    </form>
  );
}

function Diagnostics({ snapshot }: { snapshot: StudyBoxSnapshot }) {
  return (
    <div className="stack">
      <div className="metricGrid">
        <Metric label="CPU" value={`${snapshot.metrics.cpuPercent}%`} detail="mock telemetry" />
        <Metric label="SSD" value={`${snapshot.metrics.ssdPercent}%`} detail="NVMe storage" />
        <Metric label="WiFi" value={snapshot.metrics.wifiConnected ? "Connected" : "Offline"} detail={snapshot.settings.wifi.ssid || "Ethernet preferred"} />
        <Metric label="Temperature" value={`${snapshot.metrics.temperatureC}C`} detail="Pi active cooler" />
      </div>
      <div className="metricGrid">
        <Metric label="Zoom Mode" value={snapshot.zoom.mode} detail={snapshot.zoom.configured ? "credentials loaded" : "credentials missing"} />
        <Metric label="SDK Arch" value={snapshot.zoom.sdkArch} detail="Pi target is linux-arm64" />
        <Metric label="Webhook" value={snapshot.zoom.webhookSecretConfigured ? "Configured" : "Missing"} detail="event verification token" />
        <Metric label="Runner" value={snapshot.zoom.runnerAvailable ? "Available" : "Missing"} detail="native process bridge" />
      </div>
    </div>
  );
}

function Logs({ logs }: { logs: LogEntry[] }) {
  return (
    <Panel title="Logs">
      <List empty="No logs yet">
        {logs.map((log) => (
          <li key={log.id}>
            <span className="logMain">
              <span className="logHeader">
                <strong>{log.message}</strong>
                {log.result ? <em className={`logResult ${log.result}`}>{log.result}</em> : null}
              </span>
              <small>
                {new Date(log.timestamp).toLocaleTimeString()} · {log.source}
                {log.actor ? ` · ${log.actor}` : ""}
                {log.action ? ` · ${log.action}` : ""}
              </small>
              {log.details ? <small>{formatLogDetails(log.details)}</small> : null}
            </span>
          </li>
        ))}
      </List>
    </Panel>
  );
}

function NetworkView({ snapshot }: { snapshot: StudyBoxSnapshot }) {
  return (
    <div className="metricGrid">
      <Metric label="WiFi" value={snapshot.settings.wifi.configured ? snapshot.settings.wifi.ssid : "Not configured"} detail={snapshot.metrics.wifiConnected ? "Connected" : "Offline"} />
      <Metric label="Tunnel" value={snapshot.settings.cloudflare.tunnelEnabled ? "Enabled" : "Disabled"} detail={snapshot.settings.cloudflare.hostname || "No hostname"} />
      <Metric label="Access" value="Local" detail="Cloudflare Tunnel later" />
      <Metric label="API" value="Online" detail="localhost:4000" />
    </div>
  );
}

function OledSimulator({ snapshot, run }: { snapshot: StudyBoxSnapshot; run: (path: string) => Promise<void> }) {
  const currentPage = useMemo(() => snapshot.oled.pages.find((page) => page.id === snapshot.oled.currentPageId) ?? snapshot.oled.pages[0], [snapshot]);

  return (
    <Panel title="OLED">
      <div className="oled">
        <strong>{currentPage.title}</strong>
        {currentPage.lines.map((line) => <span key={line}>{line}</span>)}
        {currentPage.actionLabel ? <em>{currentPage.actionLabel}</em> : null}
      </div>
      <div className="buttonRow">
        <button onClick={() => run("/api/buttons/page")}>PAGE</button>
        <button onClick={() => run("/api/buttons/action")}>ACTION</button>
      </div>
    </Panel>
  );
}

function LedPanel({ snapshot }: { snapshot: StudyBoxSnapshot }) {
  const systemColor = snapshot.systemStatus === "ready" ? "green" : snapshot.systemStatus === "meeting-live" ? "blue" : snapshot.systemStatus === "attention" ? "yellow" : "red";
  return (
    <Panel title="LEDs">
      <div className="ledRows">
        <span><i className={`led ${systemColor}`} />System {systemColor}</span>
        <span><i className={`led ${snapshot.podcast.status === "recording" ? "red" : "off"}`} />REC {snapshot.podcast.status}</span>
      </div>
    </Panel>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="panel"><h2>{title}</h2>{children}</section>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function Command({ icon, label, onClick, disabled = false }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return <button className="command" onClick={onClick} disabled={disabled}>{icon}<span>{label}</span></button>;
}

function List({ children, empty = "Empty" }: { children: React.ReactNode; empty?: string }) {
  return <ul className="list">{Array.isArray(children) && children.length === 0 ? <li><small>{empty}</small></li> : children}</ul>;
}

function StatusPill({ status }: { status: string }) {
  return <span className={`statusPill ${status}`}>{status}</span>;
}

function statusCopy(snapshot: StudyBoxSnapshot): string {
  if (snapshot.systemStatus === "attention") return "Waiting room or raised hand needs attention";
  if (snapshot.meeting.status === "live") return "Meeting is live";
  return "Ready for the next scheduled study";
}

function podcastPrimaryAction(snapshot: StudyBoxSnapshot): string {
  if (snapshot.podcast.status === "recording") return "Pause Recording";
  if (snapshot.podcast.status === "paused") return "Resume Recording";
  return "Start Recording";
}

function podcastPrimaryPath(snapshot: StudyBoxSnapshot): string {
  if (snapshot.podcast.status === "recording") return "/api/podcast/pause";
  if (snapshot.podcast.status === "paused") return "/api/podcast/resume";
  return "/api/podcast/start";
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const remainingSeconds = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${remainingSeconds}`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function formatLogDetails(details: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(details)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}: ${value}`)
    .join(" · ");
}

function isAdminSessionActive(session?: AdminSession): boolean {
  return Boolean(session?.token && Date.parse(session.expiresAt) > Date.now());
}

function isAdminAuthError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function readStoredAdminSession(): AdminSession | undefined {
  const stored = window.localStorage.getItem(adminSessionStorageKey);
  if (!stored) {
    return undefined;
  }

  try {
    const session = JSON.parse(stored) as AdminSession;
    if (isAdminSessionActive(session)) {
      return session;
    }
  } catch {
    // Ignore malformed browser storage and let the user unlock again.
  }

  window.localStorage.removeItem(adminSessionStorageKey);
  return undefined;
}
