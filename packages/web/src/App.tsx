import type { AdminSession, LogEntry, Participant, Recording, RecordingAssetKind, StudyBoxSettings, StudyBoxSnapshot, ZoomDeviceAuthorization } from "@studybox/shared";
import {
  Activity,
  AudioLines,
  CalendarClock,
  CloudUpload,
  ClipboardList,
  Disc3,
  Download,
  Eye,
  ExternalLink,
  Gauge,
  Hand,
  KeyRound,
  Mic,
  MonitorDot,
  Network,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Save,
  ShieldCheck,
  Settings,
  Square,
  Users
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, downloadRecordingAsset, getSnapshot, loginAdmin, pollZoomDeviceToken, postAction, refreshZoomToken, requestMeetingJoin, saveSettings, setAdminToken, setDashboardViewerId, startZoomDeviceAuthorization, validateAdminSession } from "./api.js";

const navItems = [
  { id: "dashboard", label: "Dashboard", icon: Gauge },
  { id: "meeting", label: "Meeting", icon: Users },
  { id: "podcast", label: "Podcast", icon: Mic },
  { id: "audio", label: "Audio", icon: AudioLines },
  { id: "recordings", label: "Recordings", icon: Disc3 },
  { id: "backup", label: "Backup", icon: CloudUpload },
  { id: "settings", label: "Settings", icon: Settings },
  { id: "diagnostics", label: "Diagnostics", icon: Activity },
  { id: "logs", label: "Logs", icon: ClipboardList },
  { id: "network", label: "Network", icon: Network }
] as const;

type NavId = (typeof navItems)[number]["id"];
const adminSessionStorageKey = "studybox.adminSession";
const publicJoinStorageKey = "studybox.publicJoin";
const dashboardViewerStorageKey = "studybox.dashboardViewerId";

export function App() {
  const [snapshot, setSnapshot] = useState<StudyBoxSnapshot>();
  const [activeNav, setActiveNav] = useState<NavId>("dashboard");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [adminSession, setAdminSession] = useState<AdminSession>();
  const adminUnlocked = isAdminSessionActive(adminSession);
  const isAdminRoute = window.location.pathname === "/admin" || window.location.pathname.startsWith("/admin/");

  useEffect(() => {
    if (!isAdminRoute) {
      setDashboardViewerId(undefined);
      return;
    }

    setDashboardViewerId(readOrCreateDashboardViewerId());
    return () => setDashboardViewerId(undefined);
  }, [isAdminRoute]);

  async function refresh() {
    try {
      setSnapshot(await getSnapshot());
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to reach StudyBox API");
    }
  }

  async function run(path: string, body?: unknown) {
    if (!adminUnlocked) {
      setError("Enter the admin PIN before using StudyBox controls.");
      return;
    }

    try {
      setSnapshot(await postAction(path, body));
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

  if (!isAdminRoute) {
    return <PublicJoinPage snapshot={snapshot} error={error} />;
  }

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brand">
          <Radio size={24} />
          <div>
            <strong>StudyBox</strong>
            <span>Pi Appliance</span>
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
            <ViewerPresence presence={snapshot.presence} />
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
            {activeNav === "audio" ? <Audio snapshot={snapshot} run={run} adminUnlocked={adminUnlocked} /> : null}
            {activeNav === "recordings" ? <Recordings snapshot={snapshot} adminUnlocked={adminUnlocked} setError={setError} lockAdmin={lockAdmin} /> : null}
            {activeNav === "backup" ? <BackupView snapshot={snapshot} run={run} adminUnlocked={adminUnlocked} /> : null}
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

function PublicJoinPage({ snapshot, error }: { snapshot: StudyBoxSnapshot; error?: string }) {
  const joinUrl = getZoomJoinUrl(snapshot);
  const zoomHostConnected = isZoomHostConnected(snapshot);
  const recordingLive = snapshot.podcast.status === "recording" || snapshot.podcast.status === "paused" || snapshot.podcast.status === "waitingForAudio";
  const [displayName, setDisplayName] = useState("");
  const [participant, setParticipant] = useState<Participant | undefined>(() => readStoredPublicParticipant());
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string>();
  const syncedLobbyParticipant = participant ? snapshot.meeting.lobbyRequests.find((item) => item.id === participant.id) : undefined;
  const zoomWaitingParticipant = participant ? snapshot.meeting.waitingRoom.find((item) => item.id === participant.id) : undefined;
  const admittedParticipant = participant ? snapshot.meeting.participants.find((item) => item.id === participant.id) : undefined;
  const lobbyParticipant = syncedLobbyParticipant || (!zoomWaitingParticipant && !admittedParticipant ? participant : undefined);
  const activeRequest = Boolean(lobbyParticipant || zoomWaitingParticipant || admittedParticipant);

  async function submitJoinRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setJoining(true);
    setJoinError(undefined);
    try {
      const requestedParticipant = await requestMeetingJoin(displayName);
      setParticipant(requestedParticipant);
      setDisplayName("");
      window.localStorage.setItem(publicJoinStorageKey, JSON.stringify(requestedParticipant));
    } catch (caught) {
      setJoinError(caught instanceof Error ? caught.message : "Unable to enter StudyBox room");
    } finally {
      setJoining(false);
    }
  }

  return (
    <main className="publicPage">
      <section className="publicHeader">
        <div className="publicBrand">
          <Radio size={28} />
          <div>
            <strong>StudyBox</strong>
            <span>Bible Study Zoom</span>
          </div>
        </div>
        <a className="adminLink" href="/admin">
          <KeyRound size={16} />
          Admin
        </a>
      </section>

      {error ? <div className="publicNotice errorBanner">{error}</div> : null}

      <section className="joinSurface">
        <img className="joinLogo" src="/assets/church-of-the-word.png" alt="Church of the Word" />
        <div className="meetingStatus">
          <span className={`liveDot ${zoomHostConnected ? "on" : ""}`} />
          <span>{zoomHostConnected ? "Zoom host connected" : "StudyBox room ready"}</span>
        </div>
        <h1>Weekly Bible Study</h1>
        <p>{activeRequest ? admittedParticipant ? "You have joined the Zoom meeting." : zoomWaitingParticipant ? "You are in the Zoom waiting room. Please wait for the room assistant." : "Open Zoom and wait for the room assistant to admit you." : `Enter the StudyBox room first. Next meeting: ${snapshot.settings.schedule.dayOfWeek} at ${snapshot.settings.schedule.time}`}</p>
        {(lobbyParticipant || admittedParticipant) && joinUrl ? (
          <a className="joinButton" href={joinUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={22} />
            Join Bible Study Zoom
          </a>
        ) : zoomWaitingParticipant ? (
          <div className="waitingCard">
            <Users size={22} />
            <span>{zoomWaitingParticipant.displayName} is waiting in Zoom</span>
          </div>
        ) : lobbyParticipant || admittedParticipant ? (
          <button className="joinButton disabled" disabled>
            <ExternalLink size={22} />
            Join Link Not Set
          </button>
        ) : (
          <form className="joinRequestForm" onSubmit={(event) => void submitJoinRequest(event)}>
            <input
              aria-label="Your name"
              placeholder="Your name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
            <button disabled={joining || displayName.trim().length === 0}>{joining ? "Entering..." : "Enter StudyBox Room"}</button>
          </form>
        )}
        {joinError ? <div className="publicNotice errorBanner">{joinError}</div> : null}
        <div className="publicMeta">
          <span><CalendarClock size={17} /> {snapshot.settings.schedule.timezone}</span>
          <span><Users size={17} /> {snapshot.meeting.participants.length} online</span>
          <span><Mic size={17} /> {recordingLive ? "Recording active" : "Podcast idle"}</span>
        </div>
      </section>
    </main>
  );
}

function Dashboard({ snapshot, run }: { snapshot: StudyBoxSnapshot; run: (path: string, body?: unknown) => Promise<void> }) {
  return (
    <div className="stack">
      <div className="metricGrid">
        <Metric label="Meeting" value={snapshot.meeting.status} detail={`${snapshot.meeting.participants.length} participants`} />
        <Metric label="Zoom Waiting" value={snapshot.meeting.waitingRoom.length.toString()} detail={`${snapshot.meeting.lobbyRequests.length} lobby · ${snapshot.meeting.raisedHands.length} raised hands`} />
        <Metric label="Podcast" value={snapshot.podcast.status} detail={formatDuration(snapshot.podcast.elapsedSeconds)} />
        <Metric label="Next Meeting" value={`${snapshot.settings.schedule.dayOfWeek}`} detail={snapshot.settings.schedule.time} />
      </div>
      <div className="toolbar">
        <Command icon={<Users size={17} />} label={meetingPrimaryAction(snapshot)} onClick={() => run(snapshot.meeting.status === "live" ? "/api/meeting/end" : "/api/meeting/start")} />
        <PodcastControls snapshot={snapshot} run={run} />
      </div>
      <Meeting snapshot={snapshot} run={run} compact />
    </div>
  );
}

function Meeting({ snapshot, run, compact = false }: { snapshot: StudyBoxSnapshot; run: (path: string, body?: unknown) => Promise<void>; compact?: boolean }) {
  const activeSpeaker = snapshot.meeting.activeSpeaker;
  const moderationConnected = snapshot.zoom.mode === "runner" && snapshot.zoom.runnerAvailable;
  return (
    <div className="stack">
      <div className="metricGrid compactMetrics">
        <Metric label="Moderation" value={snapshot.meeting.moderationMode} detail="default meeting mode" />
        <Metric label="Remote Speaker" value={activeSpeaker?.displayName ?? "None"} detail={moderationConnected ? activeSpeaker ? activeSpeaker.includedInPodcast ? "included in podcast" : "room audio only" : "raised hand required" : "Zoom sync pending"} />
      </div>
      {!moderationConnected ? (
        <p className="inlineNotice">Live Zoom waiting room, participant, and raised-hand sync is not connected yet. Use the Zoom client controls for admission during this test.</p>
      ) : null}
      {activeSpeaker ? (
        <div className="toolbar">
          <Command icon={<Radio size={17} />} label={activeSpeaker.includedInPodcast ? "Exclude from Podcast" : "Include in Podcast"} onClick={() => run(`/api/meeting/participants/${activeSpeaker.id}/podcast-inclusion`, { included: !activeSpeaker.includedInPodcast })} />
          <Command icon={<Mic size={17} />} label={`Mute ${activeSpeaker.displayName}`} onClick={() => run(`/api/meeting/participants/${activeSpeaker.id}/mute`)} />
        </div>
      ) : null}
      {!compact ? (
        <div className="toolbar">
          <Command icon={<Users size={17} />} label={meetingPrimaryAction(snapshot)} onClick={() => run(snapshot.meeting.status === "live" ? "/api/meeting/end" : "/api/meeting/start")} />
        </div>
      ) : null}
      <div className="twoColumn">
        <Panel title="Participants">
          <List empty={moderationConnected ? "No participants" : "Participant sync not connected"}>
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
                  <small>{participant.audioState ?? "joined"}{participant.includedInPodcast ? " · podcast" : ""}</small>
                )}
              </li>
            ))}
          </List>
        </Panel>
      <Panel title="StudyBox Lobby">
          <List empty="No web join requests">
            {snapshot.meeting.lobbyRequests.map((participant) => (
              <li key={participant.id}>
                <span>{participant.displayName}</span>
                <small>sent to Zoom join link</small>
              </li>
            ))}
          </List>
      </Panel>
      <Panel title="Zoom Waiting Room">
          <List empty={moderationConnected ? "No one waiting" : "Waiting room sync not connected"}>
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
        <List empty={moderationConnected ? "No raised hands" : "Raised-hand sync not connected"}>
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

function Podcast({ snapshot, run }: { snapshot: StudyBoxSnapshot; run: (path: string, body?: unknown) => Promise<void> }) {
  return (
    <div className="stack">
      <div className="recordingSurface">
        <span>{snapshot.podcast.status === "waitingForAudio" ? "Waiting for audio" : snapshot.podcast.status}</span>
        <strong>{formatDuration(snapshot.podcast.elapsedSeconds)}</strong>
      </div>
      <div className="toolbar">
        <PodcastControls snapshot={snapshot} run={run} />
      </div>
    </div>
  );
}

function PodcastControls({ snapshot, run }: { snapshot: StudyBoxSnapshot; run: (path: string, body?: unknown) => Promise<void> }) {
  const recordingActive = snapshot.podcast.status === "recording" || snapshot.podcast.status === "paused" || snapshot.podcast.status === "waitingForAudio";
  const waitingForAudio = snapshot.podcast.status === "waitingForAudio";
  return (
    <>
      <Command icon={<Play size={17} />} label={snapshot.podcast.status === "error" ? "Retry Recording" : "Start Recording"} onClick={() => run("/api/podcast/start")} disabled={recordingActive} />
      <Command icon={<Pause size={17} />} label={waitingForAudio ? "Waiting for Audio" : snapshot.podcast.status === "paused" ? "Resume Recording" : "Pause Recording"} onClick={() => run(snapshot.podcast.status === "paused" ? "/api/podcast/resume" : "/api/podcast/pause")} disabled={!recordingActive || waitingForAudio} />
      <Command icon={<Square size={17} />} label="Finish Recording" onClick={() => run("/api/podcast/stop")} disabled={!recordingActive} />
    </>
  );
}

function Audio({ snapshot, run, adminUnlocked }: { snapshot: StudyBoxSnapshot; run: (path: string, body?: unknown) => Promise<void>; adminUnlocked: boolean }) {
  return (
    <div className="stack">
      <Panel title="Device Routing">
        <div className="formGrid">
          <label>Teacher Mic
            <select
              value={snapshot.hardware.audio.selectedTeacherInputDeviceId}
              disabled={!adminUnlocked}
              onChange={(event) => run("/api/audio/teacher-input", { deviceId: event.target.value })}
            >
              {snapshot.hardware.audio.inputDevices.map((device) => (
                <option key={device.id} value={device.id}>{device.label}{device.connected ? "" : " (Disconnected)"}</option>
              ))}
            </select>
          </label>
          <label>Audience Mic
            <select
              value={snapshot.hardware.audio.selectedAudienceInputDeviceId}
              disabled={!adminUnlocked}
              onChange={(event) => run("/api/audio/audience-input", { deviceId: event.target.value })}
            >
              {snapshot.hardware.audio.inputDevices.map((device) => (
                <option key={device.id} value={device.id}>{device.label}{device.connected ? "" : " (Disconnected)"}</option>
              ))}
            </select>
          </label>
          <label>Room Speaker
            <select
              value={snapshot.hardware.audio.selectedSpeakerOutputDeviceId}
              disabled={!adminUnlocked}
              onChange={(event) => run("/api/audio/speaker-output", { deviceId: event.target.value })}
            >
              {snapshot.hardware.audio.outputDevices.map((device) => (
                <option key={device.id} value={device.id}>{device.label}{device.connected ? "" : " (Disconnected)"}</option>
              ))}
            </select>
          </label>
        </div>
      </Panel>
      <Panel title="Input">
        <div className="formGrid">
          <label>Gain<input value={`${snapshot.settings.audio.gain}%`} readOnly /></label>
          <label>Monitor<input value={snapshot.settings.audio.monitorEnabled ? "Enabled" : "Disabled"} readOnly /></label>
          <label>Audio Service<input value={snapshot.hardware.audio.lastEvent ?? "Ready"} readOnly /></label>
        </div>
      </Panel>
      <Panel title="Level">
        <div className="levelMeter"><span style={{ width: `${snapshot.hardware.audio.mixedLevelPercent}%` }} /></div>
      </Panel>
      <Panel title="Hardware Routes">
        <List empty="No audio routes">
          {snapshot.hardware.audio.devices.map((device) => (
            <li key={device.id}>
              <span className="listMain">
                <span>{device.label}</span>
                <small>{device.role} · {device.connected ? "connected" : "disconnected"}</small>
                {device.includedInPodcast !== undefined ? <small>{device.includedInPodcast ? "included in podcast mix" : "excluded from podcast mix"}</small> : null}
              </span>
              {device.levelPercent !== undefined ? <small>{device.levelPercent}%</small> : null}
            </li>
          ))}
        </List>
      </Panel>
    </div>
  );
}

function Recordings({ snapshot, adminUnlocked, setError, lockAdmin }: { snapshot: StudyBoxSnapshot; adminUnlocked: boolean; setError: (error?: string) => void; lockAdmin: () => void }) {
  async function download(recordingId: string, assetKind: RecordingAssetKind) {
    if (!adminUnlocked) {
      setError("Enter the admin PIN before downloading recordings.");
      return;
    }

    try {
      await downloadRecordingAsset(recordingId, assetKind);
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
        {snapshot.podcast.recordings.map((recording) => {
          const audioAsset = getRecordingAsset(recording, "audio");
          const zoomAsset = getRecordingAsset(recording, "zoom");
          const audioAvailable = audioAsset?.status === "available";
          const zoomAvailable = zoomAsset?.status === "available";
          return (
            <li key={recording.id}>
              <span className="listMain">
                <span>{recording.title}</span>
                <small>{formatDuration(recording.durationSeconds)} · {formatBytes(recording.sizeBytes)}</small>
                {recording.expiresAt ? <small>available until {formatDateTime(recording.expiresAt)}</small> : null}
              </span>
              <span className="recordingDownloads">
                <button className="inlineButton" onClick={() => void download(recording.id, "audio")} disabled={!adminUnlocked || !audioAvailable}>
                  <Download size={14} /> Audio
                </button>
                <button className="inlineButton secondary" onClick={() => void download(recording.id, "zoom")} disabled={!adminUnlocked || !zoomAvailable}>
                  <Download size={14} /> {zoomAvailable ? "Zoom" : "Zoom pending"}
                </button>
              </span>
            </li>
          );
        })}
      </List>
    </Panel>
  );
}

function BackupView({ snapshot, run, adminUnlocked }: { snapshot: StudyBoxSnapshot; run: (path: string, body?: unknown) => Promise<void>; adminUnlocked: boolean }) {
  const activeBackup = snapshot.backup.bundles.find((bundle) => bundle.id === snapshot.backup.activeBundleId);
  return (
    <div className="stack">
      <div className="metricGrid compactMetrics">
        <Metric label="Target" value={snapshot.backup.target} detail={snapshot.backup.mode} />
        <Metric label="Pending" value={snapshot.backup.pendingCount.toString()} detail="waiting to upload" />
        <Metric label="Uploaded" value={snapshot.backup.uploadedCount.toString()} detail="synced bundles" />
        <Metric label="Failed" value={snapshot.backup.failedCount.toString()} detail="needs retry" />
      </div>
      {activeBackup ? (
        <Panel title="Current Upload">
          <div className="backupProgress">
            <span>{activeBackup.stage ?? activeBackup.status}</span>
            <strong>{Math.round(activeBackup.progressPercent ?? 0)}%</strong>
            <small>{activeBackup.recordingTitle}</small>
          </div>
        </Panel>
      ) : null}
      <div className="toolbar">
        <Command icon={<RefreshCw size={17} />} label="Retry Sync" onClick={() => run("/api/backup/sync")} disabled={!adminUnlocked} />
      </div>
      <Panel title="Session Bundles">
        <List empty="No bundles yet">
          {snapshot.backup.bundles.map((bundle) => (
            <li key={bundle.id}>
              <span className="listMain">
                <span>{bundle.recordingTitle}</span>
                <small>{bundle.fileName} · {bundle.stage ?? bundle.status} · {bundle.target}</small>
                <small>{new Date(bundle.createdAt).toLocaleString()} · {bundle.logEntryCount} log entries</small>
                {bundle.progressPercent !== undefined && bundle.status !== "uploaded" ? <small>{Math.round(bundle.progressPercent)}% complete</small> : null}
                {bundle.lastAttemptAt ? <small>Last attempt {new Date(bundle.lastAttemptAt).toLocaleString()}</small> : null}
                {bundle.error ? <small className="errorText">{bundle.error}</small> : null}
              </span>
            </li>
          ))}
        </List>
      </Panel>
    </div>
  );
}

function SettingsView({ snapshot, saving, save, adminUnlocked, lockAdmin }: { snapshot: StudyBoxSnapshot; saving: boolean; save: (settings: StudyBoxSettings) => Promise<void>; adminUnlocked: boolean; lockAdmin: () => void }) {
  const [draft, setDraft] = useState(snapshot.settings);
  const [dirty, setDirty] = useState(false);
  const [deviceAuthorization, setDeviceAuthorization] = useState<ZoomDeviceAuthorization>();
  const [authMessage, setAuthMessage] = useState<string>();

  useEffect(() => {
    if (!dirty) {
      setDraft(snapshot.settings);
    }
  }, [dirty, snapshot.settings]);

  function updateDraft(settings: StudyBoxSettings) {
    setDirty(true);
    setDraft(settings);
  }

  async function saveDraft() {
    await save(draft);
    setDirty(false);
    setDraft(draft);
  }

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
          <label>Day<input value={draft.schedule.dayOfWeek} onChange={(event) => updateDraft({ ...draft, schedule: { ...draft.schedule, dayOfWeek: event.target.value as StudyBoxSettings["schedule"]["dayOfWeek"] } })} /></label>
          <label>Time<input type="time" value={draft.schedule.time} onChange={(event) => updateDraft({ ...draft, schedule: { ...draft.schedule, time: event.target.value } })} /></label>
          <label>Timezone<input value={draft.schedule.timezone} onChange={(event) => updateDraft({ ...draft, schedule: { ...draft.schedule, timezone: event.target.value } })} /></label>
        </div>
      </Panel>
      <Panel title="Moderation">
        <div className="formGrid">
          <label>Mode<input value={draft.moderation.mode} readOnly /></label>
          <label>Remote Speaker Podcast
            <select
              value={draft.moderation.includeApprovedRemoteSpeakersInPodcast ? "include" : "exclude"}
              onChange={(event) => updateDraft({
                ...draft,
                moderation: {
                  ...draft.moderation,
                  includeApprovedRemoteSpeakersInPodcast: event.target.value === "include"
                }
              })}
            >
              <option value="exclude">Exclude by default</option>
              <option value="include">Include approved speakers</option>
            </select>
          </label>
          <label>Approval<input value={draft.moderation.assistantApprovesSpeakers ? "Assistant approves" : "Open speaking"} readOnly /></label>
        </div>
      </Panel>
      <Panel title="Zoom">
        <div className="formGrid">
          <label>Meeting Number<input value={draft.zoom.meetingNumber} onChange={(event) => updateDraft({ ...draft, zoom: { ...draft.zoom, meetingNumber: event.target.value } })} /></label>
          <label>Passcode<input value={draft.zoom.passcode ?? ""} onChange={(event) => updateDraft({ ...draft, zoom: { ...draft.zoom, passcode: event.target.value } })} /></label>
          <label>Join URL<input value={draft.zoom.joinUrl ?? ""} onChange={(event) => updateDraft({ ...draft, zoom: { ...draft.zoom, joinUrl: event.target.value } })} /></label>
          <label>Display Name<input value={draft.zoom.displayName} onChange={(event) => updateDraft({ ...draft, zoom: { ...draft.zoom, displayName: event.target.value } })} /></label>
          <label>Redirect URI<input value={draft.zoom.redirectUri ?? ""} onChange={(event) => updateDraft({ ...draft, zoom: { ...draft.zoom, redirectUri: event.target.value } })} /></label>
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
        <Command icon={<Save size={17} />} label={saving ? "Saving" : dirty ? "Save Settings" : "Settings Saved"} onClick={() => void saveDraft()} disabled={saving || !adminUnlocked || !dirty} />
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
        <Metric label="CPU" value={`${snapshot.metrics.cpuPercent}%`} detail="1-minute load across CPU cores" />
        <Metric label="Storage" value={`${snapshot.metrics.ssdPercent}%`} detail="microSD now, NVMe later" />
        <Metric label="WiFi" value={snapshot.metrics.wifiConnected ? "Connected" : "Offline"} detail={snapshot.settings.wifi.ssid || "Ethernet preferred"} />
        <Metric label="Temperature" value={`${snapshot.metrics.temperatureC}C`} detail="Pi thermal sensor" />
      </div>
      <div className="metricGrid">
        <Metric label="Zoom Mode" value={snapshot.zoom.mode} detail={snapshot.zoom.configured ? "credentials loaded" : "credentials missing"} />
        <Metric label="SDK Arch" value={snapshot.zoom.sdkArch} detail="Pi target is linux-arm64" />
        <Metric label="Webhook" value={snapshot.zoom.webhookSecretConfigured ? "Configured" : "Missing"} detail="event verification token" />
        <Metric label="Runner" value={snapshot.zoom.runnerAvailable ? "Available" : "Missing"} detail="native process bridge" />
        <Metric label="Backup" value={`${snapshot.backup.pendingCount} pending`} detail={snapshot.backup.lastEvent ?? snapshot.backup.target} />
      </div>
      <div className="metricGrid">
        <Metric label="OLED" value={snapshot.hardware.oled.health} detail={`${snapshot.hardware.oled.mode} · ${snapshot.hardware.oled.currentPageTitle}`} />
        <Metric label="Page Button" value={snapshot.hardware.pageButton.health} detail={snapshot.hardware.pageButton.lastEvent ?? "Ready"} />
        <Metric label="Action Ring" value={snapshot.hardware.actionButton.ringColor} detail={`${snapshot.hardware.actionButton.ringMode} · ${snapshot.hardware.actionButton.health}`} />
        <Metric label="REC LED" value={snapshot.hardware.recordingLed.state} detail={snapshot.hardware.recordingLed.lastEvent ?? "Ready"} />
      </div>
      <Panel title="Audio Hardware">
        <List empty="No audio devices">
          {snapshot.hardware.audio.devices.map((device) => (
            <li key={device.id}>
              <span className="listMain">
                <span>{device.label}</span>
                <small>{device.role} · {device.connected ? "connected" : "disconnected"}</small>
                {device.levelPercent !== undefined ? <small>Level {device.levelPercent}%</small> : null}
                {device.error ? <small className="errorText">{device.error}</small> : null}
              </span>
            </li>
          ))}
        </List>
      </Panel>
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
  const host = window.location.host || "localhost:5173";
  const hostname = window.location.hostname;
  const publicAccess = window.location.protocol === "https:" && !["localhost", "127.0.0.1"].includes(hostname);
  const tunnelHostname = snapshot.settings.cloudflare.hostname || (publicAccess ? hostname : "");

  return (
    <div className="metricGrid">
      <Metric label="WiFi" value={snapshot.settings.wifi.configured ? snapshot.settings.wifi.ssid : "Not configured"} detail={snapshot.metrics.wifiConnected ? "Connected" : "Offline"} />
      <Metric label="Tunnel" value={tunnelHostname ? "Available" : "Not configured"} detail={tunnelHostname || "No public hostname detected"} />
      <Metric label="Access" value={publicAccess ? "Public" : "Local"} detail={host} />
      <Metric label="API" value="Online" detail={`${window.location.origin}/api`} />
    </div>
  );
}

function OledSimulator({ snapshot, run }: { snapshot: StudyBoxSnapshot; run: (path: string, body?: unknown) => Promise<void> }) {
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
        <span><i className={`led ${zoomLedClass(snapshot.hardware.zoomLed.state)}`} />Zoom {formatZoomLedState(snapshot.hardware.zoomLed.state)}</span>
        <span><i className={`led ${snapshot.podcast.status === "recording" ? "red" : "off"}`} />REC {snapshot.podcast.status}</span>
      </div>
    </Panel>
  );
}

function formatZoomLedState(state: StudyBoxSnapshot["hardware"]["zoomLed"]["state"]): string {
  if (state === "slowBlink") return "joining";
  if (state === "fastBlink") return "problem";
  return state;
}

function zoomLedClass(state: StudyBoxSnapshot["hardware"]["zoomLed"]["state"]): string {
  if (state === "off") return "off";
  if (state === "slowBlink") return "green blinkSlow";
  if (state === "fastBlink") return "green blinkFast";
  return "green";
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

function ViewerPresence({ presence }: { presence: StudyBoxSnapshot["presence"] }) {
  const count = presence.activeViewerCount;
  const active = count > 1;
  return (
    <span className={`viewerPresence ${active ? "active" : ""}`} title={active ? `${count} admin screens active` : "One admin screen active"} aria-label={active ? `${count} admin screens active` : "One admin screen active"}>
      <Eye size={16} />
      <span>{count}</span>
    </span>
  );
}

function statusCopy(snapshot: StudyBoxSnapshot): string {
  if (snapshot.systemStatus === "attention") return "Waiting room or raised hand needs attention";
  if (snapshot.meeting.status === "live") return "Meeting is live";
  return "Ready for the next scheduled study";
}

function getZoomJoinUrl(snapshot: StudyBoxSnapshot): string | undefined {
  const configuredUrl = snapshot.settings.zoom.joinUrl?.trim();
  if (configuredUrl) {
    return configuredUrl;
  }

  const meetingNumber = snapshot.settings.zoom.meetingNumber.replace(/\D/g, "");
  return meetingNumber ? `https://zoom.us/j/${meetingNumber}` : undefined;
}

function isZoomHostConnected(snapshot: StudyBoxSnapshot): boolean {
  return snapshot.meeting.status === "live" && snapshot.zoom.mode === "runner" && snapshot.zoom.runnerAvailable;
}

function meetingPrimaryAction(snapshot: StudyBoxSnapshot): string {
  if (snapshot.meeting.status === "live") {
    return snapshot.zoom.mode === "runner" && snapshot.zoom.runnerAvailable ? "End Zoom Meeting" : "End Local Session";
  }
  return snapshot.zoom.mode === "runner" && snapshot.zoom.runnerAvailable ? "Start Zoom Meeting" : "Start Local Session";
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

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function getRecordingAsset(recording: Recording, assetKind: RecordingAssetKind): NonNullable<Recording["assets"]>[number] | undefined {
  const asset = recording.assets?.find((candidate) => candidate.kind === assetKind);
  if (asset) {
    return asset;
  }
  if (assetKind === "audio" && recording.downloadFileName) {
    return {
      kind: "audio",
      label: "Room audio",
      status: "available",
      fileName: recording.downloadFileName,
      mimeType: recording.downloadMimeType ?? "audio/wav",
      sizeBytes: recording.sizeBytes,
      availableUntil: recording.expiresAt
    };
  }
  return undefined;
}

function readOrCreateDashboardViewerId(): string {
  const stored = window.sessionStorage.getItem(dashboardViewerStorageKey);
  if (stored) {
    return stored;
  }

  const viewerId = crypto.randomUUID();
  window.sessionStorage.setItem(dashboardViewerStorageKey, viewerId);
  return viewerId;
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

function readStoredPublicParticipant(): Participant | undefined {
  const stored = window.localStorage.getItem(publicJoinStorageKey);
  if (!stored) {
    return undefined;
  }

  try {
    return JSON.parse(stored) as Participant;
  } catch {
    window.localStorage.removeItem(publicJoinStorageKey);
    return undefined;
  }
}
