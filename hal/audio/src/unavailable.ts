import type { AudioDevice, AudioDeviceOption, AudioRoutingContext, AudioService, AudioServiceState } from "@studybox/shared";

const unavailableMessage = "Audio routing controls are not implemented yet; DJI recording remains available.";

export class UnavailableAudioDevice implements AudioDevice {
  async getInputDevices(): Promise<string[]> {
    return [];
  }

  async getLevel(): Promise<number> {
    return 0;
  }
}

export class UnavailableAudioService implements AudioService {
  getState(_context: AudioRoutingContext): AudioServiceState {
    return {
      mode: "raspberryPi",
      health: "missing",
      connected: false,
      inputDevices: [],
      outputDevices: [],
      selectedTeacherInputDeviceId: "",
      selectedAudienceInputDeviceId: "",
      selectedSpeakerOutputDeviceId: "",
      mixedLevelPercent: 0,
      lastEvent: unavailableMessage,
      devices: []
    };
  }

  async listInputDevices(): Promise<AudioDeviceOption[]> {
    return [];
  }

  async listOutputDevices(): Promise<AudioDeviceOption[]> {
    return [];
  }

  async setTeacherInputDevice(_deviceId: string): Promise<AudioServiceState> {
    throw new Error(unavailableMessage);
  }

  async setAudienceInputDevice(_deviceId: string): Promise<AudioServiceState> {
    throw new Error(unavailableMessage);
  }

  async setSpeakerOutputDevice(_deviceId: string): Promise<AudioServiceState> {
    throw new Error(unavailableMessage);
  }
}
