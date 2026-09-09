#include "zoom_adapter.h"

#include <stdexcept>

namespace {

class StubZoomAdapter final : public ZoomAdapter {
public:
  MeetingState startMeeting(const StartMeetingRequest& request, const MeetingState& current) override {
    if (request.meetingNumber.empty()) {
      throw std::runtime_error("meetingNumber is required");
    }
    if (request.sdkJwt.empty()) {
      throw std::runtime_error("sdkJwt is required");
    }
    if (request.zak.empty()) {
      throw std::runtime_error("zak is required");
    }

    MeetingState state = current;
    state.status = "error";
    state.lastEvent = "Native runner received host credentials, but Zoom SDK adapter is not linked yet";
    return state;
  }

  MeetingState endMeeting(const MeetingState& current) override {
    MeetingState state = current;
    state.status = "idle";
    state.meetingId.clear();
    state.startedAt.clear();
    state.lastEvent = "Native runner ended local state; Zoom SDK adapter is not linked yet";
    return state;
  }

  MeetingState admitParticipant(const std::string& participantId, const MeetingState& current) override {
    MeetingState state = current;
    state.lastEvent = "Cannot admit Zoom participant " + participantId + " until Zoom SDK adapter is linked";
    return state;
  }

  MeetingState allowParticipantToSpeak(const std::string& participantId, const MeetingState& current) override {
    MeetingState state = current;
    state.lastEvent = "Cannot allow Zoom participant " + participantId + " until Zoom SDK adapter is linked";
    return state;
  }

  MeetingState muteParticipant(const std::string& participantId, const MeetingState& current) override {
    MeetingState state = current;
    state.lastEvent = "Cannot mute Zoom participant " + participantId + " until Zoom SDK adapter is linked";
    return state;
  }

  MeetingState makeParticipantHost(const std::string& participantId, const MeetingState& current) override {
    MeetingState state = current;
    state.lastEvent = "Cannot make Zoom participant " + participantId + " host until Zoom SDK adapter is linked";
    return state;
  }

  MeetingState syncState(const MeetingState& current) override {
    return current;
  }

  MeetingState startZoomRecording(const std::string&, const MeetingState& current) override {
    MeetingState state = current;
    state.lastEvent = "Zoom local recording unavailable in stub runner";
    return state;
  }

  MeetingState stopZoomRecording(const MeetingState& current) override {
    return current;
  }
};

} // namespace

ZoomAdapter& zoomAdapter() {
  static StubZoomAdapter adapter;
  return adapter;
}
