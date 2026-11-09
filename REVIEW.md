# StudyBox Full Project Review

_Generated: 2026-09-25_

## Executive Summary

The project has solid architecture but contains multiple critical issues that will cause unreliable startups, recording failures, data loss, and crashes. Below are findings organized by priority.

---

## CRITICAL — Fix Before Any Release

### 1. Server Listens Before Initialization Completes
**File:** `packages/api/src/index.ts:722-724`

`app.listen()` is called before `appliance.initialize()`, `zoomCloudRecordings.load()`, and store loading complete. Requests arriving in the 2–5 second startup window get stale/incomplete snapshot data.

**Fix:** Move `app.listen()` to after all `await` calls complete.

---

### 2. Zoom Recording Events Delegate Never Registered (C++)
**File:** `native/zoom-runner/src/zoom_sdk_adapter.cpp:587`

`recordingEvents_` is instantiated but `SetEvent()` is never called for it. Compare: `shareEvents_` (line 749) and `meetingEvents_` (line 743) are correctly registered. Recording status callbacks never fire — the app cannot monitor recording lifecycle.

**Fix:** Add `SetEvent()` call for recording controller in `ensureMeetingService()`.

---

### 3. Null Pointer Dereference After `createRenderer()` (C++)
**File:** `native/zoom-runner/src/zoom_sdk_adapter.cpp:606-608`

After `createRenderer()` returns `SDKERR_SUCCESS`, code dereferences `shareRenderer_` at line 606 without checking if it was actually populated. If SDK returns success but leaves pointer null, crash is guaranteed.

**Fix:** Add `if (!shareRenderer_) return;` after the create call.

---

### 4. WAV Merge Has No Error Handling — Recording Lost Silently
**File:** `services/podcast/src/index.ts:386-388`

`mergeWavSegments()` is called with no try-catch. If any segment is corrupt or disk is full, it throws and the manifest is still saved — recording is marked complete but the audio file is corrupt or missing. All recorded audio is lost.

**Fix:** Wrap in try-catch; on failure, mark the recording as failed and preserve segment files for manual recovery.

---

### 5. Manifest JSON Not Written Atomically
**File:** `services/podcast/src/index.ts:809-811`

`writeFile()` is not atomic. A crash or power loss mid-write leaves a partially-written `manifest.json` that the JSON parser cannot read on next startup. All recording metadata is lost.

**Fix:** Write to a temp file, then `rename()` to the final path (atomic on Linux).

---

### 6. No Graceful Shutdown Handler
**File:** `packages/api/src/index.ts` (no `SIGTERM`/`SIGINT` handlers anywhere)

When the systemd service restarts or the Pi is rebooted, active recordings and manifest writes are abandoned mid-operation. Segment files are orphaned.

**Fix:** Register `process.on('SIGTERM')` to call `stopRecording()` and flush all writes before exiting.

---

### 7. `audioHealthTimer` and `audioWaitTimer` Never Cleaned Up
**File:** `services/podcast/src/index.ts:239-244, 431-445`

Both timers are started but never cleared if a session ends abnormally or if the service is reinitialized. They accumulate across sessions, continue polling, and execute on stale state.

**Fix:** Add a `destroy()` method that clears all timers, terminates child processes, and removes listeners.

---

### 8. `JSON.parse()` Without try-catch on API Response and Recovery Files
**Files:**
- `services/transcripts/src/index.ts:484` — OpenAI response parsing
- `services/transcripts/src/index.ts:174` — recovery file parsing

Malformed JSON from the API or a corrupted chunk file will crash the processing pipeline entirely with no recovery.

**Fix:** Wrap both in try-catch with appropriate error logging.

---

## HIGH — Fix for Reliable Operation

### 9. Recording Start/Stop Race Conditions
**File:** `packages/api/src/appliance.ts:502-566`

`startRecording()` calls `podcast.startRecording()` then `meeting.startZoomRecording()` sequentially. If podcast state changes between the two calls, Zoom recording starts orphaned with no matching audio file. Same issue in `stopRecording()` — stale `activeRecording` snapshot is captured before async stops complete.

---

### 10. Backup Queue Corrupted on Write Failure
**File:** `services/sync/src/index.ts:76-96`

State is marked "zipping" and saved before `writeBundleFiles()` is called. If the file write fails (disk full, permissions), the queue is in a corrupt state — it believes a bundle exists but no files were written. No retry or cleanup mechanism.

---

### 11. `endMeeting()` Does Not Check `stopRecording()` Result
**File:** `packages/api/src/appliance.ts:386-424`

If `stopRecording()` throws (merge error, manifest corruption), the meeting ends anyway. Recording is marked complete but the audio file is missing or corrupt. Users have no indication.

---

### 12. `startMeeting()` Has No Concurrent-Call Protection
**File:** `packages/api/src/appliance.ts:378-384`

`endMeeting()` has `zoomEndInFlight` to prevent duplicate calls. `startMeeting()` has no equivalent. Rapid double-tap on "Start Meeting" can launch two meeting start operations simultaneously.

---

### 13. Participant Null Dereference in `meetingParticipants()` (C++)
**File:** `native/zoom-runner/src/zoom_sdk_adapter.cpp:653-657`

`GetUserByUserID()` can return null. The code checks `user->IsMySelf()` only to skip, but then passes `user` (possibly null) to `participantFromUser()` on line 657 with no null guard.

---

### 14. Unregistered Recording Permission Handlers (C++)
**File:** `native/zoom-runner/src/zoom_sdk_adapter.cpp:173, 176-177`

`onLocalRecordingPrivilegeRequested()` and `onStartCloudRecordingRequested()` receive handler pointers but do nothing with them. Permission requests from Zoom are silently ignored — recording never starts when host approval is required.

---

### 15. Express Version Mismatch (v4 vs v5)
**Files:** `packages/api/package.json:23`, `services/cloud-library/package.json:10`

The API uses Express 4, cloud-library uses Express 5. These have breaking changes in middleware and error handling. This will cause runtime failures.

---

### 16. Page Button Returns Stale Snapshot (Fire-and-Forget)
**File:** `packages/api/src/index.ts:242-250`

```typescript
void appliance.pressPage().catch(...)
response.json(appliance.snapshot()); // returns BEFORE pressPage completes
```

The OLED page hasn't changed yet when the response goes back. UI shows wrong state.

**Fix:** Await `pressPage()` before returning the snapshot.

---

### 17. Admin Session File Has No `chmod 0o600`
**File:** `packages/api/src/adminAuth.ts:154-160`

OAuth tokens get `chmod 0o600` (correctly). Admin sessions do not. The session file is world-readable on the Pi.

---

## MEDIUM — Polish and Reliability

### 18. `pendingAction` Is Global — All Buttons Disable on Any Click
**File:** `packages/web/src/App.tsx:87-96`

One global `pendingAction` disables every button when any action is in-flight. When it clears (before the snapshot updates), buttons become re-clickable too early, allowing double-actions.

### 19. No Timeout on Zoom Recording File Search
**File:** `packages/api/src/appliance.ts:568-584`

20 attempts × 1 second = 20-second blocking loop during `stopRecording()`. If the directory is unavailable, users will think the app is frozen.

### 20. Segment Directories Not Cleaned Up on Failed Merges
**File:** `services/podcast/src/index.ts:410-427`

Cleanup runs after manifest save. Any exception between the two leaves `.segments-{id}` directories permanently on disk. Over time this will fill the SD card.

### 21. Concurrent Backup Syncs Not Serialized
**File:** `packages/api/src/appliance.ts:668-712`

Manual sync and the auto-retry loop can both call `syncPending()` simultaneously, potentially marking bundles as uploaded twice or corrupting queue state.

### 22. `backup.onStateChange` Callback Never Unregistered
**File:** `packages/api/src/appliance.ts:125-129`

Registered in constructor with no way to remove it. If the appliance is ever re-created, the old callback fires on a destroyed instance.

### 23. WiFi Password Passed as CLI Argument
**File:** `packages/api/src/index.ts:693-701`

Password is visible in the process list to any local user (`ps aux`). Pass via stdin instead.

### 24. Default Admin PIN is `364364` (Hardcoded Fallback)
**File:** `packages/api/src/adminAuth.ts:97`

The `.env.example` and the code default to the same weak PIN. No rate limiting or lockout exists on the login endpoint.

### 25. CORS Allows All Origins
**File:** `packages/api/src/index.ts:44`

`app.use(cors())` with no origin restriction. Any website can make authenticated requests to the API.

### 26. All JSON Stores Use Non-Atomic `writeFile()`
All JSON store files use `writeFile()` without atomic writes. A crash mid-write corrupts the store permanently.

---

## LOW — Cleanup

| Issue | File | Notes |
|-------|------|-------|
| Backup button has CSS class `disabled` always applied | `App.tsx:1054` | Visual mismatch — button is functionally enabled but looks disabled |
| WiFi password not cleared from input after connect | `App.tsx:1289-1292` | Password stays visible in form after successful connection |
| Admin PIN entry has no UI-level rate limit | `App.tsx:1324` | Backend handles it, but UX is poor |
| `audioProbeLastResult` written during async, read from HTTP | `podcast/src/index.ts:526` | Node is single-threaded so no crash, but stale reads possible |
| `findWavDataChunk()` called twice per buffer in merge | `podcast/src/index.ts:825` | Redundant work; cache the result |
| No startup validation that required env vars are set | Multiple | Zoom, webhook secret, admin PIN should fail fast at boot |
| `data/admin-sessions.json` stored in plaintext | `adminAuth.ts` | Apply `chmod 0o600` to match OAuth token handling |
| Custom `.env` parser instead of `dotenv` | `zoomConfig.ts:56-71` | Fragile; won't handle quoted values or inline comments |
| S3 archive configure() silently swallows errors | `podcast/src/s3Archive.ts:54-70` | No diagnostic info when S3 is misconfigured |
| `expectedProcessExits` set never pruned between sessions | `podcast/src/index.ts:204` | Process references accumulate; memory leak |

---

## Recommended Fix Order

1. **`app.listen()` ordering** — server must not accept requests until fully initialized
2. **Register Zoom recording delegate** (`SetEvent()`) — nothing records without this
3. **`createRenderer()` null check** — crash on every share subscription otherwise
4. **WAV merge error handling + atomic manifest write** — data loss on any hiccup
5. **`SIGTERM` handler** — data loss on every deploy/reboot
6. **Timer cleanup (`destroy()` method)** — resource leaks accumulate across sessions
7. **`startMeeting()` concurrency guard** — matches existing pattern in `endMeeting()`
8. **Page button `await`** — stale UI state on every OLED page change
9. **Express version alignment** — cloud-library must match API (pick one version)
10. **Admin session `chmod 0o600`** — security parity with OAuth token handling
