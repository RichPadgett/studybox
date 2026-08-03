import type { AudioDevice, AudioDeviceOption, AudioRoutingContext, AudioService, AudioServiceState } from "@studybox/shared";

export class RaspberryPiAudioDevice implements AudioDevice {
  async getInputDevices(): Promise<string[]> {
    throw new Error("Raspberry Pi audio implementation is not available yet.");
  }

  async getLevel(): Promise<number> {
    throw new Error("Raspberry Pi audio implementation is not available yet.");
  }
}

export class RaspberryPiAudioService implements AudioService {
  getState(_context: AudioRoutingContext): AudioServiceState {
    throw new Error("Raspberry Pi audio service implementation is not available yet.");
  }

  async listInputDevices(): Promise<AudioDeviceOption[]> {
    throw new Error("Raspberry Pi audio service implementation is not available yet.");
  }

  async listOutputDevices(): Promise<AudioDeviceOption[]> {
    throw new Error("Raspberry Pi audio service implementation is not available yet.");
  }

  async setTeacherInputDevice(_deviceId: string): Promise<AudioServiceState> {
    throw new Error("Raspberry Pi audio service implementation is not available yet.");
  }

  async setAudienceInputDevice(_deviceId: string): Promise<AudioServiceState> {
    throw new Error("Raspberry Pi audio service implementation is not available yet.");
  }

  async setSpeakerOutputDevice(_deviceId: string): Promise<AudioServiceState> {
    throw new Error("Raspberry Pi audio service implementation is not available yet.");
  }
}
