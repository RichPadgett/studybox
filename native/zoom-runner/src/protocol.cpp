#include "protocol.h"

#include <chrono>
#include <ctime>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <vector>

namespace {

std::string jsonEscape(const std::string& value) {
  std::ostringstream output;
  for (const char ch : value) {
    switch (ch) {
      case '\\': output << "\\\\"; break;
      case '"': output << "\\\""; break;
      case '\n': output << "\\n"; break;
      case '\r': output << "\\r"; break;
      case '\t': output << "\\t"; break;
      default: output << ch; break;
    }
  }
  return output.str();
}

std::string extractStringField(const std::string& json, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  const auto keyPos = json.find(needle);
  if (keyPos == std::string::npos) {
    return "";
  }

  const auto colonPos = json.find(':', keyPos + needle.size());
  if (colonPos == std::string::npos) {
    return "";
  }

  auto quotePos = json.find('"', colonPos + 1);
  if (quotePos == std::string::npos) {
    return "";
  }

  std::string value;
  bool escaped = false;
  for (auto index = quotePos + 1; index < json.size(); ++index) {
    const char ch = json[index];
    if (escaped) {
      value.push_back(ch);
      escaped = false;
      continue;
    }

    if (ch == '\\') {
      escaped = true;
      continue;
    }

    if (ch == '"') {
      return value;
    }

    value.push_back(ch);
  }

  return "";
}

std::string participantJson(const Participant& participant) {
  std::ostringstream output;
  output
    << "{\"id\":\"" << jsonEscape(participant.id) << "\""
    << ",\"displayName\":\"" << jsonEscape(participant.displayName) << "\""
    << ",\"status\":\"" << jsonEscape(participant.status) << "\"";

  if (!participant.audioState.empty()) {
    output << ",\"audioState\":\"" << jsonEscape(participant.audioState) << "\"";
  }

  if (participant.includedInPodcast) {
    output << ",\"includedInPodcast\":true";
  }

  output << "}";
  return output.str();
}

std::string participantsJson(const std::vector<Participant>& participants) {
  std::ostringstream output;
  output << "[";
  for (std::size_t index = 0; index < participants.size(); ++index) {
    if (index > 0) {
      output << ",";
    }
    output << participantJson(participants[index]);
  }
  output << "]";
  return output.str();
}

std::string stateJson(const MeetingState& state) {
  std::ostringstream output;
  output
    << "{\"status\":\"" << jsonEscape(state.status) << "\""
    << ",\"title\":\"" << jsonEscape(state.title) << "\""
    << ",\"moderationMode\":\"" << jsonEscape(state.moderationMode) << "\"";

  if (!state.meetingId.empty()) {
    output << ",\"meetingId\":\"" << jsonEscape(state.meetingId) << "\"";
  }

  if (!state.startedAt.empty()) {
    output << ",\"startedAt\":\"" << jsonEscape(state.startedAt) << "\"";
  }

  output
    << ",\"participants\":" << participantsJson(state.participants)
    << ",\"lobbyRequests\":[]"
    << ",\"waitingRoom\":" << participantsJson(state.waitingRoom)
    << ",\"raisedHands\":" << participantsJson(state.raisedHands);

  if (!state.lastEvent.empty()) {
    output << ",\"lastEvent\":\"" << jsonEscape(state.lastEvent) << "\"";
  }

  output << "}";
  return output.str();
}

} // namespace

RunnerCommand parseCommand(const std::string& line) {
  RunnerCommand command;
  command.id = extractStringField(line, "id");
  command.type = extractStringField(line, "type");
  if (command.id.empty() || command.type.empty()) {
    throw std::runtime_error("Command must include id and type");
  }

  for (const std::string& key : {"meetingNumber", "password", "displayName", "sdkJwt", "zak", "participantId", "mode"}) {
    const auto value = extractStringField(line, key);
    if (!value.empty()) {
      command.fields[key] = value;
    }
  }

  return command;
}

std::string responseJson(const std::string& id, bool ok, const MeetingState& state, const std::string& error) {
  std::ostringstream output;
  output << "{\"kind\":\"response\",\"id\":\"" << jsonEscape(id) << "\",\"ok\":" << (ok ? "true" : "false");
  if (!ok) {
    output << ",\"error\":\"" << jsonEscape(error) << "\"";
  }
  output << ",\"state\":" << stateJson(state) << "}";
  return output.str();
}

std::string eventJson(const std::string& type, const MeetingState& state) {
  std::ostringstream output;
  output << "{\"kind\":\"event\",\"type\":\"" << jsonEscape(type) << "\",\"state\":" << stateJson(state) << "}";
  return output.str();
}

std::string nowIso8601() {
  const auto now = std::chrono::system_clock::now();
  const auto time = std::chrono::system_clock::to_time_t(now);
  std::tm utc{};
#if defined(_WIN32)
  gmtime_s(&utc, &time);
#else
  gmtime_r(&time, &utc);
#endif
  std::ostringstream output;
  output << std::put_time(&utc, "%Y-%m-%dT%H:%M:%SZ");
  return output.str();
}
