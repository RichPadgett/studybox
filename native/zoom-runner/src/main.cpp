#include "protocol.h"
#include "zoom_adapter.h"

#ifdef STUDYBOX_ENABLE_ZOOM_SDK
#include <glib.h>
#endif

#include <iostream>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>

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

  if (command.type == "startZoomRecording") {
    state = zoomAdapter().startZoomRecording(field(command, "recordingDirectory"), state);
    std::cout << responseJson(command.id, state.status != "error", state, state.status == "error" ? state.lastEvent : "") << std::endl;
    return;
  }

  if (command.type == "stopZoomRecording") {
    state = zoomAdapter().stopZoomRecording(state);
    std::cout << responseJson(command.id, state.status != "error", state, state.status == "error" ? state.lastEvent : "") << std::endl;
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
    state = zoomAdapter().syncState(state);
    std::cout << responseJson(command.id, true, state) << std::endl;
    return;
  }

  throw std::runtime_error("Unknown command type: " + command.type);
}

void executeLine(const std::string& line) {
  std::string commandId;
  try {
    const auto command = parseCommand(line);
    commandId = command.id;
    execute(command);
  } catch (const std::exception& error) {
    std::cout << responseJson(commandId.empty() ? "unknown" : commandId, false, state, error.what()) << std::endl;
  }
}

} // namespace

#ifdef STUDYBOX_ENABLE_ZOOM_SDK
struct SdkCommandTask {
  explicit SdkCommandTask(std::string input) : line(std::move(input)) {}

  std::string line;
  std::mutex mutex;
  std::condition_variable done;
  bool completed = false;
};

void runCommandLoop(GMainLoop* loop) {
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) {
      continue;
    }

    auto task = std::make_shared<SdkCommandTask>(line);
    g_main_context_invoke(nullptr, [](gpointer data) -> gboolean {
      auto* task = static_cast<SdkCommandTask*>(data);
      executeLine(task->line);
      {
        std::lock_guard<std::mutex> lock(task->mutex);
        task->completed = true;
      }
      task->done.notify_one();
      return G_SOURCE_REMOVE;
    }, task.get());

    std::unique_lock<std::mutex> lock(task->mutex);
    task->done.wait(lock, [&task] {
      return task->completed;
    });
  }

  g_main_loop_quit(loop);
}
#endif

int main() {
  std::cout << eventJson("ready", state) << std::endl;

#ifdef STUDYBOX_ENABLE_ZOOM_SDK
  GMainLoop* loop = g_main_loop_new(nullptr, false);
  g_timeout_add(100, [](gpointer) -> gboolean {
    return TRUE;
  }, loop);

  std::thread commandThread(runCommandLoop, loop);
  g_main_loop_run(loop);

  if (commandThread.joinable()) {
    commandThread.join();
  }
  g_main_loop_unref(loop);
  return 0;
#else
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) {
      continue;
    }

    executeLine(line);
  }

  return 0;
#endif
}
