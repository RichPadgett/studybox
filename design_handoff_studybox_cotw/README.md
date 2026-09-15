# Handoff: Church of the Word StudyBox Rebrand

## Overview
Visual/UX branding pass for the StudyBox Zoom appliance product, restyling it to feel like a purpose-built Church of the Word (COTW) product rather than a generic SaaS admin tool. No information architecture changes — same pages, nav items, and functionality, new visual system. Two surfaces: the internal Admin control panel, and the public Weekly Bible Study join page (desktop + mobile).

## About the Design Files
The bundled HTML file (`studybox-redesign.dc.html`) is a **design reference** — a static, non-production prototype built to show intended look, hierarchy, and interaction states (nav switching, active tabs). It is **not** meant to be shipped as-is. The task is to **recreate this design inside the existing StudyBox React codebase**, using its current component structure, routing, and state (Zoom SDK status, recordings list, audio device data, etc.) — only the visual layer changes.

## Fidelity
**High-fidelity.** Colors, type scale, spacing, card treatments, and copy are final. Implement pixel-close using the values below, adapted to the existing component library.

## Brand relationship
Church of the Word is the primary brand; StudyBox is the appliance/product it operates through.
- Public join page: brand-forward, emotional — leads with COTW identity.
- Admin dashboard: operational, brand-restrained — professional control surface "built for Church of the Word."

## Design Tokens

### Colors
```
--cotw-black:    #121311   sidebar / dark surfaces
--cotw-charcoal: #17180F   primary text, primary buttons
--cotw-gold:     #D6A600   brand accent, CTAs, active-nav border, eyebrow text
--cotw-yellow:   #F2E900   sparing accent (hero eyebrow only)
--cotw-paper:    #F5F3EC   main content background (replaces old cool green-gray)
--cotw-page-bg:  #EDEAE0   outer page background
--white:         #FFFFFF   cards

Semantic (operational — never replace with brand gold):
green (ready/connected):  #2E9E5B  / tint bg #E7F5EC / text #217A46
red   (recording/error):  #D64545  / tint bg #FBEAEA
amber (attention/waiting): #E0A22D / tint bg #FBF1DF
gray  (inactive):         #9AA098 / tint bg #EEEEEC
```
Borders on cards: `1px solid rgba(23,24,15,0.08)`. Muted text: `rgba(23,24,15,0.45–0.6)`.

### Typography
Font: Inter (400/500/600/700/800), fallback `-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif`.
- Eyebrow label: 10–12px, weight 700, uppercase, letter-spacing 0.14–0.18em, color gold (`#B8860B` on light bg, `#F2E900` on dark hero).
- Page H1: 28–30px admin / 34–38px public hero, weight 800, letter-spacing -0.01em, color `#17180F` (or white on dark hero).
- Card label: 12.5px weight 600, muted.
- Card value: 19–22px weight 800.
- Body/caption: 12.5–14.5px, muted.

### Radius & shadow
Cards: `border-radius:12px`. Buttons: `10px`. Pills/status badges: `20px` (full). Public hero card: `20px`, `box-shadow:0 20px 50px rgba(20,20,15,0.25)`.

## Screens / Views

### 1. Admin — Sidebar (persistent, near-black `#121311`)
- Brand lockup top-left: 34×34px COTW artwork (rounded 7px) + stacked wordmark "STUDYBOX" (white, 15px, weight 800) over "CHURCH OF THE WORD" (gold `#D6A600`, 9.5px, uppercase, letter-spacing 0.14em). Thin gold gradient rule below (`linear-gradient(90deg, rgba(214,166,0,.6), transparent)`).
- Primary nav (always visible): **Dashboard, Meeting, Podcast** — the three pages used day-to-day.
- Collapsible **"System"** group below (label 10.5px uppercase, muted, chevron toggle): **Audio, Recordings, Backup, Settings, Diagnostics, Logs, Network**. Collapsed by default; auto-expands when the active page is one of these.
- Nav item active state: background `#23241F`, left border 3px gold, white text. Inactive: `rgba(255,255,255,0.55)`, no border.
- Sidebar footer: small hardware badge — generic chip icon (do **not** use the official Raspberry Pi trademark logo unless you have licensed rights; a neutral square+dot glyph is used in the mock) + "Raspberry Pi 5 · DJI Mic", then "StudyBox control surface / built for Church of the Word" in muted caps.

### 2. Admin — Header (repeats on every admin page)
- Left: gold eyebrow "CHURCH OF THE WORD" → page title (dynamic per nav item, e.g. "StudyBox Dashboard", "Meeting", "Audio"…) → subtitle "Ready for the next scheduled study".
- Right cluster: "DJI Mic ready" (green dot + text), viewer count pill (👁 1), passcode field (masked, readonly) + "Unlock" button (charcoal bg, white text), status pill "ready" (green tint).

### 3. Admin — Dashboard page
- 4-card stat row: Meeting (Idle), Zoom Waiting (0), Podcast (Idle), Next Meeting (Saturday · 11:00 AM, gold top border accent).
- Action row: "Start Zoom Meeting" (primary, charcoal bg/white text), "Start Recording" (charcoal outline), "Pause Recording" / "Finish Recording" (disabled gray until active — these should flip to amber/red semantic treatment when recording is live).
- 2-col cards: Moderation, Remote Speaker.
- 2-col cards: Participants (empty state "No participants"), StudyBox Lobby (empty state "No web join requests").
- Right rail (persists across all admin pages): **Device OLED preview** and **LEDs** panel.

### 4. Admin — OLED preview (right rail, all pages)
Styled to read as a mirror of the physical device screen, not a UI widget:
- Card header "Device OLED" + live pulse dot ("Live", green, glow `box-shadow:0 0 5px #2E9E5B`).
- Inner screen: near-black bezel (`#0B0C0A`) around true-black screen (`#040503`), subtle scanline overlay (`repeating-linear-gradient` 1px lines at 3.5% white opacity), monospace font, text glow via `text-shadow` (gold "StudyBox" title, green "READY" status, green "Next Meeting / Saturday 11:00").
- Caption under screen: "mirrors the physical StudyBox display".
- Two buttons below: PAGE / ACTION (charcoal, white text) mapping to the device's physical buttons.
- **Do not restyle this to match the web palette** — it represents real hardware and must stay legible black/green.

### 5. Admin — LEDs panel (right rail, all pages)
Three status rows with colored dot + label: System (green), Zoom (gray when off / green when connected), REC (gray when idle / red when recording). Small hardware caption at bottom: "Raspberry Pi 5 · DJI Mic Receiver". LED colors are semantic only — never gold.

### 6. Admin — Meeting page
Moderation + Remote Speaker cards, "Start Zoom Meeting" button, Participants + StudyBox Lobby cards, Zoom Waiting Room + Raised Hands cards (empty states styled as light-gray inset boxes `#F7F6F1`).

### 7. Admin — Podcast page
Large status card: "IDLE" label left, monospace timer "00:00:00" right (34px). Start/Pause/Finish recording buttons below (same treatment as dashboard).

### 8. Admin — Audio page
- Device Routing card: 3-col grid of styled select-like fields (Teacher Mic, Audience Mic, Room Speaker) — bordered box with chevron, not native `<select>` styling.
- Input card: Gain (70%), Monitor (Disabled), Audio Service text — 3-col.
- Level card: horizontal bar, green fill (`#2E9E5B`) at current %.
- Hardware Routes card: list rows on `#F7F6F1` background, each with device name, route id + connection state (green "connected" / gray "disconnected"), and level % where applicable.

### 9. Admin — Recordings page
List card of recording entries, each row: title + duration/size/availability caption, two action buttons ("Audio" download — active; "Zoom pending" — disabled gray until Zoom video export completes).

### 10. Admin — Backup page
4-stat row (Target, Pending, Uploaded, Failed). "Retry Sync" button (disabled/gray when nothing to retry). Session Bundles list card, each entry showing filename, sync target, and timestamp/log-count caption.

### 11. Admin — Settings page
Schedule card (Day/Time/Timezone, 3-col). Moderation card (Mode/Remote Speaker Podcast/Approval, 3-col). Zoom card (Meeting Number/Passcode/Join URL row, then Display Name/Redirect URI row). Zoom Runtime card (Mode/SDK Arch, 2-col).

### 12. Admin — Diagnostics page
3 rows of 4-col stat cards: system health (CPU/Storage/WiFi/Temperature), Zoom runtime (Zoom Mode/SDK Arch/Webhook/Runner), hardware I/O (OLED/Page Button/Action Ring/REC LED). Audio Hardware list card below.

### 13. Admin — Logs page
List card of log entries, each with title, "Success" pill badge (green tint), and metadata caption (time · actor · event key).

### 14. Admin — Network page
4-col stat cards: WiFi, Tunnel, Access, API — status value colored semantically (green for healthy/online, gray/neutral for informational).

### 15. Public — Weekly Bible Study join page (desktop)
- Dark hero card, full width up to 720px, gradient `linear-gradient(135deg, #14140F 0%, #3B3410 55%, #7A5A08 100%)`, rounded 20px.
- Contents (centered): 120×120px COTW square artwork (rounded 16px, drop shadow) → gold/yellow eyebrow "CHURCH OF THE WORD" → white H1 "Weekly Bible Study" (38px/800) → "Room Ready" status pill (green-tinted, translucent on dark) → "Saturday · 11:00 AM" → primary CTA "Join Bible Study" (gold `#D6A600` bg, dark text, bold, shadow) → helper copy: "Join the weekly Bible study. You'll enter the waiting room until the StudyBox host admits you."
- Secondary status row below hero (small, muted, centered): "Room ready · 0 online · Podcast idle · America/Chicago" — technical info stays visually subordinate to the CTA.
- Podcast cross-promo card (white, bordered): eyebrow "Recent Teachings" → "Missed a study?" → "Listen to previous Church of the Word teachings." → outline gold button "Listen to the Podcast".
- Footer: small muted line "StudyBox · powered for Church of the Word".

### 16. Public — Weekly Bible Study join page (mobile)
Same content, stacked, phone-frame width ~390px:
- Artwork shrinks to 76×76px.
- CTA button spans full width.
- Meeting time and Room Ready status remain above the fold, directly under the title.
- Technical status row (online count, podcast state, timezone) moves below the CTA/helper text.
- Podcast cross-promo card stacks full-width beneath.

## Interactions & Behavior (as prototyped)
- Sidebar nav: click switches active admin page; active item gets gold left-border + lighter bg. "System" group header toggles expand/collapse; auto-expands if a System-group page is already active.
- Top switcher bar (prototype-only, not part of final product): lets a reviewer flip between Admin / Public Desktop / Public Mobile — **do not implement this in the real app**, it exists only to present the three concepts in one file.
- No other interactivity was prototyped (buttons are visual states, not wired) — real states (recording in progress, participants present, raised hands, etc.) should drive the semantic colors and disabled/enabled button states described above.

## State Management
Reuse existing StudyBox app state — this pass changes presentation only:
- Zoom meeting/recording status → drives Meeting/Podcast card values and button enabled/disabled + semantic color.
- Audio device connection state → drives Hardware Routes connected/disconnected styling.
- Recordings/backup lists → drive list rendering (empty-state box `#F7F6F1` with muted placeholder text when empty).
- Active nav / active "System" group expanded → local UI state only.

## Assets
- `assets/cotw-artwork.png` — Church of the Word square cover artwork, supplied by the user. Use as-is; do not recreate, reinterpret, or AI-regenerate it.
- No other custom assets. Icons in the mock are emoji/unicode placeholders (👥 ▶ ⏸ ◻ 🎧 👁 ↗ ⌄ ↻) — swap for the codebase's existing icon set at the same visual weight.
- Raspberry Pi badge uses a generic drawn glyph, not the official trademarked Raspberry Pi logo — source the real logo from raspberrypi.com's brand assets if the team has rights to use it, otherwise keep the generic glyph.

## Files
- `studybox-redesign.dc.html` — full prototype (Admin Dashboard + all 9 sub-pages, Public Join desktop, Public Join mobile).
- `assets/cotw-artwork.png` — brand artwork used in the sidebar lockup and public hero.
