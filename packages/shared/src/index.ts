export type SystemStatus = "booting" | "ready" | "meeting-live" | "attention" | "error" | "wifi-setup";

export type LedColor = "green" | "blue" | "yellow" | "red" | "purple" | "white" | "off";

export type RecLedState = "solid" | "blinking" | "off";

export type ParticipantStatus = "joined" | "waiting" | "raised-hand";

export interface Participant {
  id: string;
  displayName: string;
  status: ParticipantStatus;
  joinedAt?: string;
}

export interface MeetingState {
  status: "idle" | "starting" | "live" | "ending" | "error";
  title: string;
  meetingId?: string;
  startedAt?: string;
  participants: Participant[];
  waitingRoom: Participant[];
  raisedHands: Participant[];
  lastEvent?: string;
}

export interface Recording {
  id: string;
  title: string;
  startedAt: string;
  endedAt?: string;
  durationSeconds: number;
  sizeBytes: number;
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

export interface MeetingSchedule {
  dayOfWeek: "Sunday" | "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday";
  time: string;
  timezone: string;
  autoStartMeeting: boolean;
  autoStartRecording: boolean;
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
  zoom: ZoomSettings;
  audio: AudioSettings;
  wifi: WifiSettings;
  cloudflare: CloudflareSettings;
  oled: OledSettings;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: "info" | "warn" | "error";
  source: "system" | "meeting" | "podcast" | "hal" | "scheduler";
  message: string;
}

export interface StudyBoxSnapshot {
  systemStatus: SystemStatus;
  meeting: MeetingState;
  zoom: ZoomRuntimeStatus;
  podcast: PodcastState;
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
  lastError?: string;
}

export interface MeetingService {
  getState(): MeetingState;
  startMeeting(): Promise<MeetingState>;
  endMeeting(): Promise<MeetingState>;
  admitParticipant(participantId: string): Promise<MeetingState>;
  dismissRaisedHand(participantId: string): Promise<MeetingState>;
}

export interface PodcastService {
  getState(): PodcastState;
  startRecording(): Promise<PodcastState>;
  pauseRecording(): Promise<PodcastState>;
  resumeRecording(): Promise<PodcastState>;
  stopRecording(): Promise<PodcastState>;
  listRecordings(): Promise<Recording[]>;
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
