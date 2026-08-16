cmake_minimum_required(VERSION 3.6)
project(studybox_zoom_runner LANGUAGES CXX)

option(STUDYBOX_ENABLE_ZOOM_SDK "Build with the Zoom Meeting SDK adapter" OFF)
set(ZOOM_SDK_ROOT "" CACHE PATH "Path to the unpacked Zoom Meeting SDK for Linux ARM64")

set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(STUDYBOX_ZOOM_RUNNER_SOURCES
  src/main.cpp
  src/protocol.cpp
)

if(STUDYBOX_ENABLE_ZOOM_SDK)
  list(APPEND STUDYBOX_ZOOM_RUNNER_SOURCES src/zoom_sdk_adapter.cpp)
else()
  list(APPEND STUDYBOX_ZOOM_RUNNER_SOURCES src/stub_zoom_adapter.cpp)
endif()

add_executable(studybox-zoom-runner ${STUDYBOX_ZOOM_RUNNER_SOURCES})

target_include_directories(studybox-zoom-runner PRIVATE src)

if(STUDYBOX_ENABLE_ZOOM_SDK)
  if(NOT ZOOM_SDK_ROOT)
    message(FATAL_ERROR "Set -DZOOM_SDK_ROOT=/path/to/zoom-meeting-sdk-linux-arm64 when enabling the SDK adapter")
  endif()

  target_compile_definitions(studybox-zoom-runner PRIVATE STUDYBOX_ENABLE_ZOOM_SDK=1)
  target_include_directories(studybox-zoom-runner PRIVATE "${ZOOM_SDK_ROOT}/h")
  link_directories("${ZOOM_SDK_ROOT}/lib")
  target_link_libraries(studybox-zoom-runner PRIVATE "${ZOOM_SDK_ROOT}/libmeetingsdk.so" pthread dl)
  message(STATUS "Zoom SDK adapter is enabled; SDK root: ${ZOOM_SDK_ROOT}")
endif()
