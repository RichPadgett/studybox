import type { AudioDevice, AudioDeviceOption, AudioRoutingContext, AudioService, AudioServiceState } from "@studybox/shared";

const inputDevices: AudioDeviceOption[] = [
  { id: "dji-receiver", label: "DJI Mic Receiver (Mock)", kind: "input", connected: true },
  { id: "conference-speakerphone-mic", label: "Conference Speakerphone Mic (Mock)", kind: "input", connected: true },
  { id: "usb-audio-interface", label: "USB Audio Interface (Mock)", kind: "input", connected: true },
  { id: "offline-boundary-mic", label: "Boundary Mic (Disconnected Mock)", kind: "input", connected: false }
];

const outputDevices: AudioDeviceOption[] = [
  { id: "conference-speakerphone-output", label: "Conference Speakerphone Speaker (Mock)", kind: "output", connected: true },
  { id: "hdmi-monitor-audio", label: "HDMI Monitor Audio (Mock)", kind: "output", connected: true },
  { id: "offline-usb-speaker", label: "USB Speaker (Disconnected Mock)", kind: "output", connected: false }
];

export class MockAudioDevice implements AudioDevice {
  async getInputDevices(): Promise<string[]> {
    return inputDevices.map((device) => device.label);
  }

  async getLevel(): Promise<number> {
    return Math.round(35 + Math.random() * 45);
  }
}

export class MockAudioService implements AudioService {
  private teacherInputDeviceId = "dji-receiver";
  private audienceInputDeviceId = "conference-speakerphone-mic";
  private speakerOutputDeviceId = "conference-speakerphone-output";
  private lastEvent = "Mock audio routing service ready";

  getState(context: AudioRoutingContext): AudioServiceState {
    const audioLevel = 42 + Math.round((Math.sin(Date.now() / 2500) + 1) * 18);
    const activeSpeaker = context.activeSpeaker;

    return {
      mode: "mock",
      health: "ready",
      connected: true,
      inputDevices,
      outputDevices,
      selectedTeacherInputDeviceId: this.teacherInputDeviceId,
      selectedAudienceInputDeviceId: this.audienceInputDeviceId,
      selectedSpeakerOutputDeviceId: this.speakerOutputDeviceId,
      mixedLevelPercent: audioLevel,
      lastEvent: this.lastEvent,
      devices: [
        {
          id: "dji-receiver",
          label: `${this.getInputDeviceLabel(this.teacherInputDeviceId)} as Teacher`,
          role: "teacher-mic",
          connected: this.isInputConnected(this.teacherInputDeviceId),
          levelPercent: Math.min(100, audioLevel + 8),
          muted: false
        },
        {
          id: "conference-speakerphone-mic",
          label: `${this.getInputDeviceLabel(this.audienceInputDeviceId)} as Audience`,
          role: "audience-mic",
          connected: this.isInputConnected(this.audienceInputDeviceId),
          levelPercent: Math.max(0, audioLevel - 12),
          muted: false
        },
        {
          id: "conference-speakerphone-output",
          label: `${this.getOutputDeviceLabel(this.speakerOutputDeviceId)} as Room Speaker`,
          role: "speaker-output",
          connected: this.isOutputConnected(this.speakerOutputDeviceId)
        },
        {
          id: "remote-zoom-audio",
          label: "Remote Zoom Audio to Room",
          role: "remote-audio",
          connected: context.meetingStatus === "live",
          muted: false,
          includedInPodcast: false
        },
        {
          id: "approved-remote-speaker",
          label: activeSpeaker ? `${activeSpeaker.displayName} Podcast Feed` : "Approved Remote Speaker Feed",
          role: "approved-remote-speaker",
          connected: Boolean(activeSpeaker),
          levelPercent: activeSpeaker ? Math.max(0, audioLevel - 18) : 0,
          muted: !activeSpeaker,
          includedInPodcast: Boolean(activeSpeaker?.includedInPodcast)
        },
        {
          id: "mixed-audio-bus",
          label: "Mixed Audio Bus",
          role: "mixed-bus",
          connected: true,
          levelPercent: audioLevel
        },
        {
          id: "zoom-destination",
          label: "Zoom Meeting Audio",
          role: "zoom-output",
          connected: context.meetingStatus === "live"
        },
        {
          id: "recording-destination",
          label: "Podcast Recording Audio",
          role: "recording-output",
          connected: context.podcastStatus !== "idle"
        }
      ]
    };
  }

  async listInputDevices(): Promise<AudioDeviceOption[]> {
    return inputDevices;
  }

  async listOutputDevices(): Promise<AudioDeviceOption[]> {
    return outputDevices;
  }

  async setTeacherInputDevice(deviceId: string): Promise<AudioServiceState> {
    this.assertInputDevice(deviceId);
    this.teacherInputDeviceId = deviceId;
    this.lastEvent = `Teacher input set to ${this.getInputDeviceLabel(deviceId)}`;
    return this.getState({ meetingStatus: "idle", podcastStatus: "idle" });
  }

  async setAudienceInputDevice(deviceId: string): Promise<AudioServiceState> {
    this.assertInputDevice(deviceId);
    this.audienceInputDeviceId = deviceId;
    this.lastEvent = `Audience input set to ${this.getInputDeviceLabel(deviceId)}`;
    return this.getState({ meetingStatus: "idle", podcastStatus: "idle" });
  }

  async setSpeakerOutputDevice(deviceId: string): Promise<AudioServiceState> {
    this.assertOutputDevice(deviceId);
    this.speakerOutputDeviceId = deviceId;
    this.lastEvent = `Speaker output set to ${this.getOutputDeviceLabel(deviceId)}`;
    return this.getState({ meetingStatus: "idle", podcastStatus: "idle" });
  }

  private assertInputDevice(deviceId: string): void {
    if (!inputDevices.some((device) => device.id === deviceId)) {
      throw new Error(`Unknown mock input device: ${deviceId}`);
    }
  }

  private assertOutputDevice(deviceId: string): void {
    if (!outputDevices.some((device) => device.id === deviceId)) {
      throw new Error(`Unknown mock output device: ${deviceId}`);
    }
  }

  private getInputDeviceLabel(deviceId: string): string {
    return inputDevices.find((device) => device.id === deviceId)?.label ?? deviceId;
  }

  private getOutputDeviceLabel(deviceId: string): string {
    return outputDevices.find((device) => device.id === deviceId)?.label ?? deviceId;
  }

  private isInputConnected(deviceId: string): boolean {
    return Boolean(inputDevices.find((device) => device.id === deviceId)?.connected);
  }

  private isOutputConnected(deviceId: string): boolean {
    return Boolean(outputDevices.find((device) => device.id === deviceId)?.connected);
  }
}
