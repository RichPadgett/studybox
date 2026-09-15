import type { AdminSession, LogEntry, Participant, Recording, RecordingAssetKind, StudyBoxSettings, StudyBoxSnapshot, TranscriptDocument, TranscriptSearchResult, ZoomDeviceAuthorization } from "@studybox/shared";
import {
  Activity,
  ArrowLeft,
  AudioLines,
  CalendarClock,
  CloudUpload,
  ClipboardList,
  Crown,
  Disc3,
  Download,
  ExternalLink,
  Eye,
  Gauge,
  Hand,
  KeyRound,
  Library,
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
import { ApiError, connectWifi, createLibraryShare, downloadRecordingAsset, getPublicLibraryAudio, getPublicLibraryDocument, getPublicLibraryShare, getPublicLibraryShareAudio, getSnapshot, getTranscript, getTranscriptAudio, loginAdmin, pollZoomDeviceToken, postAction, refreshZoomToken, requestMeetingJoin, saveSettings, scanWifiNetworks, searchPublicLibrary, searchTranscriptLibrary, setAdminToken, setDashboardViewerId, startZoomDeviceAuthorization, validateAdminSession } from "./api.js";

const primaryNavItems = [
  { id: "dashboard", label: "Dashboard", icon: Gauge },
  { id: "meeting",   label: "Meeting",   icon: Users },
  { id: "podcast",   label: "Podcast",   icon: Mic },
] as const;

const systemNavItems = [
  { id: "audio",       label: "Audio",       icon: AudioLines },
  { id: "recordings",  label: "Recordings",  icon: Disc3 },
  { id: "library",     label: "AI Library",  icon: Library },
  { id: "backup",      label: "Backup",      icon: CloudUpload },
  { id: "settings",    label: "Settings",    icon: Settings },
  { id: "diagnostics", label: "Diagnostics", icon: Activity },
  { id: "logs",        label: "Logs",        icon: ClipboardList },
  { id: "network",     label: "Network",     icon: Network },
] as const;

const allNavItems = [...primaryNavItems, ...systemNavItems];
type NavId = (typeof allNavItems)[number]["id"];
const systemNavIds = systemNavItems.map((i) => i.id) as readonly string[];

const adminSessionStorageKey    = "studybox.adminSession";
const publicJoinStorageKey      = "studybox.publicJoin";
const dashboardViewerStorageKey = "studybox.dashboardViewerId";

export function App() {
  const [snapshot, setSnapshot]     = useState<StudyBoxSnapshot>();
  const [activeNav, setActiveNav]   = useState<NavId>("dashboard");
  const [systemOpen, setSystemOpen] = useState(false);
  const [error, setError]           = useState<string>();
  const [saving, setSaving]         = useState(false);
  const [pendingAction, setPendingAction] = useState<string>();
  const [adminSession, setAdminSession] = useState<AdminSession>();
  const adminUnlocked = isAdminSessionActive(adminSession);
  const isAdminRoute = window.location.pathname === "/admin" || window.location.pathname.startsWith("/admin/");
  const shareToken = getLibraryShareToken();
  const publicLibraryRoute = window.location.pathname === "/library" || window.location.pathname.startsWith("/library/");

  function navigate(id: NavId) {
    setActiveNav(id);
    if (systemNavIds.includes(id)) setSystemOpen(true);
  }

  useEffect(() => {
    if (!isAdminRoute) { setDashboardViewerId(undefined); return; }
    setDashboardViewerId(readOrCreateDashboardViewerId());
    return () => setDashboardViewerId(undefined);
  }, [isAdminRoute]);

  async function refresh() {
    try { setSnapshot(await getSnapshot()); setError(undefined); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to reach StudyBox API"); }
  }

  async function run(path: string, body?: unknown) {
    if (!adminUnlocked) { setError("Enter the admin PIN before using StudyBox controls."); return; }
    if (pendingAction) return;
    setPendingAction(path);
    try { setSnapshot(await postAction(path, body)); setError(undefined); }
    catch (caught) {
      if (isAdminAuthError(caught)) lockAdmin();
      setError(caught instanceof Error ? caught.message : "Command failed");
    } finally { setPendingAction(undefined); }
  }

  async function persistSettings(settings: StudyBoxSettings) {
    if (!adminUnlocked) { setError("Enter the admin PIN before saving settings."); return; }
    setSaving(true);
    try { await saveSettings(settings); await refresh(); }
    catch (caught) {
      if (isAdminAuthError(caught)) lockAdmin();
      setError(caught instanceof Error ? caught.message : "Settings save failed");
    } finally { setSaving(false); }
  }

  async function unlockAdmin(pin: string) {
    try {
      const session = await loginAdmin(pin);
      setAdminToken(session.token);
      setAdminSession(session);
      window.localStorage.setItem(adminSessionStorageKey, JSON.stringify(session));
      setError(undefined);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Admin unlock failed"); }
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
        .then((session) => { setAdminSession(session); window.localStorage.setItem(adminSessionStorageKey, JSON.stringify(session)); })
        .catch(() => lockAdmin());
    }
  }, []);

  useEffect(() => {
    if (shareToken) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [shareToken]);

  if (shareToken) return <PublicLibraryShare token={shareToken} />;

  if (!snapshot) {
    return (
      <main className="loading">
        <MonitorDot size={28} />
        <span>{error ?? "Connecting to StudyBox..."}</span>
      </main>
    );
  }

  if (publicLibraryRoute) return <PublicLibraryPage snapshot={snapshot} />;

  if (!isAdminRoute) return <PublicJoinPage snapshot={snapshot} error={error} />;

  const pageTitle = allNavItems.find((i) => i.id === activeNav)?.label ?? "Dashboard";

  return (
    <div className="appShell">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebarBrand">
          <img className="sidebarArtwork" src="/assets/church-of-the-word.png" alt="Church of the Word" />
          <div className="sidebarWordmark">
            <strong>STUDYBOX</strong>
            <span>Church of the Word</span>
          </div>
        </div>
        <div className="sidebarRule" />

        <div className="sidebarNav">
          {primaryNavItems.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={`sidebarNavItem${activeNav === item.id ? " active" : ""}`} onClick={() => navigate(item.id)}><Icon size={16} /><span>{item.label}</span></button>;
          })}

          <button className="sidebarSystemToggle" onClick={() => setSystemOpen((v) => !v)}>
            <span>System</span>
            <span>{systemOpen ? "▲" : "▼"}</span>
          </button>

          {systemOpen && (
            <div className="sidebarSystemItems">
              {systemNavItems.map((item) => {
                const Icon = item.icon;
                return <button key={item.id} className={`sidebarNavItem${activeNav === item.id ? " active" : ""}`} onClick={() => navigate(item.id)}><Icon size={16} /><span>{item.label}</span></button>;
              })}
            </div>
          )}
        </div>

        <div className="sidebarFooter">
          <div className="sidebarHwBadge">
            <img className="sidebarPiLogo" src="/raspberry-pi-logo-transparent-hd-png-download-3841307694.png" alt="Raspberry Pi" />
            <span>Raspberry Pi 5 · DJI Mic</span>
          </div>
          <div className="sidebarHwLine">StudyBox control surface</div>
          <div className="sidebarHwSub">built for Church of the Word</div>
        </div>
      </aside>

      {/* ── Main ── */}
      <div className="main">
        {/* Header */}
        <div className="topbar">
          <div className="topbarTitle">
            <div className="topbarEyebrow">Church of the Word</div>
            <h1>{pageTitle === "Dashboard" ? "StudyBox Dashboard" : pageTitle}</h1>
            <p>{activeNav === "library" ? "Read and share archived transcripts" : statusCopy(snapshot)}</p>
          </div>
          <div className="topbarActions">
            <AudioReadiness podcast={snapshot.podcast} />
            <ViewerPresence presence={snapshot.presence} />
            <AdminUnlock session={adminSession} unlock={unlockAdmin} lock={lockAdmin} />
            <StatusPill status={snapshot.systemStatus} />
          </div>
        </div>

        {error ? <div className="errorBanner">{error}</div> : null}
        {pendingAction ? <div className="commandPending"><RefreshCw size={16} className="spin" /> {commandCopy(pendingAction)}</div> : null}

        {/* Content */}
        <div className={`contentLayout${systemNavIds.includes(activeNav) ? " contentLayoutLibrary" : ""}`}>
          <div className="primaryPane">
            {activeNav === "dashboard"   && <Dashboard   snapshot={snapshot} run={run} pendingAction={pendingAction} />}
            {activeNav === "meeting"     && <Meeting     snapshot={snapshot} run={run} pendingAction={pendingAction} />}
            {activeNav === "podcast"     && <Podcast     snapshot={snapshot} run={run} pendingAction={pendingAction} />}
            {activeNav === "audio"       && <Audio       snapshot={snapshot} run={run} adminUnlocked={adminUnlocked} />}
            {activeNav === "recordings"  && <Recordings  snapshot={snapshot} adminUnlocked={adminUnlocked} setError={setError} lockAdmin={lockAdmin} />}
            {activeNav === "library"     && <TranscriptLibrary snapshot={snapshot} adminUnlocked={adminUnlocked} setError={setError} lockAdmin={lockAdmin} />}
            {activeNav === "backup"      && <BackupView  snapshot={snapshot} run={run} adminUnlocked={adminUnlocked} />}
            {activeNav === "settings"    && <SettingsView snapshot={snapshot} saving={saving} save={persistSettings} adminUnlocked={adminUnlocked} lockAdmin={lockAdmin} />}
            {activeNav === "diagnostics" && <Diagnostics snapshot={snapshot} />}
            {activeNav === "logs"        && <Logs        logs={snapshot.logs} />}
            {activeNav === "network"     && <NetworkView snapshot={snapshot} adminUnlocked={adminUnlocked} setError={setError} lockAdmin={lockAdmin} />}
          </div>

          {!systemNavIds.includes(activeNav) && <aside className="appliancePane">
            <OledPanel snapshot={snapshot} run={run} pendingAction={pendingAction} />
            <LedPanel snapshot={snapshot} />
          </aside>}
        </div>
      </div>
    </div>
  );
}

// ── Public join page ──────────────────────────────────────────────────────────

function PublicJoinPage({ snapshot, error }: { snapshot: StudyBoxSnapshot; error?: string }) {
  const joinUrl = getZoomJoinUrl(snapshot);
  const zoomHostConnected = isZoomHostConnected(snapshot);
  const recordingLive = snapshot.podcast.status === "recording" || snapshot.podcast.status === "paused" || snapshot.podcast.status === "waitingForAudio";
  const [displayName, setDisplayName] = useState("");
  const [participant, setParticipant] = useState<Participant | undefined>(() => readStoredPublicParticipant());
  const [joining, setJoining]         = useState(false);
  const [joinError, setJoinError]     = useState<string>();

  const syncedLobbyParticipant = participant ? snapshot.meeting.lobbyRequests.find((i) => i.id === participant.id) : undefined;
  const zoomWaitingParticipant = participant ? snapshot.meeting.waitingRoom.find((i) => i.id === participant.id) : undefined;
  const admittedParticipant    = participant ? snapshot.meeting.participants.find((i) => i.id === participant.id) : undefined;
  const lobbyParticipant       = syncedLobbyParticipant || (!zoomWaitingParticipant && !admittedParticipant ? participant : undefined);
  const activeRequest          = Boolean(lobbyParticipant || zoomWaitingParticipant || admittedParticipant);
  const roomReady              = snapshot.systemStatus === "ready" || zoomHostConnected;

  async function submitJoinRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setJoining(true);
    setJoinError(undefined);
    try {
      const p = await requestMeetingJoin(displayName);
      setParticipant(p);
      setDisplayName("");
      window.localStorage.setItem(publicJoinStorageKey, JSON.stringify(p));
    } catch (caught) {
      setJoinError(caught instanceof Error ? caught.message : "Unable to enter StudyBox room");
    } finally { setJoining(false); }
  }

  return (
    <main className="publicPage" style={{ position: "relative" }}>
      <a className="adminLink" href="/admin"><KeyRound size={14} /> Admin</a>

      <div className="publicInner">
        {/* Hero */}
        <div className="publicHero">
          <img className="heroArtwork" src="/assets/church-of-the-word.png" alt="Church of the Word" />
          <div className="heroEyebrow">Church of the Word</div>
          <h1>Weekly Bible Study</h1>

          <div className={`heroRoomReady${roomReady ? "" : " offline"}`}>
            <span className={`heroRoomDot${roomReady ? "" : " offline"}`} />
            {zoomHostConnected ? "Host Connected" : "Room Ready"}
          </div>

          <div className="heroSchedule">
            {snapshot.settings.schedule.dayOfWeek} · {snapshot.settings.schedule.time}
          </div>

          {(lobbyParticipant || admittedParticipant) && joinUrl ? (
            <a className="joinButton" href={joinUrl} target="_blank" rel="noreferrer">↗ Join Bible Study</a>
          ) : zoomWaitingParticipant ? (
            <div className="waitingCard"><Users size={18} /><span>{zoomWaitingParticipant.displayName} — waiting in Zoom</span></div>
          ) : lobbyParticipant || admittedParticipant ? (
            <button className="joinButton disabled" disabled>↗ Join Link Not Set</button>
          ) : (
            <form className="joinRequestForm" onSubmit={(e) => void submitJoinRequest(e)}>
              <input aria-label="Your name" placeholder="Your name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              <button disabled={joining || displayName.trim().length === 0}>{joining ? "Entering…" : "Enter Room"}</button>
            </form>
          )}

          <div className="heroHelper">
            {activeRequest
              ? admittedParticipant ? "You've joined the Zoom meeting."
              : zoomWaitingParticipant ? "You're in the Zoom waiting room. The host will admit you shortly."
              : "Open Zoom and wait for the room assistant to admit you."
              : "Join the weekly Bible study. You'll enter the waiting room until the StudyBox host admits you."}
          </div>

          {(joinError || error) && (
            <div className="heroError errorBanner">{joinError ?? error}</div>
          )}
        </div>

        {/* Status row — below hero, on light background */}
        <div className="heroStatusRow">
          <span className="statusDot">
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#2E9E5B", display: "inline-block" }} />
            Room ready
          </span>
          <span className="sep" />
          <span>{snapshot.meeting.participants.length} online</span>
          <span className="sep" />
          <span>{recordingLive ? "Recording active" : "Podcast idle"}</span>
          <span className="sep" />
          <span style={{ color: "rgba(23,24,15,0.35)" }}>{snapshot.settings.schedule.timezone}</span>
        </div>

        {/* Podcast promo */}
        <div className="podcastPromo">
          <div className="podcastPromoText">
            <div className="podcastPromoEyebrow">Previous Teachings</div>
            <h3>Listen to previous teachings</h3>
            <p>Hear recent Church of the Word Bible studies and browse their transcripts.</p>
          </div>
          <div className="podcastPromoActions">
            <a className="podcastPromoBtn" href="https://open.spotify.com/show/0R8U9lsiYV4RTKODWZbRo6" target="_blank" rel="noreferrer">Listen to Previous Teachings</a>
            <a className="podcastLibraryBtn" href="/library"><Library size={16} /> Browse the Library</a>
          </div>
        </div>

        <div className="publicFooter">StudyBox · powered for Church of the Word</div>
      </div>
    </main>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function Dashboard({ snapshot, run, pendingAction }: { snapshot: StudyBoxSnapshot; run: (path: string, body?: unknown) => Promise<void>; pendingAction?: string }) {
  const recordingActive = isRecordingActive(snapshot);
  const meetingPath = snapshot.meeting.status === "live" ? "/api/meeting/end" : "/api/meeting/start";
  return (
    <div className="stack">
      <div className="metricGrid">
        <Metric label="Meeting"      value={snapshot.meeting.status}                        detail={`${snapshot.meeting.participants.length} participants`} gray={snapshot.meeting.status === "idle"} />
        <Metric label="Zoom Waiting" value={snapshot.meeting.waitingRoom.length.toString()} detail={`${snapshot.meeting.lobbyRequests.length} lobby · ${snapshot.meeting.raisedHands.length} raised hands`} />
        <Metric label="Podcast"      value={snapshot.podcast.status}                        detail={formatDuration(snapshot.podcast.elapsedSeconds)} gray={snapshot.podcast.status === "idle"} />
        <Metric label="Next Meeting" value={snapshot.settings.schedule.dayOfWeek}          detail={snapshot.settings.schedule.time} accent />
      </div>
      <div className="toolbar">
        <button className="command" onClick={() => run(meetingPath)} disabled={Boolean(pendingAction)}>
          👥 {pendingAction === meetingPath ? "Processing…" : meetingPrimaryAction(snapshot)}
        </button>
        <PodcastButtons snapshot={snapshot} run={run} recordingActive={recordingActive} pendingAction={pendingAction} />
      </div>
      <Meeting snapshot={snapshot} run={run} compact pendingAction={pendingAction} />
    </div>
  );
}

// ── Meeting ───────────────────────────────────────────────────────────────────

function Meeting({ snapshot, run, compact = false, pendingAction }: { snapshot: StudyBoxSnapshot; run: (path: string, body?: unknown) => Promise<void>; compact?: boolean; pendingAction?: string }) {
  const activeSpeaker = snapshot.meeting.activeSpeaker;
  const moderationConnected = snapshot.zoom.mode === "runner" && snapshot.zoom.runnerAvailable;
  const meetingPath = snapshot.meeting.status === "live" ? "/api/meeting/end" : "/api/meeting/start";
  return (
    <div className="stack">
      <div className="metricGrid compactMetrics">
        <Metric label="Moderation"     value={snapshot.meeting.moderationMode} detail="default meeting mode" />
        <Metric label="Remote Speaker" value={activeSpeaker?.displayName ?? "None"} detail={moderationConnected ? (activeSpeaker ? (activeSpeaker.includedInPodcast ? "included in podcast" : "room audio only") : "raised hand required") : "Zoom sync pending"} />
      </div>
      {!moderationConnected && <p className="inlineNotice">Live Zoom waiting room, participant, and raised-hand sync is not connected yet. Use the Zoom client controls for admission during this test.</p>}
      {activeSpeaker && (
        <div className="toolbar">
          <button className="command" onClick={() => run(`/api/meeting/participants/${activeSpeaker.id}/podcast-inclusion`, { included: !activeSpeaker.includedInPodcast })}>
            <Radio size={16} /> {activeSpeaker.includedInPodcast ? "Exclude from Podcast" : "Include in Podcast"}
          </button>
          <button className="command outline" onClick={() => run(`/api/meeting/participants/${activeSpeaker.id}/mute`)}>
            <Mic size={16} /> Mute {activeSpeaker.displayName}
          </button>
        </div>
      )}
      {!compact && (
        <div className="toolbar">
          <button className="command" onClick={() => run(meetingPath)} disabled={Boolean(pendingAction)}>
            👥 {pendingAction === meetingPath ? "Processing…" : meetingPrimaryAction(snapshot)}
          </button>
          {snapshot.meeting.status === "live" && (
            <button className="command outline" onClick={() => run("/api/meeting/screen-share/allow")}>
              <MonitorDot size={16} /> Allow Screen Share
            </button>
          )}
        </div>
      )}
      <div className="twoColumn">
        <Panel title="Participants" sm>
          <EmptyList empty={moderationConnected ? "No participants" : "Participant sync not connected"}>
            {snapshot.meeting.participants.map((p) => (
              <ListRow key={p.id}>
                <span>{p.displayName}</span>
                {p.status === "raised-hand" ? (
                  <span className="inlineActions">
                    <button className="inlineButton" onClick={() => run(`/api/meeting/raised-hands/${p.id}/allow`)}><Mic size={13} /> Allow</button>
                    <button className="inlineButton secondary" onClick={() => run(`/api/meeting/raised-hands/${p.id}/dismiss`)}><Hand size={13} /> Clear</button>
                  </span>
                ) : (
                  <span className="inlineActions">
                    <small style={{ color: "rgba(23,24,15,0.5)", fontSize: 12 }}>{p.role === "host" ? "host" : (p.audioState ?? "joined")}{p.includedInPodcast ? " · podcast" : ""}</small>
                    {p.role !== "host" && <button className="inlineButton secondary" onClick={() => run(`/api/meeting/participants/${p.id}/host`)}><Crown size={13} /> Host</button>}
                  </span>
                )}
              </ListRow>
            ))}
          </EmptyList>
        </Panel>
        <Panel title="StudyBox Lobby" sm>
          <EmptyList empty="No web join requests">
            {snapshot.meeting.lobbyRequests.map((p) => (
              <ListRow key={p.id}><span>{p.displayName}</span><small style={{ color: "rgba(23,24,15,0.5)", fontSize: 12 }}>sent to Zoom join link</small></ListRow>
            ))}
          </EmptyList>
        </Panel>
        <Panel title="Zoom Waiting Room" sm>
          <EmptyList empty={moderationConnected ? "No one waiting" : "Waiting room sync not connected"}>
            {snapshot.meeting.waitingRoom.map((p) => (
              <ListRow key={p.id}><span>{p.displayName}</span><button className="inlineButton" onClick={() => run(`/api/meeting/waiting/${p.id}/admit`)}>Admit</button></ListRow>
            ))}
          </EmptyList>
        </Panel>
        <Panel title="Raised Hands" sm>
          <EmptyList empty={moderationConnected ? "No raised hands" : "Raised-hand sync not connected"}>
            {snapshot.meeting.raisedHands.map((p) => (
              <ListRow key={p.id}><span>{p.displayName}</span><button className="inlineButton" onClick={() => run(`/api/meeting/raised-hands/${p.id}/allow`)}>Allow to Speak</button></ListRow>
            ))}
          </EmptyList>
        </Panel>
      </div>
    </div>
  );
}

// ── Podcast ───────────────────────────────────────────────────────────────────

function Podcast({ snapshot, run, pendingAction }: { snapshot: StudyBoxSnapshot; run: (path: string, body?: unknown) => Promise<void>; pendingAction?: string }) {
  const recordingActive = isRecordingActive(snapshot);
  return (
    <div className="stack">
      <div className="recordingSurface">
        <div>{snapshot.podcast.status === "waitingForAudio" ? "WAITING FOR AUDIO" : snapshot.podcast.status.toUpperCase()}</div>
        <div className="timer">{formatDuration(snapshot.podcast.elapsedSeconds)}</div>
      </div>
      <div className="toolbar">
        <PodcastButtons snapshot={snapshot} run={run} recordingActive={recordingActive} pendingAction={pendingAction} />
      </div>
    </div>
  );
}

function PodcastButtons({ snapshot, run, recordingActive, pendingAction }: { snapshot: StudyBoxSnapshot; run: (path: string, body?: unknown) => Promise<void>; recordingActive: boolean; pendingAction?: string }) {
  const waitingForAudio = snapshot.podcast.status === "waitingForAudio";
  const paused          = snapshot.podcast.status === "paused";
  const partial         = snapshot.podcast.status === "error" && Boolean(snapshot.podcast.activeRecording);
  return (
    <>
      <button className="command outline" onClick={() => run("/api/podcast/start")} disabled={recordingActive || Boolean(pendingAction)}>
        ▶ {pendingAction === "/api/podcast/start" ? "Processing…" : snapshot.podcast.status === "error" ? "Retry Recording" : "Start Recording"}
      </button>
      <button className={`command${recordingActive && !waitingForAudio ? "" : " disabled"}`} onClick={() => run(paused ? "/api/podcast/resume" : "/api/podcast/pause")} disabled={!recordingActive || waitingForAudio || Boolean(pendingAction)}>
        ⏸ {pendingAction === (paused ? "/api/podcast/resume" : "/api/podcast/pause") ? "Processing…" : waitingForAudio ? "Waiting for Audio" : paused ? "Resume Recording" : "Pause Recording"}
      </button>
      <button className={`command${recordingActive ? "" : " disabled"}`} onClick={() => run("/api/podcast/stop")} disabled={!recordingActive || Boolean(pendingAction)}>
        ◻ {pendingAction === "/api/podcast/stop" ? "Processing…" : partial ? "Save Partial" : "Finish Recording"}
      </button>
    </>
  );
}

// ── Audio ─────────────────────────────────────────────────────────────────────

function Audio({ snapshot, run, adminUnlocked }: { snapshot: StudyBoxSnapshot; run: (path: string, body?: unknown) => Promise<void>; adminUnlocked: boolean }) {
  const routingAvailable = snapshot.hardware.audio.mode === "mock" || snapshot.hardware.audio.health === "ready";
  if (!routingAvailable) {
    return (
      <div className="stack">
        <Panel title="Audio Routing">
          <p className="inlineNotice">Audio routing controls are not implemented on the Pi yet. StudyBox recording uses the connected DJI receiver directly.</p>
          <p className="mutedText">Volume, monitor, device-selection, and level-meter controls are hidden until connected to the real audio system.</p>
        </Panel>
        <Panel title="DJI Recording Input">
          <div className="metricGrid compactMetrics">
            <Metric label="Status"         value={snapshot.podcast.audioReady ? "Connected" : "Not connected"} detail={snapshot.podcast.audioLastEvent ?? "No status reported"} />
            <Metric label="Capture Device" value={snapshot.podcast.audioCaptureDevice ?? "Unknown"} detail={snapshot.podcast.audioLastCheckedAt ? `Checked ${new Date(snapshot.podcast.audioLastCheckedAt).toLocaleTimeString()}` : "Not checked yet"} />
          </div>
        </Panel>
      </div>
    );
  }
  return (
    <div className="stack">
      <Panel title="Device Routing">
        <div className="formGrid">
          <label>Teacher Mic
            <select value={snapshot.hardware.audio.selectedTeacherInputDeviceId} disabled={!adminUnlocked} onChange={(e) => run("/api/audio/teacher-input", { deviceId: e.target.value })}>
              {snapshot.hardware.audio.inputDevices.map((d) => <option key={d.id} value={d.id}>{d.label}{d.connected ? "" : " (Disconnected)"}</option>)}
            </select>
          </label>
          <label>Audience Mic
            <select value={snapshot.hardware.audio.selectedAudienceInputDeviceId} disabled={!adminUnlocked} onChange={(e) => run("/api/audio/audience-input", { deviceId: e.target.value })}>
              {snapshot.hardware.audio.inputDevices.map((d) => <option key={d.id} value={d.id}>{d.label}{d.connected ? "" : " (Disconnected)"}</option>)}
            </select>
          </label>
          <label>Room Speaker
            <select value={snapshot.hardware.audio.selectedSpeakerOutputDeviceId} disabled={!adminUnlocked} onChange={(e) => run("/api/audio/speaker-output", { deviceId: e.target.value })}>
              {snapshot.hardware.audio.outputDevices.map((d) => <option key={d.id} value={d.id}>{d.label}{d.connected ? "" : " (Disconnected)"}</option>)}
            </select>
          </label>
        </div>
      </Panel>
      <Panel title="Input">
        <div className="formGrid">
          <label>Gain<div className="fieldDisplay">{snapshot.settings.audio.gain}%</div></label>
          <label>Monitor<div className="fieldDisplay">{snapshot.settings.audio.monitorEnabled ? "Enabled" : "Disabled"}</div></label>
          <label>Audio Service<div className="fieldDisplay">{snapshot.hardware.audio.lastEvent ?? "Ready"}</div></label>
        </div>
      </Panel>
      <Panel title="Level">
        <div className="levelMeter"><span style={{ width: `${snapshot.hardware.audio.mixedLevelPercent}%` }} /></div>
      </Panel>
      <Panel title="Hardware Routes">
        <div className="stack" style={{ gap: 10 }}>
          {snapshot.hardware.audio.devices.length === 0
            ? <div style={{ background: "#F7F6F1", borderRadius: 8, padding: "14px 16px", color: "rgba(23,24,15,0.4)", fontSize: 13 }}>No audio routes</div>
            : snapshot.hardware.audio.devices.map((d) => (
              <div key={d.id} className="hwRouteRow">
                <div>
                  <div className="name">{d.label}</div>
                  <div className={`status ${d.connected ? "connected" : "disconnected"}`}>{d.role} · {d.connected ? "connected" : "disconnected"}</div>
                  {d.includedInPodcast !== undefined && <div style={{ color: "rgba(23,24,15,0.45)", fontSize: 12, fontWeight: 600 }}>{d.includedInPodcast ? "included in podcast mix" : "excluded from podcast mix"}</div>}
                </div>
                {d.levelPercent !== undefined && <div className="level">{d.levelPercent}%</div>}
              </div>
            ))}
        </div>
      </Panel>
    </div>
  );
}

// ── Recordings ────────────────────────────────────────────────────────────────

function Recordings({ snapshot, adminUnlocked, setError, lockAdmin }: { snapshot: StudyBoxSnapshot; adminUnlocked: boolean; setError: (e?: string) => void; lockAdmin: () => void }) {
  async function download(id: string, kind: RecordingAssetKind) {
    if (!adminUnlocked) { setError("Enter the admin PIN before downloading recordings."); return; }
    try { await downloadRecordingAsset(id, kind); setError(undefined); }
    catch (caught) {
      if (isAdminAuthError(caught)) lockAdmin();
      setError(caught instanceof Error ? caught.message : "Recording download failed");
    }
  }
  return (
    <div className="panel">
      <h2>Recordings</h2>
      <div className="stack" style={{ gap: 10 }}>
        {snapshot.podcast.recordings.length === 0
          ? <div style={{ background: "#F7F6F1", borderRadius: 8, padding: "14px 16px", color: "rgba(23,24,15,0.4)", fontSize: 13 }}>No recordings</div>
          : snapshot.podcast.recordings.map((rec) => {
            const audioAsset = getRecordingAsset(rec, "audio");
            const zoomAsset  = getRecordingAsset(rec, "zoom");
            const audioAvail = audioAsset?.status === "available";
            const zoomAvail  = zoomAsset?.status === "available";
            return (
              <div key={rec.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, background: "#F7F6F1", borderRadius: 8, padding: "14px 16px" }}>
                <div>
                  <div style={{ color: "#17180F", fontWeight: 700, fontSize: 14 }}>{rec.title}</div>
                  <div style={{ color: "rgba(23,24,15,0.5)", fontSize: 12 }}>{formatDuration(rec.durationSeconds)} · {formatBytes(rec.sizeBytes)}{rec.expiresAt ? ` · available until ${formatDateTime(rec.expiresAt)}` : ""}</div>
                </div>
                <div className="recordingDownloads">
                  <button className={`recordingDownBtn${audioAvail ? "" : " disabled"}`} onClick={() => void download(rec.id, "audio")} disabled={!adminUnlocked || !audioAvail}>
                    ⭳ Audio
                  </button>
                  <button className={`recordingDownBtn${zoomAvail ? "" : " disabled"}`} onClick={() => void download(rec.id, "zoom")} disabled={!adminUnlocked || !zoomAvail}>
                    ⭳ {zoomAvail ? "Zoom" : "Zoom pending"}
                  </button>
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}

// ── AI transcript library ────────────────────────────────────────────────────

function TranscriptLibrary({ snapshot, adminUnlocked, setError, lockAdmin }: { snapshot: StudyBoxSnapshot; adminUnlocked: boolean; setError: (e?: string) => void; lockAdmin: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TranscriptSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [selected, setSelected] = useState<{ document: TranscriptDocument; fullText?: string; recording?: Recording }>();
  const [loadingDocument, setLoadingDocument] = useState(false);

  async function openDocument(recordingId: string) {
    if (!adminUnlocked) { setError("Enter the admin PIN before opening a transcript."); return; }
    setSelectedId(recordingId);
    setLoadingDocument(true);
    try {
      const entry = await getTranscript(recordingId);
      setSelected({
        ...entry,
        document: { ...entry.document, title: transcriptDisplayTitle(entry.document, snapshot.podcast.recordings) },
        recording: snapshot.podcast.recordings.find((recording) => recording.id === entry.document.recordingId)
      });
      setError(undefined);
    } catch (caught) {
      if (isAdminAuthError(caught)) lockAdmin();
      setError(caught instanceof Error ? caught.message : "Transcript could not be opened");
    } finally { setLoadingDocument(false); }
  }

  async function search() {
    if (!adminUnlocked) { setError("Enter the admin PIN before searching the transcript library."); return; }
    if (!query.trim()) { setResults([]); return; }
    setSearching(true);
    try {
      setResults(await searchTranscriptLibrary(query.trim()));
      setError(undefined);
    } catch (caught) {
      if (isAdminAuthError(caught)) lockAdmin();
      setError(caught instanceof Error ? caught.message : "Transcript search failed");
    } finally { setSearching(false); }
  }

  if (selectedId && loadingDocument) {
    return <div className="readerLoading">Opening transcript...</div>;
  }

  if (selected) {
    return <TranscriptReader entry={selected} onBack={() => { setSelected(undefined); setSelectedId(undefined); }} adminUnlocked={adminUnlocked} setError={setError} lockAdmin={lockAdmin} />;
  }

  return (
    <div className="stack">
      <div className="metricGrid">
        <Metric label="Documents" value={String(snapshot.library.documents.length)} detail="archived transcripts" />
      </div>
      <Panel title="Search Bible Studies">
        <form onSubmit={(event) => { event.preventDefault(); void search(); }} style={{ display: "flex", gap: 10 }}>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search transcripts, topics, or Scripture" style={{ flex: 1 }} />
          <button className="command" type="submit" disabled={searching || !adminUnlocked}>{searching ? "Searching..." : "Search"}</button>
        </form>
      </Panel>
      {results.length > 0 && <Panel title={`${results.length} matches`}>
        <div className="stack" style={{ gap: 10 }}>
          {results.map((result, index) => (
              <button key={`${result.recordingId}-${result.timestampSeconds}-${index}`} className="librarySearchResult" onClick={() => void openDocument(result.recordingId)}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontWeight: 700 }}><span>{result.recordingTitle}</span><span>{result.timestampLabel}</span></div>
                {result.scripture && <div style={{ color: "#A87800", fontSize: 12, fontWeight: 700, marginTop: 4 }}>{result.scripture}</div>}
                <div style={{ marginTop: 6, lineHeight: 1.5 }}>{result.snippet}</div>
              </button>
            ))}
        </div>
      </Panel>}
      <Panel title="Recent transcripts">
        <div className="libraryRecentList">
          {snapshot.library.documents.length === 0
            ? <div className="mutedText">No transcripts have been archived yet.</div>
            : sortTranscriptDocuments(snapshot.library.documents).slice(0, 20).map((document) => (
              <button key={document.recordingId} className="libraryRecentItem" onClick={() => void openDocument(document.recordingId)}>
                <span>{transcriptDisplayTitle(document, snapshot.podcast.recordings)}</span>
                <span>{document.recordedAt ? formatReaderDate(document.recordedAt) : `${document.chunks.length} sections`}</span>
              </button>
            ))}
        </div>
      </Panel>
    </div>
  );
}

function transcriptDisplayTitle(document: TranscriptDocument, recordings: StudyBoxSnapshot["podcast"]["recordings"]): string {
  const recording = recordings.find((candidate) => candidate.id === document.recordingId);
  const candidates = [document.title, recording?.title, recording?.downloadFileName, document.sourceFileName];
  const title = candidates.find((candidate) => candidate && isUsableTranscriptTitle(candidate));
  return title ?? `Bible study recording - ${formatReaderDate(document.createdAt)}`;
}

function sortTranscriptDocuments(documents: TranscriptDocument[]): TranscriptDocument[] {
  return [...documents].sort((a, b) => {
    const aDate = Date.parse(a.recordedAt ?? a.createdAt);
    const bDate = Date.parse(b.recordedAt ?? b.createdAt);
    return bDate - aDate || b.recordingId.localeCompare(a.recordingId);
  });
}

function transcriptChunkLabel(document: TranscriptDocument, chunk: TranscriptDocument["chunks"][number]): string {
  const marker = [...document.markers]
    .filter((candidate) => candidate.timestampSeconds <= chunk.startSeconds)
    .sort((a, b) => b.timestampSeconds - a.timestampSeconds)[0];
  return marker?.label || `Section ${chunk.index + 1}`;
}

function transcriptTitle(document: TranscriptDocument): string {
  const candidates = [document.title, document.sourceFileName];
  return candidates.find((candidate) => candidate && isUsableTranscriptTitle(candidate)) ?? `Bible study recording - ${formatReaderDate(document.createdAt)}`;
}

function isUsableTranscriptTitle(value: string): boolean {
  return !looksLikeOpaqueId(value) && !/^bible study recording(?:\s*-\s*\d{4}-\d{2}-\d{2})?$/i.test(value.trim());
}

function looksLikeOpaqueId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value) || /^[a-z0-9]{20,}$/i.test(value) || /^\d+-44100-\d+-[a-f0-9]+(?:\.[a-z0-9]+)?$/i.test(value);
}

function getLibraryShareToken(): string | undefined {
  const match = window.location.pathname.match(/^\/share\/([^/]+)\/?$/);
  return match?.[1];
}

function PublicLibraryPage({ snapshot }: { snapshot: StudyBoxSnapshot }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TranscriptSearchResult[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [searching, setSearching] = useState(false);

  async function search() {
    if (!query.trim()) { setResults([]); return; }
    setSearching(true);
    try { setResults(await searchPublicLibrary(query.trim())); }
    finally { setSearching(false); }
  }

  if (selectedId) return <PublicLibraryDocument recordingId={selectedId} recording={snapshot.podcast.recordings.find((candidate) => candidate.id === selectedId)} onBack={() => setSelectedId(undefined)} />;

  return (
    <main className="publicLibraryPage">
      <div className="publicLibraryHeader">
        <a className="readerBack" href="/">← Church of the Word</a>
        <div className="readerKicker">StudyBox public library</div>
        <h1>Study transcripts</h1>
        <p>Read archived Church of the Word Bible studies and search across their transcripts.</p>
      </div>
      <form className="publicLibrarySearch" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search transcripts or Scripture" aria-label="Search transcripts" />
        <button type="submit" disabled={searching}>{searching ? "Searching..." : "Search"}</button>
      </form>
      {results.length > 0 && <section className="publicLibraryResults"><div className="readerSectionLabel">Search results</div>{results.map((result, index) => { const document = snapshot.library.documents.find((candidate) => candidate.recordingId === result.recordingId); const resultTitle = isUsableTranscriptTitle(result.recordingTitle) ? result.recordingTitle : undefined; return <button className="publicLibraryItem" key={`${result.recordingId}-${index}`} onClick={() => setSelectedId(result.recordingId)}><strong>{document ? transcriptDisplayTitle(document, snapshot.podcast.recordings) : resultTitle ?? "Study transcript"}</strong><span>{result.timestampLabel}</span><p>{result.snippet}</p></button>; })}</section>}
      <section className="publicLibraryResults"><div className="readerSectionLabel">Recent studies</div>{snapshot.library.documents.length === 0 ? <p className="mutedText">No transcripts are available yet.</p> : sortTranscriptDocuments(snapshot.library.documents).map((document) => <button className="publicLibraryItem" key={document.recordingId} onClick={() => setSelectedId(document.recordingId)}><strong>{transcriptDisplayTitle(document, snapshot.podcast.recordings)}</strong><span>{document.recordedAt ? formatReaderDate(document.recordedAt) : `${document.chunks.length} timed sections`}</span><p>{document.description ?? "Open transcript"}</p></button>)}</section>
    </main>
  );
}

function PublicLibraryDocument({ recordingId, recording, onBack }: { recordingId: string; recording?: Recording; onBack: () => void }) {
  const [entry, setEntry] = useState<{ document: TranscriptDocument; fullText?: string }>();
  const [error, setError] = useState<string>();
  const [activeChunk, setActiveChunk] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string>();
  const [audioLoading, setAudioLoading] = useState(false);
  useEffect(() => { void getPublicLibraryDocument(recordingId).then(setEntry).catch((caught) => setError(caught instanceof Error ? caught.message : "Transcript could not be opened")); }, [recordingId]);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  if (error) return <main className="loading"><span>{error}</span></main>;
  if (!entry) return <main className="loading"><MonitorDot size={28} /><span>Opening transcript...</span></main>;
  const { document, fullText } = entry;
  const sections = parseTranscript(fullText ?? "");
  async function playChunk(index: number) {
    setActiveChunk(index); setAudioLoading(true);
    try { const nextUrl = await getPublicLibraryAudio(recordingId, index); setAudioUrl((previous) => { if (previous) URL.revokeObjectURL(previous); return nextUrl; }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Audio could not be loaded"); }
    finally { setAudioLoading(false); }
  }
  return <main className="publicSharePage"><article className="transcriptReader publicShareReader"><div className="readerToolbar"><button className="readerBack" onClick={onBack}><ArrowLeft size={16} /> Library</button><span className="readerKicker">Public transcript</span></div><header className="readerHeader"><div className="readerKicker">Church of the Word</div><h2>{transcriptTitle(document)}</h2><div className="readerSubheading">Bible study recording</div><p>{document.description ?? "No description available."}</p><div className="readerMeta"><span>{document.chunks.length} timed sections</span><span>Updated {formatReaderDate(document.updatedAt)}</span></div>{recording && <div className="readerAssetActions"><a className="readerDownload" href={`/api/library/public/${encodeURIComponent(recordingId)}/assets/audio/download`} download>Download audio</a>{recording.assets?.some((asset) => asset.kind === "zoom" && (asset.status === "available" || asset.archiveProvider === "s3")) && <a className="readerDownload" href={`/api/library/public/${encodeURIComponent(recordingId)}/assets/zoom/download`} download>Download Zoom</a>}</div>}</header><section className="readerAudio"><div className="readerSectionLabel">Audio map</div>{audioUrl ? <audio className="readerPlayer" controls src={audioUrl} autoFocus /> : <div className="readerAudioEmpty">Select a section to listen.</div>}<div className="audioMap">{document.chunks.map((chunk) => <div className={`audioMapItem${activeChunk === chunk.index ? " active" : ""}`} key={chunk.index}><button onClick={() => void playChunk(chunk.index)}><span className="audioMapTime">{formatReaderTimestamp(chunk.startSeconds)}</span><span>{audioLoading && activeChunk === chunk.index ? "Loading..." : transcriptChunkLabel(document, chunk)}</span></button><a className="audioDownload" href={`/api/library/public/${encodeURIComponent(recordingId)}/audio/${chunk.index}`} download={`section-${chunk.index + 1}.m4a`} aria-label={`Download section ${chunk.index + 1}`}><Download size={15} /></a></div>)}</div></section><section className="readerTranscript"><div className="readerSectionLabel">Full transcript</div>{sections.length === 0 ? <p className="mutedText">Transcript text is not available.</p> : sections.map((section, index) => <div className="transcriptSection" key={`${section.timestamp}-${index}`}><span className="transcriptTimestamp">{section.timestamp}</span><p>{section.text}</p></div>)}</section></article></main>;
}

function PublicLibraryShare({ token }: { token: string }) {
  const [entry, setEntry] = useState<{ document: TranscriptDocument; fullText?: string }>();
  const [error, setError] = useState<string>();
  const [activeChunk, setActiveChunk] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string>();
  const [audioLoading, setAudioLoading] = useState(false);

  useEffect(() => {
    void getPublicLibraryShare(token)
      .then(setEntry)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Shared transcript could not be loaded"));
  }, [token]);

  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);

  if (error) return <main className="loading"><span>{error}</span></main>;
  if (!entry) return <main className="loading"><MonitorDot size={28} /><span>Opening shared transcript...</span></main>;

  const { document, fullText } = entry;
  const transcriptSections = parseTranscript(fullText ?? "");
  const audioPath = (chunkIndex: number) => `/api/library/share/${encodeURIComponent(token)}/audio/${chunkIndex}`;

  async function playChunk(chunkIndex: number) {
    setActiveChunk(chunkIndex);
    setAudioLoading(true);
    try {
      const nextUrl = await getPublicLibraryShareAudio(token, chunkIndex);
      setAudioUrl((previous) => { if (previous) URL.revokeObjectURL(previous); return nextUrl; });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Audio could not be loaded");
    } finally { setAudioLoading(false); }
  }

  return (
    <main className="publicSharePage">
      <article className="transcriptReader publicShareReader">
        <div className="readerToolbar">
          <span className="readerKicker">StudyBox shared transcript</span>
          <a className="readerDownload" href={`/api/library/share/${encodeURIComponent(token)}`} download={`${transcriptTitle(document)}.json`}>Download record</a>
        </div>
        <header className="readerHeader">
          <div className="readerKicker">Church of the Word</div>
          <h2>{transcriptTitle(document)}</h2>
          <div className="readerSubheading">Bible study recording</div>
          <p>{document.description ?? "No description available."}</p>
          <div className="readerMeta"><span>{document.chunks.length} timed sections</span><span>{document.recordedAt ? `Recorded ${formatReaderDate(document.recordedAt)}` : `Updated ${formatReaderDate(document.updatedAt)}`}</span></div>
        </header>
        <section className="readerAudio" aria-label="Audio map">
          <div className="readerSectionLabel">Audio map</div>
          {audioUrl ? <audio className="readerPlayer" controls src={audioUrl} autoFocus /> : <div className="readerAudioEmpty">Select a section to listen.</div>}
          <div className="audioMap">
            {document.chunks.map((chunk) => (
              <div className={`audioMapItem${activeChunk === chunk.index ? " active" : ""}`} key={chunk.index}>
                <button onClick={() => void playChunk(chunk.index)}><span className="audioMapTime">{formatReaderTimestamp(chunk.startSeconds)}</span><span>{audioLoading && activeChunk === chunk.index ? "Loading..." : transcriptChunkLabel(document, chunk)}</span></button>
                <a className="audioDownload" href={audioPath(chunk.index)} download={`section-${chunk.index + 1}.m4a`} aria-label={`Download section ${chunk.index + 1}`}><Download size={15} /></a>
              </div>
            ))}
          </div>
        </section>
        <section className="readerTranscript">
          <div className="readerSectionLabel">Full transcript</div>
          {transcriptSections.length === 0 ? <p className="mutedText">Transcript text is not available.</p> : transcriptSections.map((section, index) => <div className="transcriptSection" key={`${section.timestamp}-${index}`}><span className="transcriptTimestamp">{section.timestamp}</span><p>{section.text}</p></div>)}
        </section>
      </article>
    </main>
  );
}

function TranscriptReader({ entry, onBack, adminUnlocked, setError, lockAdmin }: { entry: { document: TranscriptDocument; fullText?: string; recording?: Recording }; onBack: () => void; adminUnlocked: boolean; setError: (e?: string) => void; lockAdmin: () => void }) {
  const { document, fullText, recording } = entry;
  const [activeChunk, setActiveChunk] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string>();
  const [audioLoading, setAudioLoading] = useState(false);
  const [shareUrl, setShareUrl] = useState<string>();
  const [sharing, setSharing] = useState(false);
  const transcriptSections = parseTranscript(fullText ?? "");

  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);

  async function playChunk(chunkIndex: number) {
    if (!adminUnlocked) { setError("Enter the admin PIN before playing transcript audio."); return; }
    setActiveChunk(chunkIndex);
    setAudioLoading(true);
    try {
      const nextUrl = await getTranscriptAudio(document.recordingId, chunkIndex);
      setAudioUrl((previous) => { if (previous) URL.revokeObjectURL(previous); return nextUrl; });
      setError(undefined);
    } catch (caught) {
      if (isAdminAuthError(caught)) lockAdmin();
      setError(caught instanceof Error ? caught.message : "Audio could not be loaded");
    } finally { setAudioLoading(false); }
  }

  async function shareTranscript() {
    if (!adminUnlocked) { setError("Enter the admin PIN before sharing a transcript."); return; }
    setSharing(true);
    try {
      const share = await createLibraryShare(document.recordingId);
      const url = new URL(share.url, "https://studybox.enochscalendar.com").toString();
      setShareUrl(url);
      await navigator.clipboard?.writeText(url);
      setError(undefined);
    } catch (caught) {
      if (isAdminAuthError(caught)) lockAdmin();
      setError(caught instanceof Error ? caught.message : "Transcript could not be shared");
    } finally { setSharing(false); }
  }

  async function downloadAsset(kind: RecordingAssetKind) {
    if (!adminUnlocked) { setError("Enter the admin PIN before downloading recordings."); return; }
    try { await downloadRecordingAsset(document.recordingId, kind); setError(undefined); }
    catch (caught) { if (isAdminAuthError(caught)) lockAdmin(); setError(caught instanceof Error ? caught.message : "Recording download failed"); }
  }

  return (
    <article className="transcriptReader">
      <div className="readerToolbar">
        <button className="readerBack" onClick={onBack}><ArrowLeft size={16} /> Library</button>
        <span className="readerStatus">{document.status === "completed" ? "Indexed transcript" : document.status}</span>
        <button className="readerShare" onClick={() => void shareTranscript()} disabled={sharing}>{sharing ? "Creating link..." : "Share / Check Out"}</button>
      </div>
      {shareUrl && <div className="shareNotice">Share link copied: <a href={shareUrl}>{shareUrl}</a></div>}
      <header className="readerHeader">
        <div className="readerKicker">StudyBox transcript</div>
        <h2>{transcriptTitle(document)}</h2>
        <div className="readerSubheading">Bible study recording</div>
        <p>{document.description ?? "No description available."}</p>
        <div className="readerMeta"><span>{document.chunks.length} timed sections</span><span>{document.recordedAt ? `Recorded ${formatReaderDate(document.recordedAt)}` : `Updated ${formatReaderDate(document.updatedAt)}`}</span></div>
        {recording && <div className="readerAssetActions"><button className="readerDownload" onClick={() => void downloadAsset("audio")}>Download audio</button>{recording.assets?.some((asset) => asset.kind === "zoom" && (asset.status === "available" || asset.archiveProvider === "s3")) && <button className="readerDownload" onClick={() => void downloadAsset("zoom")}>Download Zoom</button>}</div>}
      </header>
      <section className="readerAudio" aria-label="Audio map">
        <div className="readerSectionLabel">Audio map</div>
        {audioUrl ? <audio className="readerPlayer" controls src={audioUrl} autoFocus /> : <div className="readerAudioEmpty">Select a section to load its audio.</div>}
        <div className="audioMap">
          {document.chunks.map((chunk) => (
            <button key={chunk.index} className={`audioMapItem${activeChunk === chunk.index ? " active" : ""}`} onClick={() => void playChunk(chunk.index)}>
              <span className="audioMapTime">{formatReaderTimestamp(chunk.startSeconds)}</span>
              <span>{audioLoading && activeChunk === chunk.index ? "Loading..." : transcriptChunkLabel(document, chunk)}</span>
            </button>
          ))}
        </div>
        {document.markers.length > 0 && <div className="readerMarkers"><div className="readerSectionLabel">Study markers</div>{document.markers.map((marker) => <button key={`${marker.timestampSeconds}-${marker.label}`} onClick={() => void playChunk(Math.floor(marker.timestampSeconds / 600))}><span>{formatReaderTimestamp(marker.timestampSeconds)}</span>{marker.label}{marker.scripture ? ` · ${marker.scripture}` : ""}</button>)}</div>}
      </section>
      <section className="readerTranscript">
        <div className="readerSectionLabel">Full transcript</div>
        {transcriptSections.length === 0
          ? <p className="mutedText">Transcript text is not available.</p>
          : transcriptSections.map((section, index) => <div className="transcriptSection" key={`${section.timestamp}-${index}`} id={`transcript-${index}`}><button className="transcriptTimestamp" onClick={() => void playChunk(index)}>{section.timestamp}</button><p>{section.text}</p></div>)}
      </section>
    </article>
  );
}

function parseTranscript(text: string): Array<{ timestamp: string; text: string }> {
  return text.split(/\n(?=\[\d{1,2}:\d{2}(?::\d{2})?\])/).map((part) => {
    const match = part.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)]\s*([\s\S]*)$/);
    return match ? { timestamp: match[1], text: match[2].trim() } : undefined;
  }).filter((section): section is { timestamp: string; text: string } => Boolean(section));
}

function formatReaderTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function formatReaderDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// ── Backup ────────────────────────────────────────────────────────────────────

function BackupView({ snapshot, run, adminUnlocked }: { snapshot: StudyBoxSnapshot; run: (path: string, body?: unknown) => Promise<void>; adminUnlocked: boolean }) {
  const activeBackup = snapshot.backup.bundles.find((b) => b.id === snapshot.backup.activeBundleId);
  return (
    <div className="stack">
      <div className="metricGrid">
        <Metric label="Target"   value={snapshot.backup.target}                   detail={snapshot.backup.mode} />
        <Metric label="Pending"  value={snapshot.backup.pendingCount.toString()}   detail="waiting to upload" />
        <Metric label="Uploaded" value={snapshot.backup.uploadedCount.toString()}  detail="synced bundles" />
        <Metric label="Failed"   value={snapshot.backup.failedCount.toString()}    detail="needs retry" />
      </div>
      {activeBackup && (
        <Panel title="Current Upload">
          <div className="backupProgress">
            <span>{activeBackup.stage ?? activeBackup.status}</span>
            <strong>{Math.round(activeBackup.progressPercent ?? 0)}%</strong>
            <small>{activeBackup.recordingTitle}</small>
          </div>
        </Panel>
      )}
      <div className="toolbar">
        <button className="command disabled" style={{ cursor: adminUnlocked && snapshot.backup.pendingCount > 0 ? "pointer" : "not-allowed" }} onClick={() => run("/api/backup/sync")} disabled={!adminUnlocked}>
          ↻ Retry Sync
        </button>
      </div>
      <Panel title="Session Bundles">
        <div className="stack" style={{ gap: 10 }}>
          {snapshot.backup.bundles.length === 0
            ? <div style={{ background: "#F7F6F1", borderRadius: 8, padding: "14px 16px", color: "rgba(23,24,15,0.4)", fontSize: 13 }}>No bundles yet</div>
            : snapshot.backup.bundles.map((b) => (
              <div key={b.id} style={{ background: "#F7F6F1", borderRadius: 8, padding: "14px 16px" }}>
                <div style={{ color: "#17180F", fontWeight: 700, fontSize: 13.5 }}>{b.recordingTitle}</div>
                <div style={{ color: "rgba(23,24,15,0.5)", fontSize: 12 }}>{b.fileName} · {b.stage ?? b.status} · {b.target}</div>
                <div style={{ color: "rgba(23,24,15,0.35)", fontSize: 11.5, marginTop: 2 }}>{new Date(b.createdAt).toLocaleString()} · {b.logEntryCount} log entries</div>
                {b.progressPercent !== undefined && b.status !== "uploaded" && <div style={{ color: "rgba(23,24,15,0.5)", fontSize: 12 }}>{Math.round(b.progressPercent)}% complete</div>}
                {b.error && <div style={{ color: "#D64545", fontWeight: 700, fontSize: 12 }}>{b.error}</div>}
              </div>
            ))}
        </div>
      </Panel>
    </div>
  );
}

// ── Settings ──────────────────────────────────────────────────────────────────

function SettingsView({ snapshot, saving, save, adminUnlocked, lockAdmin }: { snapshot: StudyBoxSnapshot; saving: boolean; save: (s: StudyBoxSettings) => Promise<void>; adminUnlocked: boolean; lockAdmin: () => void }) {
  const [draft, setDraft] = useState(snapshot.settings);
  const [dirty, setDirty] = useState(false);
  const [deviceAuth, setDeviceAuth] = useState<ZoomDeviceAuthorization>();
  const [authMsg, setAuthMsg] = useState<string>();

  useEffect(() => { if (!dirty) setDraft(snapshot.settings); }, [dirty, snapshot.settings]);
  function update(s: StudyBoxSettings) { setDirty(true); setDraft(s); }
  async function saveDraft() { await save(draft); setDirty(false); }

  async function startDeviceAuth() {
    try { setAuthMsg(undefined); setDeviceAuth(await startZoomDeviceAuthorization()); }
    catch (e) { if (isAdminAuthError(e)) lockAdmin(); setAuthMsg(e instanceof Error ? e.message : "Unable to start Zoom authorization"); }
  }
  async function pollAuth() {
    if (!deviceAuth) return;
    try { const s = await pollZoomDeviceToken(deviceAuth.deviceCode); setAuthMsg(s.authorized ? "Zoom account authorized" : "Authorization pending"); }
    catch (e) { if (isAdminAuthError(e)) lockAdmin(); setAuthMsg(e instanceof Error ? e.message : "Unable to poll Zoom authorization"); }
  }
  async function refreshAuth() {
    try { const s = await refreshZoomToken(); setAuthMsg(s.authorized ? "Zoom token refreshed" : "Zoom authorization expired"); }
    catch (e) { if (isAdminAuthError(e)) lockAdmin(); setAuthMsg(e instanceof Error ? e.message : "Unable to refresh Zoom authorization"); }
  }

  return (
    <div className="stack">
      <Panel title="Schedule">
        <div className="formGrid">
          <label>Day<input value={draft.schedule.dayOfWeek} onChange={(e) => update({ ...draft, schedule: { ...draft.schedule, dayOfWeek: e.target.value as StudyBoxSettings["schedule"]["dayOfWeek"] } })} /></label>
          <label>Time<input type="time" value={draft.schedule.time} onChange={(e) => update({ ...draft, schedule: { ...draft.schedule, time: e.target.value } })} /></label>
          <label>Timezone<input value={draft.schedule.timezone} onChange={(e) => update({ ...draft, schedule: { ...draft.schedule, timezone: e.target.value } })} /></label>
        </div>
      </Panel>
      <Panel title="Moderation">
        <div className="formGrid">
          <label>Mode<div className="fieldDisplay">{draft.moderation.mode}</div></label>
          <label>Remote Speaker Podcast
            <select value={draft.moderation.includeApprovedRemoteSpeakersInPodcast ? "include" : "exclude"} onChange={(e) => update({ ...draft, moderation: { ...draft.moderation, includeApprovedRemoteSpeakersInPodcast: e.target.value === "include" } })}>
              <option value="exclude">Exclude by default</option>
              <option value="include">Include approved speakers</option>
            </select>
          </label>
          <label>Approval<div className="fieldDisplay">{draft.moderation.assistantApprovesSpeakers ? "Assistant approves" : "Open speaking"}</div></label>
        </div>
      </Panel>
      <Panel title="Zoom">
        <div className="formGrid" style={{ marginBottom: 16 }}>
          <label>Meeting Number<input value={draft.zoom.meetingNumber} onChange={(e) => update({ ...draft, zoom: { ...draft.zoom, meetingNumber: e.target.value } })} /></label>
          <label>Passcode<input value={draft.zoom.passcode ?? ""} onChange={(e) => update({ ...draft, zoom: { ...draft.zoom, passcode: e.target.value } })} /></label>
          <label>Join URL<input value={draft.zoom.joinUrl ?? ""} onChange={(e) => update({ ...draft, zoom: { ...draft.zoom, joinUrl: e.target.value } })} /></label>
        </div>
        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "1fr 1fr" }}>
          <label>Display Name<input value={draft.zoom.displayName} onChange={(e) => update({ ...draft, zoom: { ...draft.zoom, displayName: e.target.value } })} /></label>
          <label>Redirect URI<input value={draft.zoom.redirectUri ?? ""} onChange={(e) => update({ ...draft, zoom: { ...draft.zoom, redirectUri: e.target.value } })} /></label>
        </div>
      </Panel>
      <Panel title="Zoom Runtime">
        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "1fr 1fr" }}>
          <div><div style={{ color: "rgba(23,24,15,0.5)", fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>Mode</div><div style={{ color: "#17180F", fontWeight: 800, fontSize: 19, marginBottom: 4 }}>{snapshot.zoom.mode}</div><div style={{ color: "rgba(23,24,15,0.45)", fontSize: 12.5 }}>env controlled</div></div>
          <div><div style={{ color: "rgba(23,24,15,0.5)", fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>SDK Arch</div><div style={{ color: "#17180F", fontWeight: 800, fontSize: 19, marginBottom: 4 }}>{snapshot.zoom.sdkArch}</div><div style={{ color: "rgba(23,24,15,0.45)", fontSize: 12.5 }}>Pi target is linux-arm64</div></div>
        </div>
      </Panel>
      <Panel title="Zoom Account">
        <div className="metricGrid compactMetrics">
          <Metric label="Authorized" value={snapshot.zoom.oauth.authorized ? "Yes" : "No"} detail={snapshot.zoom.oauth.expiresAt ? new Date(snapshot.zoom.oauth.expiresAt).toLocaleString() : "Device OAuth not completed"} />
          <Metric label="User" value={snapshot.zoom.oauth.user?.displayName ?? "Unknown"} detail={snapshot.zoom.oauth.user?.email ?? "No Zoom user stored"} />
        </div>
        {deviceAuth && (
          <div className="deviceAuth">
            <label>User Code<input value={deviceAuth.userCode} readOnly /></label>
            <a href={deviceAuth.verificationUriComplete} target="_blank" rel="noreferrer">Open Zoom Authorization</a>
            <small>Expires {new Date(deviceAuth.expiresAt).toLocaleTimeString()}</small>
          </div>
        )}
        {authMsg && <p className="inlineNotice">{authMsg}</p>}
        <div className="toolbar" style={{ marginTop: 12 }}>
          <button className="command outline" onClick={() => void startDeviceAuth()} disabled={!adminUnlocked || !snapshot.zoom.configured}><Settings size={16} /> Start Device OAuth</button>
          <button className="command outline" onClick={() => void pollAuth()} disabled={!adminUnlocked || !deviceAuth}><Save size={16} /> Poll Authorization</button>
          <button className="command outline" onClick={() => void refreshAuth()} disabled={!adminUnlocked || !snapshot.zoom.oauth.expiresAt}><Activity size={16} /> Refresh Token</button>
        </div>
      </Panel>
      <div className="toolbar">
        <button className="command" onClick={() => void saveDraft()} disabled={saving || !adminUnlocked || !dirty}>
          <Save size={16} /> {saving ? "Saving…" : dirty ? "Save Settings" : "Settings Saved"}
        </button>
      </div>
    </div>
  );
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

function Diagnostics({ snapshot }: { snapshot: StudyBoxSnapshot }) {
  return (
    <div className="stack">
      <div className="metricGrid">
        <Metric label="CPU"         value={`${snapshot.metrics.cpuPercent}%`}                     detail="1-min load across cores" />
        <Metric label="Storage"     value={`${snapshot.metrics.ssdPercent}%`}                     detail="microSD now, NVMe later" />
        <Metric label="WiFi"        value={snapshot.metrics.wifiConnected ? "Connected" : "Offline"} detail={snapshot.settings.wifi.ssid || "Ethernet preferred"} green={snapshot.metrics.wifiConnected} />
        <Metric label="Temperature" value={`${snapshot.metrics.temperatureC}C`}                   detail="Pi thermal sensor" />
      </div>
      <div className="metricGrid">
        <Metric label="Zoom Mode" value={snapshot.zoom.mode}            detail={snapshot.zoom.configured ? "credentials loaded" : "credentials missing"} />
        <Metric label="SDK Arch"  value={snapshot.zoom.sdkArch}         detail="Pi target is linux-arm64" />
        <Metric label="Webhook"   value={snapshot.zoom.webhookSecretConfigured ? "Configured" : "Missing"} detail="event verification token" green={snapshot.zoom.webhookSecretConfigured} />
        <Metric label="Runner"    value={snapshot.zoom.runnerAvailable ? "Available" : "Missing"} detail="native process bridge" green={snapshot.zoom.runnerAvailable} />
        <Metric label="Backup"    value={`${snapshot.backup.pendingCount} pending`} detail={snapshot.backup.lastEvent ?? snapshot.backup.target} />
      </div>
      <div className="metricGrid">
        <Metric label="OLED"        value={snapshot.hardware.oled.health}             detail={`${snapshot.hardware.oled.mode} · ${snapshot.hardware.oled.currentPageTitle}`} green={snapshot.hardware.oled.health === "ready"} />
        <Metric label="Page Button" value={snapshot.hardware.pageButton.health}       detail={snapshot.hardware.pageButton.lastEvent ?? "Ready"} green={snapshot.hardware.pageButton.health === "ready"} />
        <Metric label="Action Ring" value={snapshot.hardware.actionButton.ringColor}  detail={`${snapshot.hardware.actionButton.ringMode} · ${snapshot.hardware.actionButton.health}`} />
        <Metric label="REC LED"     value={snapshot.hardware.recordingLed.state}      detail={snapshot.hardware.recordingLed.lastEvent ?? "Ready"} gray={snapshot.hardware.recordingLed.state === "off"} />
      </div>
      <Panel title="Audio Hardware">
        {snapshot.hardware.audio.mode === "mock"
          ? <p className="inlineNotice">Audio hardware is simulated in development mode.</p>
          : snapshot.hardware.audio.health !== "ready"
          ? <p className="inlineNotice">Audio routing hardware controls are not implemented yet. The DJI recording input is monitored separately.</p>
          : (
            <div className="stack" style={{ gap: 10 }}>
              {snapshot.hardware.audio.devices.length === 0
                ? <div style={{ background: "#F7F6F1", borderRadius: 8, padding: "14px 16px", color: "rgba(23,24,15,0.4)", fontSize: 13 }}>No audio devices</div>
                : snapshot.hardware.audio.devices.map((d) => (
                  <div key={d.id} className="hwRouteRow">
                    <div>
                      <div className="name">{d.label}</div>
                      <div className={`status ${d.connected ? "connected" : "disconnected"}`}>{d.role} · {d.connected ? "connected" : "disconnected"}</div>
                      {d.levelPercent !== undefined && <div style={{ color: "rgba(23,24,15,0.5)", fontSize: 12 }}>Level {d.levelPercent}%</div>}
                      {d.error && <div style={{ color: "#D64545", fontWeight: 700, fontSize: 12 }}>{d.error}</div>}
                    </div>
                  </div>
                ))}
            </div>
          )}
      </Panel>
    </div>
  );
}

// ── Logs ──────────────────────────────────────────────────────────────────────

function Logs({ logs }: { logs: LogEntry[] }) {
  return (
    <div className="panel">
      <h2>Logs</h2>
      <div className="stack" style={{ gap: 10 }}>
        {logs.length === 0
          ? <div style={{ background: "#F7F6F1", borderRadius: 8, padding: "14px 16px", color: "rgba(23,24,15,0.4)", fontSize: 13 }}>No logs yet</div>
          : logs.map((log) => (
            <div key={log.id} style={{ background: "#F7F6F1", borderRadius: 8, padding: "14px 16px" }}>
              <div className="logHeader">
                <strong>{log.message}</strong>
                {log.result && <em className={`logResult${log.result === "failure" ? " failure" : ""}`}>{log.result}</em>}
              </div>
              <div style={{ color: "rgba(23,24,15,0.45)", fontSize: 12, marginTop: 3 }}>
                {new Date(log.timestamp).toLocaleTimeString()} · {log.source}{log.actor ? ` · ${log.actor}` : ""}{log.action ? ` · ${log.action}` : ""}
              </div>
              {log.details && <div style={{ color: "rgba(23,24,15,0.45)", fontSize: 12 }}>{formatLogDetails(log.details)}</div>}
            </div>
          ))}
      </div>
    </div>
  );
}

// ── Network ───────────────────────────────────────────────────────────────────

function NetworkView({ snapshot, adminUnlocked, setError, lockAdmin }: { snapshot: StudyBoxSnapshot; adminUnlocked: boolean; setError: (e?: string) => void; lockAdmin: () => void }) {
  const [networks, setNetworks] = useState<import("@studybox/shared").WifiNetwork[]>([]);
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState<string>();
  const host = window.location.host || "localhost:5173";
  const hostname = window.location.hostname;
  const publicAccess = window.location.protocol === "https:" && !["localhost", "127.0.0.1"].includes(hostname);
  const tunnelHostname = snapshot.settings.cloudflare.hostname || (publicAccess ? hostname : "");

  async function scan() {
    if (!adminUnlocked) { setError("Enter the admin PIN before scanning for Wi-Fi networks."); return; }
    setScanning(true);
    try { setNetworks(await scanWifiNetworks()); setError(undefined); }
    catch (caught) { if (isAdminAuthError(caught)) lockAdmin(); setError(caught instanceof Error ? caught.message : "Wi-Fi scan failed"); }
    finally { setScanning(false); }
  }

  async function connect(ssid: string) {
    if (!adminUnlocked) { setError("Enter the admin PIN before adding a Wi-Fi network."); return; }
    setConnecting(ssid);
    try { await connectWifi(ssid, passwords[ssid] ?? ""); setError(undefined); }
    catch (caught) { if (isAdminAuthError(caught)) lockAdmin(); setError(caught instanceof Error ? caught.message : "Wi-Fi connection failed"); }
    finally { setConnecting(undefined); }
  }

  return (
    <div className="stack">
      <div className="metricGrid">
        <Metric label="WiFi"   value={snapshot.settings.wifi.configured ? snapshot.settings.wifi.ssid : "Not configured"} detail={snapshot.metrics.wifiConnected ? "Connected" : "Offline"} green={snapshot.metrics.wifiConnected} />
        <Metric label="Tunnel" value={tunnelHostname ? "Available" : "Not configured"} detail={tunnelHostname || "No public hostname detected"} green={Boolean(tunnelHostname)} />
        <Metric label="Access" value={publicAccess ? "Public" : "Local"} detail={host} />
        <Metric label="API"    value="Online" detail={`${window.location.origin}/api`} green />
      </div>
      <Panel title="Available Wi-Fi networks">
        <div className="wifiToolbar">
          <span className="mutedText">Add a network to the Pi's saved connections. NetworkManager will reconnect to saved networks automatically.</span>
          <button className="command" onClick={() => void scan()} disabled={scanning || !adminUnlocked}>{scanning ? "Scanning..." : "Scan"}</button>
        </div>
        {networks.length === 0
          ? <div className="mutedText">Scan to see nearby networks.</div>
          : <div className="wifiNetworkList">{networks.map((network) => <div className="wifiNetworkRow" key={network.ssid}>
            <div><strong>{network.ssid}</strong><small>{network.security} · {network.signalPercent}% signal{network.inUse ? " · connected" : ""}</small></div>
            <div className="wifiConnectControls"><input type="password" aria-label={`Password for ${network.ssid}`} placeholder={network.security === "Open" ? "No password" : "Password"} value={passwords[network.ssid] ?? ""} onChange={(event) => setPasswords((current) => ({ ...current, [network.ssid]: event.target.value }))} /><button className="command" onClick={() => void connect(network.ssid)} disabled={connecting === network.ssid || !adminUnlocked}>{connecting === network.ssid ? "Connecting..." : "Add"}</button></div>
          </div>)}</div>}
      </Panel>
    </div>
  );
}

// ── Admin unlock ──────────────────────────────────────────────────────────────

function AdminUnlock({ session, unlock, lock }: { session?: AdminSession; unlock: (pin: string) => Promise<void>; lock: () => void }) {
  const [pin, setPin] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const active = isAdminSessionActive(session);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setUnlocking(true);
    try { await unlock(pin); setPin(""); } finally { setUnlocking(false); }
  }

  if (active && session) {
    return (
      <div className="adminBadge">
        <ShieldCheck size={15} />
        <span>Admin until {new Date(session.expiresAt).toLocaleTimeString()}</span>
        <button onClick={lock}>Lock</button>
      </div>
    );
  }

  return (
    <form className="adminUnlock" onSubmit={(e) => void submit(e)}>
      <input aria-label="Admin PIN" inputMode="numeric" placeholder="Admin PIN" type="password" value={pin} onChange={(e) => setPin(e.target.value)} />
      <button disabled={unlocking || pin.trim().length === 0}>{unlocking ? "…" : "Unlock"}</button>
    </form>
  );
}

// ── OLED panel ────────────────────────────────────────────────────────────────

function OledPanel({ snapshot, run, pendingAction }: { snapshot: StudyBoxSnapshot; run: (path: string, body?: unknown) => Promise<void>; pendingAction?: string }) {
  const currentPage = useMemo(
    () => snapshot.oled.pages.find((p) => p.id === snapshot.oled.currentPageId) ?? snapshot.oled.pages[0],
    [snapshot]
  );
  return (
    <div className="oledCard">
      <div className="oledCardHeader">
        <h2>Device OLED</h2>
        <div className="oledLive">
          <span className="oledLiveDot" />
          Live
        </div>
      </div>
      <div className="oledBezel">
        <div className="oledScreen">
          <div className="oledScanlines" />
          <div className="oledRow">
            <span className="oledTitle">{currentPage.title}</span>
            {currentPage.id === "system" && <img className="oledPiLogo" src="/raspberrylogo.png" alt="" />}
          </div>
          {currentPage.lines.map((line, i) => (
            i === 0 && currentPage.id === "home"
              ? <div key={`${line}-${i}`} className="oledReady oledHomeBrand">{line}</div>
              : i === 0 && currentPage.id === "system"
              ? <div key={`${line}-${i}`} className="oledReady oledCenteredLine">{line}</div>
              : i === 0
              ? <div key={line} className="oledReady">{line}</div>
              : i === 1
              ? <div key={`${line}-${i}`} className="oledLabel">{line}</div>
              : <div key={`${line}-${i}`} className="oledValue">{line}</div>
          ))}
          {currentPage.actionLabel && <div className="oledValue" style={{ marginTop: 8, borderTop: "1px solid rgba(95,224,160,0.2)", paddingTop: 8 }}>{currentPage.actionLabel}</div>}
        </div>
      </div>
      <div className="oledCaption">mirrors the physical StudyBox display</div>
      <div className="oledButtons">
        <button onClick={() => run("/api/buttons/page")} disabled={Boolean(pendingAction)}>{pendingAction === "/api/buttons/page" ? "WORKING…" : "PAGE"}</button>
        <button onClick={() => run("/api/buttons/action")} disabled={Boolean(pendingAction)}>{pendingAction === "/api/buttons/action" ? "WORKING…" : "ACTION"}</button>
      </div>
    </div>
  );
}

// ── LED panel ─────────────────────────────────────────────────────────────────

function LedPanel({ snapshot }: { snapshot: StudyBoxSnapshot }) {
  const sysColor = snapshot.systemStatus === "ready" ? "green" : snapshot.systemStatus === "meeting-live" ? "blue" : snapshot.systemStatus === "attention" ? "yellow" : "red";
  const zoomColor = zoomLedClass(snapshot.hardware.zoomLed.state);
  const recColor = snapshot.podcast.status === "recording" ? "red" : "off";
  return (
    <div className="ledCard">
      <h2>LEDs</h2>
      <div className="ledRows">
        <div className="ledRow"><span className={`led ${sysColor}`} />System {sysColor}</div>
        <div className={`ledRow${snapshot.hardware.zoomLed.state === "off" ? " muted" : ""}`}><span className={`led ${zoomColor}`} />Zoom {formatZoomLedState(snapshot.hardware.zoomLed.state)}</div>
        <div className={`ledRow${snapshot.podcast.status !== "recording" ? " muted" : ""}`}><span className={`led ${recColor}`} />REC {snapshot.podcast.status}</div>
      </div>
      <div className="ledFooter">
        <img className="ledPiLogo" src="/raspberrylogo.png" alt="" />
        Raspberry Pi 5 · DJI Mic Receiver
      </div>
    </div>
  );
}

// ── Primitives ────────────────────────────────────────────────────────────────

function Panel({ title, children, sm }: { title: string; children: React.ReactNode; sm?: boolean }) {
  return (
    <section className="panel">
      <h2 className={sm ? "sm" : undefined}>{title}</h2>
      {children}
    </section>
  );
}

function Metric({ label, value, detail, accent, gray, green }: { label: string; value: string; detail: string; accent?: boolean; gray?: boolean; green?: boolean }) {
  const valueColor = gray ? "#9AA098" : green ? "#2E9E5B" : "#17180F";
  return (
    <div className={`metric${accent ? " nextMeeting" : ""}`}>
      <span>{label}</span>
      <strong style={{ color: valueColor }}>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function EmptyList({ children, empty }: { children: React.ReactNode; empty: string }) {
  const hasItems = Array.isArray(children) ? children.filter(Boolean).length > 0 : Boolean(children);
  return (
    <div className="list">
      {hasItems ? children : <div style={{ background: "#F7F6F1", borderRadius: 8, padding: 14, color: "rgba(23,24,15,0.4)", fontSize: 13 }}>{empty}</div>}
    </div>
  );
}

function ListRow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, background: "#F7F6F1", borderRadius: 8, padding: "14px 16px", marginBottom: 10 }}>
      {children}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  return <span className={`statusPill ${status}`}>{status === "meeting-live" ? "Meeting Live" : status}</span>;
}

function ViewerPresence({ presence }: { presence: StudyBoxSnapshot["presence"] }) {
  const count = presence.activeViewerCount;
  return (
    <span className={`viewerPresence${count > 1 ? " active" : ""}`} title={`${count} admin screen${count !== 1 ? "s" : ""} active`}>
      <Eye size={14} /> {count}
    </span>
  );
}

function AudioReadiness({ podcast }: { podcast: StudyBoxSnapshot["podcast"] }) {
  const ready = podcast.audioReady === true;
  return (
    <span className={`audioReadiness${ready ? "" : " missing"}`} title={podcast.audioLastEvent ?? "DJI microphone status unknown"}>
      <span className="dot" />
      {ready ? "DJI Mic ready" : "Mic offline"}
    </span>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isRecordingActive(snapshot: StudyBoxSnapshot) {
  return snapshot.podcast.status === "recording" || snapshot.podcast.status === "paused" || snapshot.podcast.status === "waitingForAudio" || (snapshot.podcast.status === "error" && Boolean(snapshot.podcast.activeRecording));
}

function statusCopy(snapshot: StudyBoxSnapshot): string {
  if (snapshot.podcast.audioReady !== true && snapshot.meeting.status !== "live") return "Audio is not ready; recording will wait";
  if (snapshot.systemStatus === "attention") return "Waiting room or raised hand needs attention";
  if (snapshot.meeting.status === "live") return "Meeting is live";
  return "Ready for the next scheduled study";
}

function getZoomJoinUrl(snapshot: StudyBoxSnapshot): string | undefined {
  const url = snapshot.settings.zoom.joinUrl?.trim();
  if (url) return url;
  const num = snapshot.settings.zoom.meetingNumber.replace(/\D/g, "");
  return num ? `https://zoom.us/j/${num}` : undefined;
}

function isZoomHostConnected(snapshot: StudyBoxSnapshot) {
  return snapshot.meeting.status === "live" && snapshot.zoom.mode === "runner" && snapshot.zoom.runnerAvailable;
}

function meetingPrimaryAction(snapshot: StudyBoxSnapshot): string {
  if (snapshot.meeting.status === "live") return snapshot.zoom.mode === "runner" && snapshot.zoom.runnerAvailable ? "End Zoom Meeting" : "End Local Session";
  return snapshot.zoom.mode === "runner" && snapshot.zoom.runnerAvailable ? "Start Zoom Meeting" : "Start Local Session";
}

function commandCopy(path: string): string {
  if (path === "/api/meeting/start") return "Starting meeting…";
  if (path === "/api/meeting/end") return "Ending meeting…";
  if (path === "/api/podcast/start") return "Starting recording…";
  if (path === "/api/podcast/stop") return "Finishing recording…";
  if (path === "/api/podcast/pause") return "Pausing recording…";
  if (path === "/api/podcast/resume") return "Resuming recording…";
  if (path === "/api/buttons/page") return "Changing OLED page…";
  if (path === "/api/buttons/action") return "Running OLED action…";
  return "Working…";
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

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function formatBytes(bytes: number): string { return `${(bytes / 1_000_000).toFixed(1)} MB`; }

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function getRecordingAsset(recording: Recording, kind: RecordingAssetKind): NonNullable<Recording["assets"]>[number] | undefined {
  const asset = recording.assets?.find((a) => a.kind === kind);
  if (asset) return asset;
  if (kind === "audio" && recording.downloadFileName) {
    return { kind: "audio", label: "Room audio", status: "available", fileName: recording.downloadFileName, mimeType: recording.downloadMimeType ?? "audio/wav", sizeBytes: recording.sizeBytes, availableUntil: recording.expiresAt };
  }
  return undefined;
}

function formatLogDetails(details: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(details).filter((e): e is [string, string|number|boolean] => e[1] !== undefined).map(([k, v]) => `${k}: ${v}`).join(" · ");
}

function isAdminSessionActive(session?: AdminSession): boolean {
  return Boolean(session?.token && Date.parse(session.expiresAt) > Date.now());
}

function isAdminAuthError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function readStoredAdminSession(): AdminSession | undefined {
  const stored = window.localStorage.getItem(adminSessionStorageKey);
  if (!stored) return undefined;
  try {
    const s = JSON.parse(stored) as AdminSession;
    if (isAdminSessionActive(s)) return s;
  } catch { /* ignore */ }
  window.localStorage.removeItem(adminSessionStorageKey);
  return undefined;
}

function readStoredPublicParticipant(): Participant | undefined {
  const stored = window.localStorage.getItem(publicJoinStorageKey);
  if (!stored) return undefined;
  try { return JSON.parse(stored) as Participant; }
  catch { window.localStorage.removeItem(publicJoinStorageKey); return undefined; }
}

function readOrCreateDashboardViewerId(): string {
  const stored = window.sessionStorage.getItem(dashboardViewerStorageKey);
  if (stored) return stored;
  const id = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `viewer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.sessionStorage.setItem(dashboardViewerStorageKey, id);
  return id;
}
