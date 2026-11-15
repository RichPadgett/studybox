#!/usr/bin/env python3
"""Tiny captive-portal responder for the StudyBox-Setup hotspot.

Phones probe a known URL (captive.apple.com, connectivitycheck.gstatic.com, ...)
right after joining a Wi-Fi network. dnsmasq points every name at the Pi, so the
probe lands here.

  * Until the phone has opened the setup page, probes get a redirect to it, so the
    phone pops up StudyBox Wi-Fi setup on its own.
  * The setup page then calls /studybox-release. From then on that phone's probes
    get the "you're online" answer its OS expects. Without this, an iPhone treats
    the hotspot as an unfinished hotel sign-in: closing the pop-up makes it leave
    the network or send Safari over cellular, so the setup page "fails to load".

Released phones are written to /run/studybox-wifi/captive-released.json so the
StudyBox screen can move on to "pick Wi-Fi on your phone".
"""
from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

address = sys.argv[1] if len(sys.argv) > 1 else "10.42.0.1"
pid_path = sys.argv[2] if len(sys.argv) > 2 else None
released_path = "/run/studybox-wifi/captive-released.json"
target = f"http://{address}:5173/setup"

released: set[str] = set()
lock = threading.Lock()

APPLE_SUCCESS = b"<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>"


def save_released() -> None:
    temporary = f"{released_path}.tmp"
    try:
        os.makedirs(os.path.dirname(released_path), exist_ok=True)
        with open(temporary, "w", encoding="utf-8") as stream:
            json.dump(sorted(released), stream)
        os.chmod(temporary, 0o644)
        os.replace(temporary, released_path)
    except OSError:
        pass


class Portal(BaseHTTPRequestHandler):
    def do_GET(self):
        client = self.client_address[0].removeprefix("::ffff:")
        path = self.path.lower()

        if path.startswith("/studybox-release"):
            with lock:
                if client not in released:
                    released.add(client)
                    save_released()
            self.respond(204)
            return

        with lock:
            is_released = client in released
        # Someone typing the box's own address always gets the setup page.
        asked_for_box = (self.headers.get("Host") or "").split(":")[0] == address
        if is_released and not asked_for_box:
            if "generate_204" in path or "gen_204" in path:
                self.respond(204)
            elif "connecttest" in path:
                self.respond(200, b"Microsoft Connect Test", "text/plain")
            elif "ncsi" in path:
                self.respond(200, b"Microsoft NCSI", "text/plain")
            else:
                self.respond(200, APPLE_SUCCESS)
            return

        body = f'<!doctype html><meta http-equiv="refresh" content="0;url={target}"><a href="{target}">Set up StudyBox Wi-Fi</a>'.encode()
        self.respond(302, body, location=target)

    do_HEAD = do_GET
    do_POST = do_GET

    def respond(self, status: int, body: bytes = b"", content_type: str = "text/html; charset=utf-8", location: str | None = None) -> None:
        self.send_response(status)
        if location:
            self.send_header("Location", location)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        if status != 204:
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def log_message(self, *_args):
        pass


save_released()
server = ThreadingHTTPServer((address, int(os.environ.get("STUDYBOX_CAPTIVE_PORT", "80"))), Portal)
if pid_path:
    with open(pid_path, "w", encoding="utf-8") as stream:
        stream.write(str(os.getpid()))
server.serve_forever()
