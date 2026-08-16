# StudyBox Raspberry Pi First Run

This document records the first Raspberry Pi setup path for StudyBox.

## Starting Point

- Raspberry Pi is running Ubuntu Server ARM64.
- Pi user: `studybox`
- First successful Pi address:
  - IPv4: `192.168.1.58`
  - Local IPv6: `fdf5:9e9b:5c17:10:8aa2:9eff:fec6:e998`
- SSH command from Mac:

```bash
ssh -i ~/.ssh/id_ubuntu studybox@studybox.local
```

- The Pi is reachable over local WiFi.
- The local Mac SSH key may be copied to the Pi for cloning the private GitHub repo.
- If `studybox.local` is flaky, use the direct IP:

```bash
ssh -i ~/.ssh/id_ubuntu studybox@192.168.1.58
ssh -i ~/.ssh/id_ubuntu studybox@fdf5:9e9b:5c17:10:8aa2:9eff:fec6:e998
```

## Copy GitHub SSH Key To Pi

From the Mac:

```bash
scp -i ~/.ssh/id_ubuntu ~/.ssh/id_ubuntu studybox@studybox.local:/home/studybox/.ssh/id_ubuntu
```

On the Pi:

```bash
chmod 700 ~/.ssh
chmod 600 ~/.ssh/id_ubuntu
cat >> ~/.ssh/config <<'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ubuntu
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
ssh -T git@github.com
```

On the first run, the copied `id_ubuntu` key worked for SSH into the Pi but was not authorized for GitHub. We deployed the committed source with a local archive instead. A later setup should either add a Pi-specific deploy key to GitHub or authorize the copied key for the repository.

## Create Tmux Session

```bash
tmux new -s studybox
```

From another SSH session, follow along with:

```bash
tmux attach -t studybox
```

Detach without stopping the process:

```text
Ctrl-b then d
```

## Install System Packages

The Ubuntu 24.04 image initially had only `noble` and `noble-security` apt suites enabled. `build-essential` failed because `bzip2` and `libbz2-1.0` resolved to mismatched versions.

Check package availability:

```bash
apt-cache policy bzip2 libbz2-1.0
cat /etc/apt/sources.list.d/*.sources
```

Back up and add `noble-updates` and `noble-backports` to the main Ubuntu source stanza:

```bash
sudo cp /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list.d/ubuntu.sources.bak-studybox
sudo sed -i "0,/Suites: noble/s/Suites: noble/Suites: noble noble-updates noble-backports/" /etc/apt/sources.list.d/ubuntu.sources
grep -n "^Suites:" /etc/apt/sources.list.d/ubuntu.sources
```

Then install the packages:

```bash
sudo apt update
sudo apt install -y bzip2 git tmux nodejs npm build-essential
```

Verified versions on the first run:

```text
node v18.19.1
npm 9.2.0
git 2.43.0
gcc 13.3.0
```

## Create StudyBox Directories

```bash
sudo mkdir -p /opt/studybox /var/lib/studybox /etc/studybox
sudo chown -R studybox:studybox /opt/studybox /var/lib/studybox
```

Intended directory roles:

- `/opt/studybox`: checked-out application source.
- `/var/lib/studybox`: local runtime data, recordings, logs, and backup queue.
- `/etc/studybox`: future system-level environment/config files.

## Clone And Build

Preferred path once GitHub SSH is configured:

```bash
git clone git@github.com:RichPadgett/studybox.git /opt/studybox
cd /opt/studybox
npm install
npm run build
```

First-run fallback used because GitHub SSH auth was not ready from the Pi:

From the Mac:

```bash
git archive --format=tar -o /private/tmp/studybox.tar HEAD
scp -i ~/.ssh/id_ubuntu /private/tmp/studybox.tar 'studybox@[fdf5:9e9b:5c17:10:8aa2:9eff:fec6:e998]:/home/studybox/studybox.tar'
```

On the Pi:

```bash
rm -rf /opt/studybox/*
tar -xf /home/studybox/studybox.tar -C /opt/studybox
cd /opt/studybox
npm install
npm run build
```

## First API Run

Run the API manually inside tmux:

```bash
cd /opt/studybox
PORT=4000 npm run start -w @studybox/api
```

From another machine on the same network:

```bash
curl http://studybox.local:4000/api/snapshot
```

Expected result:

- JSON response from StudyBox API.
- `systemStatus` should be `ready`.
- `hardware.audio.mode` should be `mock`.
- `zoom.mode` should be `mock` until the real runner is configured.

## First Web UI Run

The API package does not serve the React app at `/` yet. Start the web dev server in a second tmux window:

```bash
tmux new-window -t studybox -n web -c /opt/studybox "npm run dev -w @studybox/web"
```

First-run URLs:

```text
API: http://192.168.1.58:4000/api/snapshot
Web UI: http://192.168.1.58:5173/
```

Tmux windows:

```text
0: API, PORT=4000 npm run start -w @studybox/api
1: Web, npm run dev -w @studybox/web
```

## Boot Services

Initial systemd units live in:

```text
deploy/systemd/studybox-api.service
deploy/systemd/studybox-web.service
```

The first version intentionally mirrors the manual test:

- API runs on `4000`.
- Web UI runs on `5173`.
- Both run as the `studybox` user from `/opt/studybox`.
- Optional environment values can be placed in `/etc/studybox/studybox.env`.

Install them on the Pi:

```bash
sudo cp deploy/systemd/studybox-api.service /etc/systemd/system/studybox-api.service
sudo cp deploy/systemd/studybox-web.service /etc/systemd/system/studybox-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now studybox-api.service studybox-web.service
```

Check status and logs:

```bash
systemctl status studybox-api.service --no-pager
systemctl status studybox-web.service --no-pager
journalctl -u studybox-api.service -f
journalctl -u studybox-web.service -f
```

Stop the manual tmux session before enabling the services, otherwise ports `4000` and `5173` may already be in use:

```bash
tmux kill-session -t studybox
```

## Next Step

Replace the temporary Vite web service with a production static web service or Nginx reverse proxy before treating the Pi image as final.
