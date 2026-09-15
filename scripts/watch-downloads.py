#!/usr/bin/env python3
"""
Watches ~/Downloads for new podcast episode files.
As each one lands, renames it to bible-study-YYYY-MM-DD-HH-MM.<ext>,
SCPs it to the Raspberry Pi, and deletes the local copy.

Run:
    python3 scripts/watch-downloads.py
"""

import json
import os
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path

WATCH_DIR  = Path.home() / "Downloads"
DONE_FILE  = Path(__file__).parent / ".watch-done.json"
PI_DEST    = "studybox@studybox.local:/home/studybox/episodes/"
SSH_KEY    = str(Path.home() / ".ssh" / "id_ubuntu")

AUDIO_EXTS = {".m4a", ".mp3", ".wav", ".aac", ".ogg"}

# Match files that look like Spotify/Anchor downloads
EPISODE_PATTERN = re.compile(r"\.(m4a|mp3|wav|aac|ogg)$", re.IGNORECASE)


def load_done() -> set[str]:
    if DONE_FILE.exists():
        return set(json.loads(DONE_FILE.read_text()))
    return set()


def save_done(done: set[str]):
    DONE_FILE.write_text(json.dumps(sorted(done), indent=2))


def extract_date(path: Path) -> str:
    """Try to pull publish/record date from file metadata via ffprobe."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_format", str(path)],
            capture_output=True, text=True, timeout=10
        )
        data = json.loads(result.stdout)
        tags = data.get("format", {}).get("tags", {})
        # Try common date tag names
        for key in ["date", "creation_time", "published", "release_date",
                    "DATE", "TDRL", "TDRC", "year"]:
            val = tags.get(key, "")
            if val:
                # Parse ISO dates like 2026-06-25 or 2026-06-25T00:00:00
                m = re.match(r"(\d{4})-(\d{2})-(\d{2})", val)
                if m:
                    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}-00-00"
                # Year only
                m = re.match(r"(\d{4})$", val.strip())
                if m:
                    return f"{m.group(1)}-01-01-00-00"
    except Exception:
        pass
    return ""


def wait_for_complete(path: Path, timeout: int = 60) -> bool:
    """Wait until file stops growing (download complete)."""
    prev_size = -1
    waited = 0
    while waited < timeout:
        try:
            size = path.stat().st_size
        except FileNotFoundError:
            return False
        if size == prev_size and size > 0:
            return True
        prev_size = size
        time.sleep(1)
        waited += 1
    return False


def scp_and_delete(local_path: Path) -> bool:
    print(f"  SCP → Pi ...")
    r = subprocess.run(
        ["scp", "-i", SSH_KEY, str(local_path), PI_DEST],
        capture_output=True, text=True
    )
    if r.returncode == 0:
        local_path.unlink()
        print("  Transferred. Local copy deleted.")
        return True
    else:
        print(f"  SCP failed: {r.stderr.strip()}")
        print(f"  File kept at: {local_path}")
        return False


def process_file(path: Path, done: set[str], episode_counter: list):
    print(f"\nNew file: {path.name}")

    if not wait_for_complete(path):
        print("  Timed out waiting for download — skipping.")
        return

    date_slug = extract_date(path)
    if not date_slug:
        # Fallback: use file modification time
        mtime = datetime.fromtimestamp(path.stat().st_mtime)
        date_slug = mtime.strftime("%Y-%m-%d-%H-%M")
        print(f"  No metadata date found, using file time: {date_slug}")
    else:
        print(f"  Date from metadata: {date_slug}")

    ext = path.suffix.lower()
    dest = path.parent / f"bible-study-{date_slug}{ext}"

    # Avoid collision if two episodes share a date
    counter = 1
    original_dest = dest
    while dest.exists():
        stem = f"bible-study-{date_slug}-{counter}"
        dest = path.parent / f"{stem}{ext}"
        counter += 1

    path.rename(dest)
    print(f"  Renamed → {dest.name}")

    if scp_and_delete(dest):
        done.add(path.name)
        save_done(done)
        episode_counter[0] += 1
        print(f"  Episode #{episode_counter[0]} done.")


def main():
    done = load_done()
    episode_counter = [0]

    print(f"Watching {WATCH_DIR} for new audio files...")
    print(f"Already processed: {len(done)} files.")
    print("Start downloading episodes in Chrome. Press Ctrl-C to stop.\n")

    seen: set[str] = set()

    # Seed with existing files so we don't reprocess them
    for f in WATCH_DIR.iterdir():
        if EPISODE_PATTERN.search(f.name):
            seen.add(f.name)

    while True:
        try:
            current = {f.name: f for f in WATCH_DIR.iterdir()
                       if EPISODE_PATTERN.search(f.name)}
            new_files = [path for name, path in current.items()
                         if name not in seen and name not in done]

            for path in sorted(new_files, key=lambda p: p.stat().st_ctime):
                seen.add(path.name)
                process_file(path, done, episode_counter)

            time.sleep(2)

        except KeyboardInterrupt:
            print(f"\nStopped. {episode_counter[0]} episodes transferred this session.")
            break


if __name__ == "__main__":
    main()
