#include "zoom_adapter.h"

#include "auth_service_interface.h"
#include "meeting_service_components/meeting_audio_interface.h"
#include "meeting_service_components/meeting_participants_ctrl_interface.h"
#include "meeting_service_components/meeting_waiting_room_interface.h"
#include "meeting_service_interface.h"
#include "zoom_sdk.h"

#include <cstdlib>
#include <sstream>
#include <stdexcept>

namespace {

using namespace ZOOMSDK;

std::string sdkErrorMessage(const std::string& action, SDKError error) {
  std::ostringstream output;
  output << action << " failed with SDKError " << static_cast<int>(error);
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

class AuthEvents final : public IAuthServiceEvent {
public:
  AuthResult lastResult = AUTHRET_NONE;

  void onAuthenticationReturn(AuthResult ret) override {
    lastResult = ret;
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

class ZoomSdkAdapter final : public ZoomAdapter {
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

    MeetingState state = current;
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

    MeetingState state = current;
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

    MeetingState state = current;
    state.lastEvent = "Zoom SDK mute participant command accepted";
    return state;
  }

private:
  bool initialized_ = false;
  IAuthService* authService_ = nullptr;
  IMeetingService* meetingService_ = nullptr;
  AuthEvents authEvents_;
  MeetingEvents meetingEvents_;

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

      const SDKError authCreateError = CreateAuthService(&authService_);
      if (authCreateError != SDKERR_SUCCESS || !authService_) {
        throw std::runtime_error(sdkErrorMessage("CreateAuthService", authCreateError));
      }
      authService_->SetEvent(&authEvents_);
      initialized_ = true;
    }

    AuthContext authContext;
    authContext.jwt_token = sdkJwt.c_str();
    const SDKError authError = authService_->SDKAuth(authContext);
    if (authError != SDKERR_SUCCESS) {
      throw std::runtime_error(sdkErrorMessage("SDKAuth", authError));
    }
  }

  void ensureMeetingService() {
    if (meetingService_) {
      return;
    }

    const SDKError createError = CreateMeetingService(&meetingService_);
    if (createError != SDKERR_SUCCESS || !meetingService_) {
      throw std::runtime_error(sdkErrorMessage("CreateMeetingService", createError));
    }

    meetingService_->SetEvent(&meetingEvents_);
  }
};

} // namespace

ZoomAdapter& zoomAdapter() {
  static ZoomSdkAdapter adapter;
  return adapter;
}
