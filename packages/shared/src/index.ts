export type SystemStatus = "booting" | "ready" | "meeting-live" | "attention" | "error" | "wifi-setup";

export type LedColor = "green" | "blue" | "yellow" | "red" | "purple" | "white" | "off";

export type RecLedState = "solid" | "blinking" | "off";

export type ParticipantStatus = "joined" | "waiting" | "raised-hand";

export type ParticipantAudioState = "muted" | "allowed-to-speak" | "speaking";

export type MeetingModerationMode = "moderated" | "open" | "trusted-speakers";

export interface Participant {
  id: string;
  displayName: string;
  status: ParticipantStatus;
  audioState?: ParticipantAudioState;
  includedInPodcast?: boolean;
  trustedSpeaker?: boolean;
  joinedAt?: string;
}

export interface MeetingState {
  status: "idle" | "starting" | "live" | "ending" | "error";
  title: string;
  moderationMode: MeetingModerationMode;
  meetingId?: string;
  startedAt?: string;
  participants: Participant[];
  waitingRoom: Participant[];
  raisedHands: Participant[];
  activeSpeaker?: Participant;
  lastEvent?: string;
}

export interface Recording {
  id: string;
  title: string;
  startedAt: string;
  endedAt?: string;
  durationSeconds: number;
  sizeBytes: number;
  downloadFileName?: string;
  downloadMimeType?: string;
}

export interface RecordingDownload {
  recording: Recording;
  fileName: string;
  mimeType: string;
  contentBase64: string;
}

export interface PodcastState {
  status: "idle" | "recording" | "paused" | "stopping" | "error";
  activeRecording?: Recording;
  elapsedSeconds: number;
  recordings: Recording[];
  lastEvent?: string;
}

export type OledPageId = "home" | "meeting" | "podcast" | "system";

export interface OledPage {
  id: OledPageId;
  title: string;
  lines: string[];
  actionLabel?: string;
}

export interface SystemMetrics {
  cpuPercent: number;
  ssdPercent: number;
  wifiConnected: boolean;
  temperatureC: number;
}

export type HardwareMode = "mock" | "raspberryPi";
export type HardwareHealth = "ready" | "missing" | "error";

export interface HardwareComponentStatus {
  mode: HardwareMode;
  health: HardwareHealth;
  connected: boolean;
  lastEvent?: string;
  error?: string;
}

export interface ButtonHardwareStatus extends HardwareComponentStatus {
  label: "PAGE" | "ACTION";
  lastPressedAt?: string;
}

export interface AudioHardwareDeviceStatus {
  id: string;
  label: string;
  role: "teacher-mic" | "audience-mic" | "speaker-output" | "mixed-bus" | "zoom-output" | "recording-output" | "remote-audio" | "approved-remote-speaker";
  connected: boolean;
  levelPercent?: number;
  muted?: boolean;
  includedInPodcast?: boolean;
  error?: string;
}

export interface HardwareState {
  oled: HardwareComponentStatus & {
    currentPageId: OledPageId;
    currentPageTitle: string;
  };
  pageButton: ButtonHardwareStatus;
  actionButton: ButtonHardwareStatus & {
    ringColor: LedColor;
    ringMode: "solid" | "pulsing" | "off";
  };
  recordingLed: HardwareComponentStatus & {
    state: RecLedState;
  };
  audio: HardwareComponentStatus & {
    devices: AudioHardwareDeviceStatus[];
    mixedLevelPercent: number;
  };
}

export interface MeetingSchedule {
  dayOfWeek: "Sunday" | "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday";
  time: string;
  timezone: string;
  autoStartMeeting: boolean;
  autoStartRecording: boolean;
}

export interface MeetingModerationSettings {
  mode: MeetingModerationMode;
  joinMuted: boolean;
  raiseHandRequired: boolean;
  assistantApprovesSpeakers: boolean;
  includeApprovedRemoteSpeakersInPodcast: boolean;
}

export interface ZoomSettings {
  meetingNumber: string;
  displayName: string;
  clientIdConfigured?: boolean;
  sdkSecretConfigured: boolean;
  webhookSecretConfigured?: boolean;
  redirectUri?: string;
  deviceOAuthEnabled?: boolean;
}

export interface AudioSettings {
  inputDevice: string;
  gain: number;
  monitorEnabled: boolean;
}

export interface CloudflareSettings {
  tunnelEnabled: boolean;
  hostname: string;
}

export interface OledSettings {
  brightness: number;
  rotate180: boolean;
}

export interface WifiSettings {
  ssid: string;
  configured: boolean;
}

export interface StudyBoxSettings {
  schedule: MeetingSchedule;
  moderation: MeetingModerationSettings;
  zoom: ZoomSettings;
  audio: AudioSettings;
  wifi: WifiSettings;
  cloudflare: CloudflareSettings;
  oled: OledSettings;
}

export type LogSource = "system" | "web" | "button" | "meeting" | "podcast" | "backup" | "hal" | "scheduler" | "zoom-webhook" | "zoom-runner";
export type LogLevel = "info" | "warn" | "error";
export type LogResult = "success" | "failure";

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  source: LogSource;
  message: string;
  action?: string;
  actor?: string;
  result?: LogResult;
  details?: Record<string, string | number | boolean | undefined>;
}

export interface StudyBoxSnapshot {
  systemStatus: SystemStatus;
  meeting: MeetingState;
  zoom: ZoomRuntimeStatus;
  podcast: PodcastState;
  backup: BackupSyncState;
  hardware: HardwareState;
  oled: {
    currentPageId: OledPageId;
    pages: OledPage[];
  };
  metrics: SystemMetrics;
  settings: StudyBoxSettings;
  logs: LogEntry[];
}

export interface ZoomRuntimeStatus {
  mode: "mock" | "runner";
  configured: boolean;
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
  webhookSecretConfigured: boolean;
  redirectUri?: string;
  runnerPath?: string;
  runnerAvailable: boolean;
  sdkArch: "linux-arm64" | "linux-x86_64" | "unknown";
  oauth: ZoomOAuthStatus;
  lastError?: string;
}

export interface ZoomOAuthStatus {
  authorized: boolean;
  expiresAt?: string;
  scopes?: string[];
  user?: ZoomUserProfile;
}

export interface ZoomUserProfile {
  id: string;
  accountId?: string;
  displayName?: string;
  email?: string;
}

export interface ZoomDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
  expiresAt: string;
}

export interface AdminSession {
  token: string;
  expiresAt: string;
}

export interface ZoomZakStatus {
  available: boolean;
  expiresAt?: string;
  tokenLength?: number;
}

export type BackupBundleStatus = "pending" | "uploading" | "uploaded" | "failed";

export interface BackupBundle {
  id: string;
  recordingId: string;
  recordingTitle: string;
  fileName: string;
  meetingEndedAt: string;
  recordingStartedAt: string;
  recordingEndedAt: string;
  createdAt: string;
  status: BackupBundleStatus;
  target: string;
  logEntryCount: number;
  lastAttemptAt?: string;
  uploadedAt?: string;
  error?: string;
}

export interface BackupSyncState {
  mode: "mock" | "rsync";
  target: string;
  pendingCount: number;
  uploadedCount: number;
  failedCount: number;
  bundles: BackupBundle[];
  lastEvent?: string;
}

export interface BackupSyncService {
  load(): Promise<BackupSyncState>;
  getState(): BackupSyncState;
  createBundle(input: {
    recording: Recording;
    download: RecordingDownload;
    logs: LogEntry[];
    meetingEndedAt: string;
  }): Promise<BackupBundle>;
  syncPending(): Promise<BackupSyncState>;
}

export interface MeetingService {
  getState(): MeetingState;
  startMeeting(): Promise<MeetingState>;
  endMeeting(): Promise<MeetingState>;
  admitParticipant(participantId: string): Promise<MeetingState>;
  dismissRaisedHand(participantId: string): Promise<MeetingState>;
  allowParticipantToSpeak(participantId: string): Promise<MeetingState>;
  muteParticipant(participantId: string): Promise<MeetingState>;
  setParticipantPodcastInclusion(participantId: string, included: boolean): Promise<MeetingState>;
  setModerationMode(mode: MeetingModerationMode): Promise<MeetingState>;
}

export interface PodcastService {
  getState(): PodcastState;
  startRecording(): Promise<PodcastState>;
  pauseRecording(): Promise<PodcastState>;
  resumeRecording(): Promise<PodcastState>;
  stopRecording(): Promise<PodcastState>;
  listRecordings(): Promise<Recording[]>;
  getRecordingDownload(recordingId: string): Promise<RecordingDownload | undefined>;
}

export interface SchedulerService {
  getSchedule(): MeetingSchedule;
  updateSchedule(schedule: MeetingSchedule): Promise<MeetingSchedule>;
}

export interface OledDisplay {
  getPages(): OledPage[];
  getCurrentPage(): OledPage;
  nextPage(): Promise<OledPage>;
  render(page: OledPage): Promise<void>;
}

export interface ButtonController {
  pressPage(): Promise<void>;
  pressAction(): Promise<void>;
}

export interface LedController {
  setSystem(color: LedColor): Promise<void>;
  setRecording(state: RecLedState): Promise<void>;
}

export interface AudioDevice {
  getInputDevices(): Promise<string[]>;
  getLevel(): Promise<number>;
}

export type ZoomRunnerCommand =
  | { id: string; type: "startMeeting" }
  | { id: string; type: "endMeeting" }
  | { id: string; type: "admitParticipant"; participantId: string }
  | { id: string; type: "dismissRaisedHand"; participantId: string }
  | { id: string; type: "allowParticipantToSpeak"; participantId: string }
  | { id: string; type: "muteParticipant"; participantId: string }
  | { id: string; type: "setParticipantPodcastInclusion"; participantId: string; included: boolean }
  | { id: string; type: "setModerationMode"; mode: MeetingModerationMode }
  | { id: string; type: "getState" };

export type ZoomRunnerResponse =
  | { id: string; ok: true; state?: MeetingState }
  | { id: string; ok: false; error: string; state?: MeetingState };

export type ZoomRunnerEvent =
  | { type: "ready"; state: MeetingState }
  | { type: "meeting.state"; state: MeetingState }
  | { type: "log"; level: LogEntry["level"]; message: string }
  | { type: "error"; message: string };
