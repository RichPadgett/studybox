#include "protocol.h"
#include "zoom_adapter.h"

#include <iostream>
#include <stdexcept>
#include <string>

namespace {

MeetingState state;

std::string field(const RunnerCommand& command, const std::string& key) {
  const auto item = command.fields.find(key);
  return item == command.fields.end() ? "" : item->second;
}

StartMeetingRequest startMeetingRequest(const RunnerCommand& command) {
  return {
    field(command, "meetingNumber"),
    field(command, "password"),
    field(command, "displayName"),
    field(command, "sdkJwt"),
    field(command, "zak")
  };
}

void execute(const RunnerCommand& command) {
  if (command.type == "startMeeting") {
    state = zoomAdapter().startMeeting(startMeetingRequest(command), state);
    if (state.status != "error") {
      state.status = "live";
      state.meetingId = field(command, "meetingNumber");
      state.startedAt = nowIso8601();
    }
    std::cout << eventJson("meeting.state", state) << std::endl;
    std::cout << responseJson(command.id, state.status != "error", state, state.status == "error" ? state.lastEvent : "") << std::endl;
    return;
  }

  if (command.type == "endMeeting") {
    state = zoomAdapter().endMeeting(state);
    std::cout << eventJson("meeting.state", state) << std::endl;
    std::cout << responseJson(command.id, true, state) << std::endl;
    return;
  }

  if (command.type == "admitParticipant") {
    state = zoomAdapter().admitParticipant(field(command, "participantId"), state);
    std::cout << eventJson("meeting.state", state) << std::endl;
    std::cout << responseJson(command.id, true, state) << std::endl;
    return;
  }

  if (command.type == "allowParticipantToSpeak") {
    state = zoomAdapter().allowParticipantToSpeak(field(command, "participantId"), state);
    std::cout << eventJson("meeting.state", state) << std::endl;
    std::cout << responseJson(command.id, true, state) << std::endl;
    return;
  }

  if (command.type == "muteParticipant") {
    state = zoomAdapter().muteParticipant(field(command, "participantId"), state);
    std::cout << eventJson("meeting.state", state) << std::endl;
    std::cout << responseJson(command.id, true, state) << std::endl;
    return;
  }

  if (command.type == "dismissRaisedHand" || command.type == "setParticipantPodcastInclusion" || command.type == "setModerationMode") {
    state.lastEvent = "Command accepted by native runner; Zoom SDK adapter is not linked yet";
    std::cout << responseJson(command.id, true, state) << std::endl;
    return;
  }

  if (command.type == "getState") {
    std::cout << responseJson(command.id, true, state) << std::endl;
    return;
  }

  throw std::runtime_error("Unknown command type: " + command.type);
}

} // namespace

int main() {
  std::cout << eventJson("ready", state) << std::endl;

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) {
      continue;
    }

    std::string commandId;
    try {
      const auto command = parseCommand(line);
      commandId = command.id;
      execute(command);
    } catch (const std::exception& error) {
      std::cout << responseJson(commandId.empty() ? "unknown" : commandId, false, state, error.what()) << std::endl;
    }
  }

  return 0;
}
