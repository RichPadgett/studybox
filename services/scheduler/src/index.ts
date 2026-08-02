import type { MeetingSchedule, SchedulerService } from "@studybox/shared";

export class MockSchedulerService implements SchedulerService {
  private schedule: MeetingSchedule = {
    dayOfWeek: "Saturday",
    time: "11:00",
    timezone: "America/New_York",
    autoStartMeeting: true,
    autoStartRecording: true
  };

  getSchedule(): MeetingSchedule {
    return this.schedule;
  }

  async updateSchedule(schedule: MeetingSchedule): Promise<MeetingSchedule> {
    this.schedule = schedule;
    return this.schedule;
  }
}
