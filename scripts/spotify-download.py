#!/usr/bin/env python3
"""
Downloads all podcast episodes by connecting to your real Chrome browser.
No bot detection — uses your actual logged-in session.

BEFORE RUNNING:
  1. Close all Chrome windows
  2. Launch Chrome with debugging:
       /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
         --remote-debugging-port=9222 \
         --user-data-dir=/tmp/chrome-debug
  3. Log into creators.spotify.com and go to the archive page
  4. Run this script and press Enter when ready

Run:
    python3 scripts/spotify-download.py
"""

import json
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path

import pandas as pd
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

CSV_PATH   = Path("/Users/richardpadgett/Developer/Personal/Python/church_of_the_word_spotify_episodes_enriched.csv")
DONE_FILE  = Path(__file__).parent / ".spotify-done.json"
OUTPUT_DIR = Path(__file__).parent.parent / "data" / "episodes"
PI_DEST    = "studybox@studybox.local:/home/studybox/episodes/"
SSH_KEY    = str(Path.home() / ".ssh" / "id_ubuntu")
SHOW_URL   = "https://creators.spotify.com/pod/show/0R8U9lsiYV4RTKODWZbRo6/podcast/archive"

CLOUDFRONT = re.compile(r"https://[a-z0-9]+\.cloudfront\.net/staging/\d{4}-\d{1,2}-\d{1,2}/[^\s\"'>\?]+")
DATE_URL   = re.compile(r"/staging/(\d{4})-(\d{1,2})-(\d{1,2})/")

DATE_FORMATS = ["%b %d, %Y", "%B %d, %Y", "%Y-%m-%d"]


def parse_date(date_str: str) -> str:
    for fmt in DATE_FORMATS:
        try:
            dt = datetime.strptime(date_str.strip(), fmt)
            return dt.strftime("%Y-%m-%d-00-00")
        except ValueError:
            continue
    return datetime.now().strftime("%Y-%m-%d-%H-%M")


def date_from_url(url: str) -> str:
    m = DATE_URL.search(url)
    if m:
        y, mo, d = m.group(1), m.group(2).zfill(2), m.group(3).zfill(2)
        return f"{y}-{mo}-{d}-00-00"
    return ""


def load_done() -> set[str]:
    if DONE_FILE.exists():
        return set(json.loads(DONE_FILE.read_text()))
    return set()


def save_done(done: set[str]):
    DONE_FILE.write_text(json.dumps(sorted(done), indent=2))


def scp_and_delete(local_path: Path) -> bool:
    print(f"  SCP → Pi ...", flush=True)
    r = subprocess.run(["scp", "-i", SSH_KEY, str(local_path), PI_DEST],
                       capture_output=True, text=True)
    if r.returncode == 0:
        local_path.unlink()
        print("  Transferred. Local copy deleted.", flush=True)
        return True
    print(f"  SCP failed: {r.stderr.strip()}", flush=True)
    return False


def curl_download(url: str, dest: Path):
    subprocess.run(
        ["curl", "-L", "--silent", "--show-error", "-o", str(dest), url],
        check=True
    )


def scroll_and_collect(page, done: set[str], df_by_date: dict) -> list[str]:
    """Scroll the archive page, intercept audio URLs as they load."""
    captured: list[str] = []
    seen: set[str] = set()

    def on_request(req):
        url = req.url
        if CLOUDFRONT.match(url) and url not in seen:
            seen.add(url)
            captured.append(url)
            print(f"  [found] {url[:80]}", flush=True)

    page.on("request", on_request)

    print("Scrolling archive to load all episodes...", flush=True)
    stalls = 0
    prev = 0

    while stalls < 5:
        page.evaluate("window.scrollBy(0, 800)")
        time.sleep(1.5)

        # Click any load-more buttons
        for label in ["Load more", "Show more", "More episodes"]:
            try:
                btn = page.locator(f'button:has-text("{label}")').first
                if btn.is_visible(timeout=500):
                    btn.click()
                    time.sleep(2)
            except Exception:
                pass

        if len(captured) == prev:
            stalls += 1
        else:
            stalls = 0
        prev = len(captured)
        print(f"  URLs so far: {len(captured)} (stall {stalls}/5)", flush=True)

    page.remove_listener("request", on_request)
    return captured


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    done = load_done()

    df = pd.read_csv(CSV_PATH).fillna("")
    df["_parsed_date"] = pd.to_datetime(df["date"], errors="coerce")
    df = df.sort_values("_parsed_date").reset_index(drop=True)

    # Build a lookup: date slug → episode_id (for resume tracking)
    date_to_id = {}
    for _, row in df.iterrows():
        slug = parse_date(str(row["date"]))[:10]
        date_to_id[slug] = str(row["episode_id"]).strip()

    print(f"Loaded {len(df)} episodes from CSV.")
    print(f"Already done: {len(done)}.\n", flush=True)

    print("="*60)
    print("SETUP: Make sure Chrome is running with --remote-debugging-port=9222")
    print("       and you are logged into creators.spotify.com archive page.")
    print("="*60)
    input("Press Enter when ready...")

    with sync_playwright() as p:
        # Connect to existing Chrome via CDP
        try:
            browser = p.chromium.connect_over_cdp("http://localhost:9222")
            print("Connected to Chrome.", flush=True)
        except Exception as e:
            print(f"Could not connect to Chrome: {e}")
            print("Make sure Chrome was launched with --remote-debugging-port=9222")
            return

        # Use first context/page or open archive
        context = browser.contexts[0]
        pages = context.pages

        # Find the archive page or open it
        archive_page = None
        for pg in pages:
            if "archive" in pg.url or "creators.spotify.com" in pg.url:
                archive_page = pg
                break

        if not archive_page:
            archive_page = context.new_page()
            archive_page.goto(SHOW_URL, wait_until="networkidle")
            time.sleep(3)

        print(f"Using page: {archive_page.url}", flush=True)

        # Scroll and collect all audio URLs
        audio_urls = scroll_and_collect(archive_page, done, date_to_id)

        print(f"\nFound {len(audio_urls)} audio URLs total.", flush=True)

        if not audio_urls:
            print("No audio URLs found. The page may not have loaded episode players.")
            print("Try scrolling down manually in Chrome to trigger audio players.")
            input("Press Enter to retry scroll, or Ctrl-C to quit...")
            audio_urls = scroll_and_collect(archive_page, done, date_to_id)

        # Download each
        for i, url in enumerate(audio_urls):
            # Get date from URL or fall back to CSV match
            date_slug = date_from_url(url)
            date_key = date_slug[:10]

            # Try to resolve episode_id for done tracking
            ep_id = date_to_id.get(date_key, date_key)

            if ep_id in done or date_key in done:
                print(f"[{i+1}/{len(audio_urls)}] SKIP (done): {date_slug}", flush=True)
                continue

            ext = Path(url.split("?")[0]).suffix or ".m4a"
            dest = OUTPUT_DIR / f"bible-study-{date_slug}{ext}"

            print(f"\n[{i+1}/{len(audio_urls)}] {dest.name}", flush=True)

            try:
                curl_download(url, dest)
                if scp_and_delete(dest):
                    done.add(ep_id)
                    done.add(date_key)
                    save_done(done)
            except Exception as e:
                print(f"  ERROR: {e}", flush=True)

        print(f"\nAll done. {len(done)} episodes on the Pi.", flush=True)


if __name__ == "__main__":
    main()
