#include "zoom_adapter.h"

#include "auth_service_interface.h"
#include "meeting_service_components/meeting_audio_interface.h"
#include "meeting_service_components/meeting_participants_ctrl_interface.h"
#include "meeting_service_components/meeting_recording_interface.h"
#include "meeting_service_components/meeting_sharing_interface.h"
#include "meeting_service_components/meeting_waiting_room_interface.h"
#include "rawdata/rawdata_renderer_interface.h"
#include "rawdata/zoom_rawdata_api.h"
#include "zoom_sdk_raw_data_def.h"
#include "meeting_service_interface.h"
#include "setting_service_interface.h"
#include "zoom_sdk.h"

#include <glib.h>

#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <ctime>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <unistd.h>
#include <vector>

namespace {

using namespace ZOOMSDK;

std::string sdkErrorMessage(const std::string& action, SDKError error) {
  std::ostringstream output;
  output << action << " failed with SDKError " << static_cast<int>(error);
  return output.str();
}

std::string authResultMessage(AuthResult result) {
  switch (result) {
  case AUTHRET_SUCCESS:
    return "AUTHRET_SUCCESS";
  case AUTHRET_KEYORSECRETEMPTY:
    return "AUTHRET_KEYORSECRETEMPTY";
  case AUTHRET_KEYORSECRETWRONG:
    return "AUTHRET_KEYORSECRETWRONG";
  case AUTHRET_ACCOUNTNOTSUPPORT:
    return "AUTHRET_ACCOUNTNOTSUPPORT";
  case AUTHRET_ACCOUNTNOTENABLESDK:
    return "AUTHRET_ACCOUNTNOTENABLESDK";
  case AUTHRET_UNKNOWN:
    return "AUTHRET_UNKNOWN";
  case AUTHRET_SERVICE_BUSY:
    return "AUTHRET_SERVICE_BUSY";
  case AUTHRET_NONE:
    return "AUTHRET_NONE";
  case AUTHRET_OVERTIME:
    return "AUTHRET_OVERTIME";
  case AUTHRET_NETWORKISSUE:
    return "AUTHRET_NETWORKISSUE";
  case AUTHRET_CLIENT_INCOMPATIBLE:
    return "AUTHRET_CLIENT_INCOMPATIBLE";
  case AUTHRET_JWTTOKENWRONG:
    return "AUTHRET_JWTTOKENWRONG";
  case AUTHRET_LIMIT_EXCEEDED_EXCEPTION:
    return "AUTHRET_LIMIT_EXCEEDED_EXCEPTION";
  }

  std::ostringstream output;
  output << "AuthResult " << static_cast<int>(result);
  return output.str();
}

std::string authFailureMessage(const std::string& action, AuthResult result) {
  std::ostringstream output;
  output << action << " failed with " << authResultMessage(result) << " (" << static_cast<int>(result) << ")";
  return output.str();
}

UINT64 parseMeetingNumber(const std::string& meetingNumber) {
  std::string digits;
  for (const char ch : meetingNumber) {
    if (ch >= '0' && ch <= '9') {
      digits.push_back(ch);
    }
  }

  if (digits.empty()) {
    throw std::runtime_error("meetingNumber must contain digits");
  }

  return static_cast<UINT64>(std::strtoull(digits.c_str(), nullptr, 10));
}

unsigned int parseUserId(const std::string& participantId) {
  if (participantId.empty()) {
    throw std::runtime_error("participantId is required");
  }
  return static_cast<unsigned int>(std::strtoul(participantId.c_str(), nullptr, 10));
}

std::string stringFromZchar(const zchar_t* value) {
  return value ? value : "";
}

std::string participantId(unsigned int userId) {
  std::ostringstream output;
  output << userId;
  return output.str();
}

Participant participantFromUser(unsigned int userId, IUserInfo* user, const std::string& fallbackStatus) {
  Participant participant;
  participant.id = participantId(userId);
  participant.displayName = user ? stringFromZchar(user->GetUserName()) : "";
  if (participant.displayName.empty()) {
    participant.displayName = "Zoom User " + participant.id;
  }
  participant.status = user && user->IsRaiseHand() ? "raised-hand" : fallbackStatus;
  if (fallbackStatus == "joined") {
    participant.audioState = user && !user->IsAudioMuted() ? "allowed-to-speak" : "muted";
  }
  return participant;
}

class AuthEvents final : public IAuthServiceEvent {
public:
  std::atomic<int> lastResult{AUTHRET_NONE};

  void onAuthenticationReturn(AuthResult ret) override {
    lastResult.store(static_cast<int>(ret));
  }

  void onLoginReturnWithReason(LOGINSTATUS, IAccountInfo*, LoginFailReason) override {}
  void onLogout() override {}
  void onZoomIdentityExpired() override {}
  void onZoomAuthIdentityExpired() override {}
};

class MeetingEvents final : public IMeetingServiceEvent {
public:
  MeetingStatus lastStatus = MEETING_STATUS_IDLE;
  int lastResult = 0;

  void onMeetingStatusChanged(MeetingStatus status, int result = 0) override {
    lastStatus = status;
    lastResult = result;
  }

  void onMeetingStatisticsWarningNotification(StatisticsWarningType) override {}
  void onMeetingParameterNotification(const MeetingParameter*) override {}
  void onSuspendParticipantsActivities() override {}
  void onAICompanionActiveChangeNotice(bool) override {}
  void onMeetingTopicChanged(const zchar_t*) override {}
  void onMeetingFullToWatchLiveStream(const zchar_t*) override {}
  void onUserNetworkStatusChanged(MeetingComponentType, ConnectionQuality, unsigned int, bool) override {}
};

class RecordingEvents final : public IMeetingRecordingCtrlEvent {
public:
  void onRecordingStatus(RecordingStatus) override {}
  void onCloudRecordingStatus(RecordingStatus) override {}
  void onRecordPrivilegeChanged(bool) override {}
  void onLocalRecordingPrivilegeRequestStatus(RequestLocalRecordingStatus) override {}
  void onRequestCloudRecordingResponse(RequestStartCloudRecordingStatus) override {}
  void onLocalRecordingPrivilegeRequested(IRequestLocalRecordingPrivilegeHandler*) override {}
  void onStartCloudRecordingRequested(IRequestStartCloudRecordingHandler*) override {}
  void onCloudRecordingStorageFull(time_t) override {}
  void onEnableAndStartSmartRecordingRequested(IRequestEnableAndStartSmartRecordingHandler*) override {}
  void onSmartRecordingEnableActionCallback(ISmartRecordingEnableActionHandler*) override {}
  void onTranscodingStatusChanged(TranscodingStatus, const zchar_t*) override {}
};

class ShareFrameRecorder {
public:
  ~ShareFrameRecorder() {
    stop();
  }

  void configure(const std::string& directory) {
    directory_ = directory;
    outputPath_ = directory + "/zoom-share-" + std::to_string(static_cast<long long>(std::time(nullptr))) + ".mp4";
  }

  void start() {
    active_ = true;
  }

  std::string stop() {
    active_ = false;
    if (inputFd_ >= 0) {
      close(inputFd_);
      inputFd_ = -1;
    }
    if (encoderPid_ > 0) {
      int status = 0;
      waitpid(encoderPid_, &status, 0);
      encoderPid_ = -1;
    }
    return outputPath_;
  }

  void writeFrame(YUVRawDataI420* data) {
    if (!active_ || !data) {
      return;
    }
    if (inputFd_ < 0 && !startEncoder(data->GetStreamWidth(), data->GetStreamHeight())) {
      active_ = false;
      return;
    }

    const char* buffer = data->GetBuffer();
    const size_t length = data->GetBufferLen();
    size_t offset = 0;
    while (offset < length) {
      const ssize_t written = write(inputFd_, buffer + offset, length - offset);
      if (written > 0) {
        offset += static_cast<size_t>(written);
        continue;
      }
      if (written < 0 && errno == EINTR) {
        continue;
      }
      close(inputFd_);
      inputFd_ = -1;
      active_ = false;
      return;
    }
  }

  const std::string& outputPath() const {
    return outputPath_;
  }

private:
  bool startEncoder(unsigned int width, unsigned int height) {
    if (directory_.empty() || width == 0 || height == 0) {
      return false;
    }
    int pipeFds[2];
    if (pipe(pipeFds) != 0) {
      return false;
    }
    encoderPid_ = fork();
    if (encoderPid_ < 0) {
      close(pipeFds[0]);
      close(pipeFds[1]);
      return false;
    }
    if (encoderPid_ == 0) {
      dup2(pipeFds[0], STDIN_FILENO);
      close(pipeFds[0]);
      close(pipeFds[1]);
      const std::string size = std::to_string(width) + "x" + std::to_string(height);
      execlp("ffmpeg", "ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", size.c_str(), "-r", "30", "-i", "-", "-an", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", outputPath_.c_str(), static_cast<char*>(nullptr));
      _exit(127);
    }
    close(pipeFds[0]);
    inputFd_ = pipeFds[1];
    return true;
  }

  std::string directory_;
  std::string outputPath_;
  int inputFd_ = -1;
  pid_t encoderPid_ = -1;
  bool active_ = false;
};

class ShareRendererDelegate final : public IZoomSDKRendererDelegate {
public:
  explicit ShareRendererDelegate(ShareFrameRecorder* recorder) : recorder_(recorder) {}

  void onRendererBeDestroyed() override {}
  void onRawDataFrameReceived(YUVRawDataI420* data) override {
    recorder_->writeFrame(data);
  }
  void onRawDataStatusChanged(RawDataStatus) override {}

private:
  ShareFrameRecorder* recorder_;
};

class ZoomSdkAdapter;

class ShareEvents final : public IMeetingShareCtrlEvent {
public:
  explicit ShareEvents(ZoomSdkAdapter* owner) : owner_(owner) {}

  void onSharingStatus(ZoomSDKSharingSourceInfo shareInfo) override;
  void onFailedToStartShare() override {}
  void onLockShareStatus(bool) override {}
  void onShareContentNotification(ZoomSDKSharingSourceInfo) override {}
  void onMultiShareSwitchToSingleShareNeedConfirm(IShareSwitchMultiToSingleConfirmHandler*) override {}
  void onShareSettingTypeChangedNotification(ShareSettingType) override {}
  void onSharedVideoEnded() override {}
  void onVideoFileSharePlayError(ZoomSDKVideoFileSharePlayError) override {}
  void onOptimizingShareForVideoClipStatusChanged(ZoomSDKSharingSourceInfo) override {}

private:
  ZoomSdkAdapter* owner_;
};

class ZoomSdkAdapter final : public ZoomAdapter {
public:
  ZoomSdkAdapter() : shareEvents_(this), shareRendererDelegate_(&shareRecorder_) {}

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

    ensureInitialized(request.sdkJwt);
    ensureMeetingService();

    StartParam params;
    params.userType = SDK_UT_WITHOUT_LOGIN;
    params.param.withoutloginStart.userZAK = request.zak.c_str();
    params.param.withoutloginStart.userName = request.displayName.empty() ? "StudyBox" : request.displayName.c_str();
    params.param.withoutloginStart.zoomuserType = ZoomUserType_APIUSER;
    params.param.withoutloginStart.meetingNumber = parseMeetingNumber(request.meetingNumber);
    params.param.withoutloginStart.isVideoOff = true;
    params.param.withoutloginStart.isAudioOff = false;
    params.param.withoutloginStart.isMyVoiceInMix = true;

    const SDKError error = meetingService_->Start(params);
    if (error != SDKERR_SUCCESS) {
      throw std::runtime_error(sdkErrorMessage("Start meeting", error));
    }

    MeetingState state = current;
    state.status = "starting";
    state.meetingId = request.meetingNumber;
    state.startedAt = nowIso8601();
    state.lastEvent = "Zoom SDK start meeting command accepted";
    return state;
  }

  MeetingState endMeeting(const MeetingState& current) override {
    ensureMeetingService();
    const SDKError error = meetingService_->Leave(END_MEETING);
    if (error != SDKERR_SUCCESS && error != SDKERR_WRONG_USAGE && error != SDKERR_NOT_IN_MEETING) {
      throw std::runtime_error(sdkErrorMessage("End meeting", error));
    }

    MeetingState state = current;
    state.status = "idle";
    state.meetingId.clear();
    state.startedAt.clear();
    state.lastEvent = "Zoom SDK end meeting command accepted";
    return state;
  }

  MeetingState admitParticipant(const std::string& participantId, const MeetingState& current) override {
    ensureMeetingService();
    auto* waitingRoom = meetingService_->GetMeetingWaitingRoomController();
    if (!waitingRoom) {
      throw std::runtime_error("Zoom waiting room controller is unavailable");
    }

    const SDKError error = waitingRoom->AdmitToMeeting(parseUserId(participantId));
    if (error != SDKERR_SUCCESS) {
      throw std::runtime_error(sdkErrorMessage("Admit participant", error));
    }

    MeetingState state = syncState(current);
    state.lastEvent = "Zoom SDK admit participant command accepted";
    return state;
  }

  MeetingState allowParticipantToSpeak(const std::string& participantId, const MeetingState& current) override {
    ensureMeetingService();
    auto* audio = meetingService_->GetMeetingAudioController();
    if (!audio) {
      throw std::runtime_error("Zoom audio controller is unavailable");
    }

    const SDKError error = audio->UnMuteAudio(parseUserId(participantId));
    if (error != SDKERR_SUCCESS) {
      throw std::runtime_error(sdkErrorMessage("Unmute participant", error));
    }

    MeetingState state = syncState(current);
    state.lastEvent = "Zoom SDK unmute participant command accepted";
    return state;
  }

  MeetingState muteParticipant(const std::string& participantId, const MeetingState& current) override {
    ensureMeetingService();
    auto* audio = meetingService_->GetMeetingAudioController();
    if (!audio) {
      throw std::runtime_error("Zoom audio controller is unavailable");
    }

    const SDKError error = audio->MuteAudio(parseUserId(participantId), false);
    if (error != SDKERR_SUCCESS) {
      throw std::runtime_error(sdkErrorMessage("Mute participant", error));
    }

    MeetingState state = syncState(current);
    state.lastEvent = "Zoom SDK mute participant command accepted";
    return state;
  }

  MeetingState makeParticipantHost(const std::string& participantId, const MeetingState& current) override {
    ensureMeetingService();
    auto* participants = meetingService_->GetMeetingParticipantsController();
    if (!participants) {
      throw std::runtime_error("Zoom participant controller is unavailable");
    }
    const SDKError error = participants->MakeHost(parseUserId(participantId));
    if (error != SDKERR_SUCCESS) {
      throw std::runtime_error(sdkErrorMessage("Make Zoom participant host", error));
    }
    MeetingState state = current;
    state.lastEvent = "Zoom participant made host: " + participantId;
    return state;
  }

  MeetingState allowScreenShare(const MeetingState& current) override {
    ensureMeetingService();
    auto* shareController = meetingService_->GetMeetingShareController();
    if (!shareController) {
      throw std::runtime_error("Zoom share controller is unavailable");
    }

    const SDKError error = shareController->SetMultiShareSettingOptions(Enable_All_Grab_Share);
    if (error != SDKERR_SUCCESS) {
      throw std::runtime_error(sdkErrorMessage("Enable participant screen sharing", error));
    }

    MeetingState state = current;
    state.lastEvent = "Zoom participant screen sharing enabled";
    return state;
  }

  MeetingState syncState(const MeetingState& current) override {
    if (!meetingService_) {
      return current;
    }

    MeetingState state = current;
    state.waitingRoom = waitingRoomParticipants();
    state.participants = meetingParticipants();
    state.raisedHands.clear();
    for (const Participant& participant : state.participants) {
      if (participant.status == "raised-hand") {
        state.raisedHands.push_back(participant);
      }
    }
    state.lastEvent = "Zoom SDK state synced";
    return state;
  }

  MeetingState startZoomRecording(const std::string& recordingDirectory, const MeetingState& current) override {
    if (recordingDirectory.empty()) {
      throw std::runtime_error("recordingDirectory is required");
    }
    ensureMeetingService();
    if (meetingService_->GetMeetingStatus() != MEETING_STATUS_INMEETING) {
      throw std::runtime_error("Zoom meeting is not active");
    }

    auto* recording = meetingService_->GetMeetingRecordingController();
    if (!recording) {
      throw std::runtime_error("Zoom recording controller is unavailable");
    }
    const SDKError permission = recording->CanStartRawRecording();
    if (permission != SDKERR_SUCCESS) {
      throw std::runtime_error(sdkErrorMessage("Start Zoom raw recording", permission));
    }
    const SDKError error = recording->StartRawRecording();
    if (error != SDKERR_SUCCESS) {
      throw std::runtime_error(sdkErrorMessage("Start Zoom local recording", error));
    }

    shareRecorder_.configure(recordingDirectory);
    shareRecorder_.start();
    zoomRecordingActive_ = true;
    if (shareActive_) {
      subscribeToShare(shareSourceId_);
    }
    MeetingState state = current;
    state.lastEvent = "Zoom local recording started: " + recordingDirectory;
    zoomRecordingDirectory_ = recordingDirectory;
    return state;
  }

  MeetingState stopZoomRecording(const MeetingState& current) override {
    ensureMeetingService();
    auto* recording = meetingService_->GetMeetingRecordingController();
    if (!recording) {
      throw std::runtime_error("Zoom recording controller is unavailable");
    }
    const SDKError error = recording->StopRawRecording();
    if (error != SDKERR_SUCCESS && error != SDKERR_WRONG_USAGE) {
      throw std::runtime_error(sdkErrorMessage("Stop Zoom local recording", error));
    }

    unsubscribeFromShare();
    const std::string outputPath = shareRecorder_.stop();
    zoomRecordingActive_ = false;
    MeetingState state = current;
    state.lastEvent = "Zoom local recording stopped: " + outputPath;
    return state;
  }

  void handleShareStatus(const ZoomSDKSharingSourceInfo& shareInfo) {
    if (shareInfo.status == Sharing_Other_Share_Begin || shareInfo.status == Sharing_View_Other_Sharing || shareInfo.status == Sharing_Resume) {
      shareActive_ = true;
      shareSourceId_ = shareInfo.shareSourceID;
      if (zoomRecordingActive_) {
        subscribeToShare(shareSourceId_);
      }
    } else if (shareInfo.status == Sharing_Other_Share_End || shareInfo.status == Sharing_Self_Send_End || shareInfo.status == Sharing_Pause) {
      shareActive_ = false;
      unsubscribeFromShare();
    }
  }

private:
  bool initialized_ = false;
  IAuthService* authService_ = nullptr;
  IMeetingService* meetingService_ = nullptr;
  ISettingService* settingService_ = nullptr;
  AuthEvents authEvents_;
  MeetingEvents meetingEvents_;
  RecordingEvents recordingEvents_;
  std::string zoomRecordingDirectory_;
  ShareEvents shareEvents_;
  ShareFrameRecorder shareRecorder_;
  ShareRendererDelegate shareRendererDelegate_;
  IZoomSDKRenderer* shareRenderer_ = nullptr;
  unsigned int shareSourceId_ = 0;
  bool shareActive_ = false;
  bool zoomRecordingActive_ = false;

  void subscribeToShare(unsigned int sourceId) {
    if (!sourceId) {
      return;
    }
    if (!shareRenderer_) {
      const SDKError error = createRenderer(&shareRenderer_, &shareRendererDelegate_);
      if (error != SDKERR_SUCCESS) {
        return;
      }
      shareRenderer_->setRawDataResolution(ZoomSDKResolution_720P);
    }
    shareRenderer_->subscribe(sourceId, RAW_DATA_TYPE_SHARE);
  }

  void unsubscribeFromShare() {
    if (shareRenderer_) {
      shareRenderer_->unSubscribe();
      destroyRenderer(shareRenderer_);
      shareRenderer_ = nullptr;
    }
  }

  std::vector<Participant> waitingRoomParticipants() {
    std::vector<Participant> participants;
    auto* waitingRoom = meetingService_->GetMeetingWaitingRoomController();
    if (!waitingRoom) {
      return participants;
    }

    IList<unsigned int>* waitingList = waitingRoom->GetWaitingRoomLst();
    if (!waitingList) {
      return participants;
    }

    for (int index = 0; index < waitingList->GetCount(); ++index) {
      const unsigned int userId = waitingList->GetItem(index);
      participants.push_back(participantFromUser(userId, waitingRoom->GetWaitingRoomUserInfoByID(userId), "waiting"));
    }

    return participants;
  }

  std::vector<Participant> meetingParticipants() {
    std::vector<Participant> participants;
    auto* participantController = meetingService_->GetMeetingParticipantsController();
    if (!participantController) {
      return participants;
    }

    IList<unsigned int>* participantList = participantController->GetParticipantsList();
    if (!participantList) {
      return participants;
    }

    for (int index = 0; index < participantList->GetCount(); ++index) {
      const unsigned int userId = participantList->GetItem(index);
      IUserInfo* user = participantController->GetUserByUserID(userId);
      if (user && user->IsMySelf()) {
        continue;
      }
      participants.push_back(participantFromUser(userId, user, "joined"));
    }

    return participants;
  }

  void ensureInitialized(const std::string& sdkJwt) {
    if (!initialized_) {
      InitParam initParam;
      initParam.strWebDomain = "https://zoom.us";
      initParam.strSupportUrl = "https://zoom.us";
      initParam.emLanguageID = LANGUAGE_English;
      initParam.enableLogByDefault = true;
      initParam.enableGenerateDump = true;

      const SDKError initError = InitSDK(initParam);
      if (initError != SDKERR_SUCCESS && initError != SDKERR_OTHER_SDK_INSTANCE_RUNNING) {
        throw std::runtime_error(sdkErrorMessage("InitSDK", initError));
      }

      ensureMeetingService();
      const SDKError settingCreateError = CreateSettingService(&settingService_);
      if (settingCreateError != SDKERR_SUCCESS || !settingService_) {
        throw std::runtime_error(sdkErrorMessage("CreateSettingService", settingCreateError));
      }

      const SDKError authCreateError = CreateAuthService(&authService_);
      if (authCreateError != SDKERR_SUCCESS || !authService_) {
        throw std::runtime_error(sdkErrorMessage("CreateAuthService", authCreateError));
      }
      const SDKError authEventError = authService_->SetEvent(&authEvents_);
      if (authEventError != SDKERR_SUCCESS) {
        throw std::runtime_error(sdkErrorMessage("Auth SetEvent", authEventError));
      }
      initialized_ = true;
    }

    authEvents_.lastResult.store(AUTHRET_NONE);
    AuthContext authContext;
    authContext.jwt_token = sdkJwt.c_str();
    const SDKError authError = authService_->SDKAuth(authContext);
    if (authError != SDKERR_SUCCESS) {
      throw std::runtime_error(sdkErrorMessage("SDKAuth", authError));
    }

    waitForAuthentication();
  }

  void waitForAuthentication() {
    constexpr int maxAttempts = 100;
    constexpr auto delay = std::chrono::milliseconds(100);

    for (int attempt = 0; attempt < maxAttempts; ++attempt) {
      const AuthResult serviceResult = authService_->GetAuthResult();
      const AuthResult callbackResult = static_cast<AuthResult>(authEvents_.lastResult.load());
      const AuthResult result = serviceResult != AUTHRET_NONE ? serviceResult : callbackResult;

      if (result == AUTHRET_SUCCESS) {
        return;
      }

      if (result != AUTHRET_NONE) {
        throw std::runtime_error(authFailureMessage("SDKAuth", result));
      }

      while (g_main_context_iteration(nullptr, false)) {
      }
      std::this_thread::sleep_for(delay);
    }

    const AuthResult serviceResult = authService_->GetAuthResult();
    const AuthResult callbackResult = static_cast<AuthResult>(authEvents_.lastResult.load());
    const AuthResult result = serviceResult != AUTHRET_NONE ? serviceResult : callbackResult;
    throw std::runtime_error(authFailureMessage("SDKAuth timed out", result));
  }

  void ensureMeetingService() {
    if (meetingService_) {
      return;
    }

    const SDKError createError = CreateMeetingService(&meetingService_);
    if (createError != SDKERR_SUCCESS || !meetingService_) {
      throw std::runtime_error(sdkErrorMessage("CreateMeetingService", createError));
    }

    const SDKError eventError = meetingService_->SetEvent(&meetingEvents_);
    if (eventError != SDKERR_SUCCESS) {
      throw std::runtime_error(sdkErrorMessage("Meeting SetEvent", eventError));
    }
    auto* shareController = meetingService_->GetMeetingShareController();
    if (shareController) {
      const SDKError shareEventError = shareController->SetEvent(&shareEvents_);
      if (shareEventError != SDKERR_SUCCESS) {
        throw std::runtime_error(sdkErrorMessage("Meeting share SetEvent", shareEventError));
      }
    }
  }

};

void ShareEvents::onSharingStatus(ZoomSDKSharingSourceInfo shareInfo) {
  owner_->handleShareStatus(shareInfo);
}

} // namespace

ZoomAdapter& zoomAdapter() {
  static ZoomSdkAdapter adapter;
  return adapter;
}
