#pragma once

#include "protocol.h"

#include <string>

struct StartMeetingRequest {
  std::string meetingNumber;
  std::string password;
  std::string displayName;
  std::string sdkJwt;
  std::string zak;
};

class ZoomAdapter {
public:
  virtual ~ZoomAdapter() = default;
  virtual MeetingState startMeeting(const StartMeetingRequest& request, const MeetingState& current) = 0;
  virtual MeetingState endMeeting(const MeetingState& current) = 0;
  virtual MeetingState admitParticipant(const std::string& participantId, const MeetingState& current) = 0;
  virtual MeetingState allowParticipantToSpeak(const std::string& participantId, const MeetingState& current) = 0;
  virtual MeetingState muteParticipant(const std::string& participantId, const MeetingState& current) = 0;
};

ZoomAdapter& zoomAdapter();
