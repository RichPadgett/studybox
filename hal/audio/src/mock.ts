import type { AudioDevice, AudioRoutingContext, AudioService, AudioServiceState } from "@studybox/shared";

export class MockAudioDevice implements AudioDevice {
  async getInputDevices(): Promise<string[]> {
    return ["DJI Mic Receiver (Mock)", "USB Audio Interface (Mock)"];
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
      inputDevices: [
        "DJI Mic Receiver (Mock)",
        "Conference Speakerphone Mic (Mock)",
        "USB Audio Interface (Mock)"
      ],
      outputDevices: [
        "Conference Speakerphone Speaker (Mock)",
        "HDMI Monitor Audio (Mock)"
      ],
      mixedLevelPercent: audioLevel,
      lastEvent: this.lastEvent,
      devices: [
        {
          id: "dji-receiver",
          label: this.teacherInputDeviceId === "dji-receiver" ? "DJI Mic Receiver" : "Teacher Mic Input",
          role: "teacher-mic",
          connected: true,
          levelPercent: Math.min(100, audioLevel + 8),
          muted: false
        },
        {
          id: "conference-speakerphone-mic",
          label: this.audienceInputDeviceId === "conference-speakerphone-mic" ? "Conference Speakerphone Mic" : "Audience Mic Input",
          role: "audience-mic",
          connected: true,
          levelPercent: Math.max(0, audioLevel - 12),
          muted: false
        },
        {
          id: "conference-speakerphone-output",
          label: this.speakerOutputDeviceId === "conference-speakerphone-output" ? "Conference Speakerphone Speaker" : "Room Speaker Output",
          role: "speaker-output",
          connected: true
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

  async listInputDevices(): Promise<string[]> {
    return this.getState({ meetingStatus: "idle", podcastStatus: "idle" }).inputDevices;
  }

  async listOutputDevices(): Promise<string[]> {
    return this.getState({ meetingStatus: "idle", podcastStatus: "idle" }).outputDevices;
  }

  async setTeacherInputDevice(deviceId: string): Promise<AudioServiceState> {
    this.teacherInputDeviceId = deviceId;
    this.lastEvent = `Teacher input set to ${deviceId}`;
    return this.getState({ meetingStatus: "idle", podcastStatus: "idle" });
  }

  async setAudienceInputDevice(deviceId: string): Promise<AudioServiceState> {
    this.audienceInputDeviceId = deviceId;
    this.lastEvent = `Audience input set to ${deviceId}`;
    return this.getState({ meetingStatus: "idle", podcastStatus: "idle" });
  }

  async setSpeakerOutputDevice(deviceId: string): Promise<AudioServiceState> {
    this.speakerOutputDeviceId = deviceId;
    this.lastEvent = `Speaker output set to ${deviceId}`;
    return this.getState({ meetingStatus: "idle", podcastStatus: "idle" });
  }
}
