#pragma once

#include <map>
#include <string>
#include <vector>

struct RunnerCommand {
  std::string id;
  std::string type;
  std::map<std::string, std::string> fields;
};

struct Participant {
  std::string id;
  std::string displayName;
  std::string status;
  std::string audioState;
  bool includedInPodcast = false;
};

struct MeetingState {
  std::string status = "idle";
  std::string title = "Weekly Bible Study";
  std::string moderationMode = "moderated";
  std::string meetingId;
  std::string startedAt;
  std::vector<Participant> participants;
  std::vector<Participant> waitingRoom;
  std::vector<Participant> raisedHands;
  std::string lastEvent = "Native Zoom runner initialized";
};

RunnerCommand parseCommand(const std::string& line);
std::string responseJson(const std::string& id, bool ok, const MeetingState& state, const std::string& error = "");
std::string eventJson(const std::string& type, const MeetingState& state);
std::string nowIso8601();
