# ORBPuzzles Raspberry Pi kiosk setup

This guide documents deployment on Raspberry Pi OS Lite (64-bit), using a
minimal X11 session instead of a desktop environment. A **Raspberry Pi Zero 2
W or newer** is required for Chromium kiosk mode.

The production app runs with Gunicorn on **127.0.0.1:8080**. NGINX listens on
**port 80** and forwards requests to it, so users enter the Pi's IP address
or hostname without a port. Browsers do not use port 8080 automatically:
HTTP without a port uses 80, and HTTPS without a port uses 443.

This is a fresh-install recipe. For an existing Pi, back up
`/home/kiosk/escape-room-screen/src/instance/` and the protected environment
file first. Do not recreate the kiosk account, clone over an existing checkout
or regenerate its signing key. Apply the relevant service, cursor and audio
updates below while preserving your settings, uploads and recorded results.

> [!NOTE]
> On a Pi Zero 2 W, the Flask application can still take 30-40 seconds to
> start after a cold boot. The X11 startup file deliberately makes Chromium
> wait for the web application rather than opening a failed page.

## Supported Raspberry Pi models

| Model | Recommendation | Notes |
|---|---|---|
| Pi Zero 2 W | Best small replacement | Same compact form factor as the Zero W, with a quad-core ARMv8 CPU that supports Chromium. |
| Pi 3B+ | Good budget option | Suitable for one Flask and Chromium display; use a reliable 2.5 A power supply. |
| Pi 4 Model B (2 GB or more) | Best overall choice | A fast, dependable choice for an always-on Chromium kiosk. |
| Pi 5 (2 GB or more) | Best performance | More performance than one display needs, with capacity for additional local services or displays. |
| Pi 400 | Works well | Pi 4-class hardware in a keyboard form factor; normally unsuitable for a concealed kiosk. |

Avoid the original Pi Zero, Pi Zero W, Pi 1, and other older single-core
models for Chromium kiosk mode. Current Chromium builds require CPU
capabilities that those boards do not provide.

## 1. Flash and boot Raspberry Pi OS Lite

Use Raspberry Pi Imager to write **Raspberry Pi OS Lite (64-bit)** to a
microSD card. Before writing, configure a hostname, Wi-Fi country and
credentials, an administrator account, and SSH.

Connect to the Pi:

```bash
ssh <admin-user>@<pi-hostname>.local
```

Use the Pi's IP address if the `.local` hostname does not resolve.

## 2. Install operating-system packages

Run as the administrator account:

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y \
  build-essential \
  curl \
  git \
  pipx \
  python3 \
  python3-dev \
  python3-venv \
  python3-lgpio \
  alsa-utils \
  raspi-utils-core \
  swig \
  liblgpio-dev \
  nginx \
  chromium \
  xinit \
  xserver-xorg \
  x11-xserver-utils
```

`build-essential`, `swig`, and `liblgpio-dev` are required because the
`lgpio` Python package builds a Raspberry Pi GPIO extension during install.

Current Raspberry Pi OS Trixie and updated Bookworm repositories provide
`vcgencmd` in `raspi-utils-core`. Older instructions used
`libraspberrypi-bin`, which has no installation candidate on Trixie.
If the install stopped with that error, rerun the full install command above
with `raspi-utils-core`; do not assume the other requested packages were
installed. Use the native package selected by APT, not an `:armhf` replacement
on a 64-bit Pi.

## 3. Create the kiosk account

```bash
sudo adduser kiosk
sudo usermod -aG gpio,video,audio,input,plugdev kiosk
```

Do not add `kiosk` to `sudo`.

## 4. Clone the application

```bash
sudo -u kiosk -H git clone \
  https://github.com/Your-Grandad/Escape-Room-Screen.git \
  /home/kiosk/escape-room-screen
```

## 5. Install Poetry and application dependencies

Install Poetry for the account that runs the service:

```bash
sudo -u kiosk -H bash -c '
  set -e
  cd /home/kiosk
  pipx install poetry
  /home/kiosk/.local/bin/poetry --version
'
```

Install the project's dependencies:

```bash
sudo -u kiosk -H bash -c '
  set -e
  cd /home/kiosk/escape-room-screen
  /home/kiosk/.local/bin/poetry env use python3
  /home/kiosk/.local/bin/poetry install --only main
  /home/kiosk/.local/bin/poetry run gunicorn --version
'
```

Do not continue until the last command prints a Gunicorn version. This verifies
the executable in the kiosk user's project environment, which is the same
environment used by systemd. If it reports `Command not found: gunicorn`, use
the recovery section below; installing it for the administrator or system
Python does not repair the kiosk environment.

The project supports Python 3.11 or newer. Check the installed interpreter:

```bash
python3 --version
```

On Linux, the project dependencies include Gunicorn, the production WSGI
server. Do not use Flask's development server for this always-on deployment.

## 6. Set application secrets

Create a protected environment file:

```bash
sudo install -d -m 0750 -o kiosk -g kiosk /etc/escape-room-screen
SECRET_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"

sudo tee /etc/escape-room-screen/environment >/dev/null <<EOF
SECRET_KEY=${SECRET_KEY}
ADMIN_PASSWORD=replace-this-with-a-long-unique-password

# Optional output pins, using BCM numbering:
# GPIO_OUTPUTS={"door-light":27,"buzzer":23}

# Optional GPIO inputs, using BCM numbering:
# GPIO_INPUTS={"complete-room":17}
# GPIO_INPUTS={"complete-room":17,"display-toggle":22}

# Optional: hide the donation widget (shown by default):
# HIDE_DONATIONS=true

# Optional: maximum upload request size in MB (default 8):
# MAX_UPLOAD_MB=8
EOF

sudo chown kiosk:kiosk /etc/escape-room-screen/environment
sudo chmod 0600 /etc/escape-room-screen/environment
```

Replace `ADMIN_PASSWORD` before starting the service:

```bash
sudo nano /etc/escape-room-screen/environment
```

Use only one `GPIO_INPUTS` line, and keep its pins distinct from
`GPIO_OUTPUTS`. Check that no HAT, overlay or peripheral claims a chosen pin.

## 7. Create and start the web application service

```bash
sudo tee /etc/systemd/system/escape-room-screen.service >/dev/null <<'EOF'
[Unit]
Description=Escape Room Screen
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=kiosk
Group=kiosk
WorkingDirectory=/home/kiosk/escape-room-screen
EnvironmentFile=/etc/escape-room-screen/environment
Environment=HOME=/home/kiosk
Environment=PYTHONUNBUFFERED=1
ExecStart=/home/kiosk/.local/bin/poetry run gunicorn --bind 127.0.0.1:8080 --workers 1 --worker-class gthread --threads 16 --timeout 120 --access-logfile - --error-logfile - "escape_room_screen.app:create_app()"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable escape-room-screen.service
sudo systemctl restart escape-room-screen.service
```

Wait at least 40 seconds on a Pi Zero 2 W, then check the service:

```bash
sudo systemctl status escape-room-screen.service --no-pager
```

The explicit restart applies a changed service command to an existing
installation as well as starting a new one. A momentary `active` status can
still be a restart loop: inspect the journal if the page returns 502.

Configure NGINX in the next step before testing the port-free URL.
Gunicorn's port 8080 is bound to loopback and is not exposed to other devices.

Keep **one worker** because the live-update broker, timer scheduling, and
GPIO control are local to one process. The threaded worker allows long-lived
Server-Sent Events connections alongside normal page requests. Do not add
`--preload`, which would initialize GPIO and timer state in the master process.
The 120-second worker timeout leaves room for cold startup on slower Pis.
The threaded worker continues reporting health during long-lived streams;
systemd restarts the service if it exits.

## 8. Configure NGINX for access without a port

On a dedicated kiosk Pi, create this site:

```bash
sudo tee /etc/nginx/sites-available/escape-room-screen >/dev/null <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    client_max_body_size 8m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Connection "";
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
EOF

sudo ln -sfn /etc/nginx/sites-available/escape-room-screen \
  /etc/nginx/sites-enabled/escape-room-screen
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl enable --now nginx && sudo systemctl reload nginx
```

This replaces NGINX's packaged default site on a dedicated Pi. If the Pi
already hosts other websites, keep their configuration and use an appropriate
`server_name` instead of adding another `default_server`.

Disabling proxy buffering and caching lets `/events` deliver live updates
immediately. The upload limit matches the app's default 8 MB request limit.
If you change `MAX_UPLOAD_MB`, change `client_max_body_size` to match and
validate/reload NGINX.

Once NGINX is configured, test the public entry point without a port and
find the Pi's network address:

```bash
curl -I --max-time 10 http://127.0.0.1/
hostname -I
```

The expected response starts with `HTTP/1.1 200 OK`. The port-8080 check in
troubleshooting is only for diagnosing the internal backend, not the public URL.

The display and remote administration pages are now available at:

```text
http://<pi-ip-address>/
http://<pi-ip-address>/admin
```

You can use `http://<pi-hostname>.local/` if the network resolves that hostname,
or point a local DNS name at the Pi's IP address. Do not open port 8080 in a
firewall or router; only the NGINX entry point needs network access. If a
firewall is enabled on the Pi, allow HTTP port 80 from the trusted local
network.

These examples use HTTP on a trusted local network. Do not expose the admin
panel directly to the internet or untrusted Wi-Fi with plaintext HTTP.
Use a VPN, or configure HTTPS on NGINX's port 443 and secure session cookies,
for access beyond that trusted network.

Sign in with username `admin` and the `ADMIN_PASSWORD` configured in step 6.
The `admin` account is the superuser and can add standard operator accounts
under **Settings > Users**.

## 9. Configure Chromium kiosk mode

Create the X11 session for the kiosk account:

```bash
sudo tee /home/kiosk/.xinitrc >/dev/null <<'EOF'
#!/bin/sh

xset -dpms
xset s off
xset s noblank

# Select the connected monitor's preferred resolution after X11 is available.
xrandr --output HDMI-1 --auto

until curl --silent --fail http://127.0.0.1/ >/dev/null; do
  sleep 2
done

exec /usr/bin/chromium \
  --no-first-run \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --autoplay-policy=no-user-gesture-required \
  --alsa-output-device=hdmi:CARD=vc4hdmi,DEV=0 \
  --start-maximized \
  --window-position=0,0 \
  --window-size=1920,1080 \
  --kiosk \
  --incognito \
  http://127.0.0.1/
EOF

sudo chown kiosk:kiosk /home/kiosk/.xinitrc
sudo chmod 0755 /home/kiosk/.xinitrc
```

Make the kiosk user start X11 when it automatically logs in to the first
console:

```bash
sudo tee /home/kiosk/.bash_profile >/dev/null <<'EOF'
[ -f "$HOME/.profile" ] && . "$HOME/.profile"

if [ -z "$DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
  while true; do
    startx -- :0 -keeptty -nolisten tcp -nocursor
    sleep 2
  done
fi
EOF

sudo chown kiosk:kiosk /home/kiosk/.bash_profile
sudo chmod 0644 /home/kiosk/.bash_profile
```

The X server's `-nocursor` option hides the pointer throughout the kiosk
session, including when a mouse moves. It does not disable input and does
not affect staff browsers on other computers. No `unclutter` process is needed.

## 10. Enable automatic kiosk login

```bash
sudo mkdir -p /etc/systemd/system/getty@tty1.service.d

sudo tee /etc/systemd/system/getty@tty1.service.d/autologin.conf >/dev/null <<'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin kiosk --noclear %I $TERM
EOF

sudo systemctl set-default multi-user.target
sudo systemctl daemon-reload
sudo reboot
```

After reboot, systemd starts the app, logs in as `kiosk`, starts X11, and
opens the home screen in Chromium.

## 11. Configure HDMI audio and monitor power

Verify that ALSA can see an HDMI device:

```bash
aplay -l
aplay -L
```

These examples use `hdmi:CARD=vc4hdmi,DEV=0`. If your device is named
`vc4hdmi0` instead, use that exact name everywhere: the speaker test,
Chromium's audio flag, and both card references in `.asoundrc`.

```bash
speaker-test -D hdmi:CARD=vc4hdmi,DEV=0 -c 2 -t wav -l 1
sudo -u kiosk -H speaker-test -D hdmi:CARD=vc4hdmi,DEV=0 -c 2 -t wav -l 1
```

The second test verifies the account that runs Chromium. Stop any other
running `speaker-test` with Ctrl+C before testing the app: it can keep the
HDMI device busy.

Set the kiosk user's default audio to the same working device:

```bash
sudo -u kiosk tee /home/kiosk/.asoundrc >/dev/null <<'EOF'
pcm.!default {
    type plug
    slave.pcm "hdmi:CARD=vc4hdmi,DEV=0"
}

ctl.!default {
    type hw
    card vc4hdmi
}
EOF
```

In `/home/kiosk/.xinitrc`, keep
`--alsa-output-device=hdmi:CARD=vc4hdmi,DEV=0` and
`--autoplay-policy=no-user-gesture-required`. After changing the audio flag
or `.asoundrc`, reboot to restart the kiosk's Chromium/X11 session.
Restarting only the web application service does not restart Chromium.

If the direct speaker test works, do not change HDMI firmware settings just
to fix browser playback. If no HDMI device is detected, check the model's
firmware and display-driver settings:

```bash
sudo nano /boot/firmware/config.txt
```

On older Raspberry Pi OS releases, the file is `/boot/config.txt`. The
following legacy settings are model/driver-dependent; only use them if
appropriate for your setup, then reboot:

```ini
hdmi_force_hotplug=1
hdmi_drive=2
```

The home screen uses Chromium audio playback for notification, completion,
and failure sounds. The `--autoplay-policy=no-user-gesture-required` option in
the X11 startup command allows sounds received through live updates to play
without a separate click on the kiosk screen. Upload and test the sound files
from **Settings > Sounds**. Without a custom event file, the app uses a
built-in tone. The embedded live preview is intentionally silent: use the
main player display for sound checks.

The web monitor-power button is temporarily hidden. Optional GPIO monitor
control still uses `vcgencmd display_power`. Before configuring it, confirm
the command is installed and works as the kiosk account:

```bash
command -v vcgencmd
sudo -u kiosk vcgencmd display_power
```

If the command is missing:

```bash
sudo apt update
sudo apt install -y raspi-utils-core
sudo systemctl restart escape-room-screen.service
```

To connect a physical monitor toggle button, set this in
`/etc/escape-room-screen/environment`:

```ini
GPIO_INPUTS={"display-toggle":17}
```

This is an alternative to a complete-room assignment on BCM 17, not a second
use of the same input. To keep both events, use the combined BCM 17 / BCM 22
example from step 6 instead. Use unused pins and GPIO Zero button wiring.
Apply the environment change with:

```bash
sudo systemctl daemon-reload
sudo systemctl restart escape-room-screen.service
```

The web control and GPIO control both toggle the same HDMI output. The
monitor's own standby or backlight behavior can vary by model; the control
switches the Raspberry Pi HDMI signal using `vcgencmd`.

## Troubleshooting encountered during setup

### NGINX shows `502 Bad Gateway`, or live updates do not arrive

Check the backend service and then the reverse proxy:

```bash
sudo systemctl status escape-room-screen.service --no-pager
sudo journalctl -u escape-room-screen.service -n 50 --no-pager
curl -I --max-time 10 http://127.0.0.1:8080/
sudo nginx -t
sudo systemctl status nginx --no-pager
curl -I --max-time 10 http://127.0.0.1/
```

Allow time for the app to start on a Pi Zero 2 W. If Gunicorn is missing, use
the missing-Gunicorn recovery below and verify its version as kiosk.
If the NGINX welcome page appears, check that
the new site is enabled and the packaged default site has been removed.
For delayed updates, keep `proxy_buffering off` and a single threaded
application worker. After changing the service or NGINX configuration, run:

```bash
sudo systemctl daemon-reload
sudo systemctl restart escape-room-screen.service
sudo nginx -t && sudo systemctl reload nginx
```

### `Command not found: gunicorn`, repeated restarts, and a blank kiosk

Gunicorn is missing from the service's Poetry environment. NGINX returns
`502 Bad Gateway` because no backend starts; the kiosk can stay blank because
its launcher waits for a successful HTTP response before opening Chromium.

Stop the restart loop and repair the dependency as the kiosk user in the
application directory. This also handles older checkouts whose dependency
list does not yet include Gunicorn:

```bash
sudo systemctl stop escape-room-screen.service
sudo -u kiosk -H bash -c '
  set -e
  cd /home/kiosk/escape-room-screen
  /home/kiosk/.local/bin/poetry add "gunicorn>=26.2.0,<27.0.0" \
    --markers "sys_platform != \"win32\""
  /home/kiosk/.local/bin/poetry run gunicorn --version
' && sudo systemctl restart escape-room-screen.service
```

Poetry updates the project's dependency declaration and lock file and installs
the package in its environment. Keep the failure output if either command
fails; do not continue with a system-wide `pip install` or change the ports.

Allow cold-start time, then check the public entry point:

```bash
curl -I --max-time 10 http://127.0.0.1/
```

The expected response is `HTTP/1.1 200 OK`. The waiting kiosk should then launch
Chromium. If HTTP works but the screen remains blank, investigate the local
tty1/X11 startup separately.

### `poetry: command not found`

Poetry is not supplied by Raspberry Pi OS Lite by default. Install it with
`pipx` as the kiosk user, as shown in step 5. The service must use its actual
path:

```text
/home/kiosk/.local/bin/poetry
```

Do not use `/usr/bin/poetry` unless Poetry was installed system-wide there.

### `Permission denied: '/home/<admin-user>'`

`sudo -u kiosk` retains the current directory. If the current directory is
the administrator's private home directory, switch to the kiosk home before
running Poetry:

```bash
sudo -u kiosk -H bash -c '
  cd /home/kiosk
  /home/kiosk/.local/bin/poetry --version
'
```

For interactive work, use `sudo -iu kiosk`.

### `Current Python version (...) is not allowed by the project (>=3.14)`

Use the repository version of this guide, whose `pyproject.toml` supports
Python 3.11 through Python 3.x. Pull the updated project and run:

```bash
sudo -u kiosk -H bash -c '
  set -e
  cd /home/kiosk/escape-room-screen
  git pull --ff-only
  /home/kiosk/.local/bin/poetry env use python3
  /home/kiosk/.local/bin/poetry install --only main
  /home/kiosk/.local/bin/poetry run gunicorn --version
'
```

### `status=203/EXEC` or `Unable to locate executable '/usr/bin/poetry'`

The service file has the wrong Poetry path. Recreate the service from step 7,
then reload and restart it:

```bash
sudo systemctl daemon-reload
sudo systemctl restart escape-room-screen.service
```

### `startx: command not found`

The minimal graphical session package was not installed. Install X11 startup
support, verify the command exists, then reboot so the automatic kiosk login
starts it on the Pi's attached display:

```bash
sudo apt update
sudo apt install -y xinit xserver-xorg x11-xserver-utils
command -v startx
sudo reboot
```

### HDMI audio is missing or sounds are blocked

Check that the HDMI output is detected and that the kiosk user belongs to the
audio group:

```bash
aplay -l
groups kiosk
```

If no HDMI device is listed, follow the model/driver-specific checks in the
audio section. Do not force legacy firmware settings on an unsupported
driver. If the device is listed but
the kiosk is silent, confirm `--autoplay-policy=no-user-gesture-required` is in
`/home/kiosk/.xinitrc` and restart the X11 session.
If the speaker test works but the app is silent, test the same device as
`kiosk`, check that the Chromium flag and `/home/kiosk/.asoundrc` use the
exact working card name, and stop any speaker-test process. Upload a playable
file under **Settings > Sounds** if you want a custom event sound, save it
and trigger the matching event. Without an uploaded event file, the app uses
a built-in tone. The speaker test does not configure an event sound in the app.
The embedded live preview is deliberately silent; test the main player
display, not a URL with `preview=1` or `preview=true`.

Read the startup audio flags as the administrator with `sudo`, since the
kiosk home directory may not be readable by your SSH account:

```bash
sudo grep -nE 'alsa-output-device|autoplay' /home/kiosk/.xinitrc
sudo cat /home/kiosk/.asoundrc
```

If the audible speaker test confirmed `hdmi:CARD=vc4hdmi,DEV=0` but the
Chromium flag or `.asoundrc` still names `vc4hdmi0`, use this targeted repair.
It creates timestamped backups and reboots only after the corrected browser
flag is found. Do not use this replacement on a Pi whose actual working
device is `vc4hdmi0`:

```bash
sudo sed -i".audio-backup-$(date +%Y%m%d-%H%M%S)" \
  's/vc4hdmi0/vc4hdmi/g' \
  /home/kiosk/.xinitrc /home/kiosk/.asoundrc &&
sudo grep -nF -- '--alsa-output-device=hdmi:CARD=vc4hdmi,DEV=0' \
  /home/kiosk/.xinitrc &&
sudo reboot
```

Rebooting disconnects SSH and restarts Chromium with the new audio device.
Once the player screen returns, send a new hint to test its notification.

### Monitor power button is disabled

The button is disabled when `vcgencmd` is unavailable. Check it with:

```bash
command -v vcgencmd
sudo -u kiosk vcgencmd display_power
```

Install `raspi-utils-core` if necessary, then restart
`escape-room-screen.service`.

The expected command path is `/usr/bin/startx`. Do not run `startx` through
SSH; it must start from the kiosk account's automatic login on the Pi's local
console.

### `xinit: giving up` with `Cannot open virtual console 7 (Permission denied)`

The kiosk user cannot open a different virtual console. It must keep the
automatically logged-in console (`tty1`) instead. Replace the X startup line
in `/home/kiosk/.bash_profile`:

```bash
sudo sed -i \
  's/startx -- :0 vt7 -nolisten tcp/startx -- :0 -keeptty -nolisten tcp -nocursor/' \
  /home/kiosk/.bash_profile

sudo reboot
```

### Mouse pointer remains in the middle of the kiosk screen

Add `-nocursor` to the X server arguments in `/home/kiosk/.bash_profile`:

```bash
sudo nano /home/kiosk/.bash_profile
```

The startup line inside the existing loop should be:

```bash
startx -- :0 -keeptty -nolisten tcp -nocursor
```

Save the file, then reboot the Pi to start a new X11 session. This disconnects
SSH and briefly interrupts the display:

```bash
sudo reboot
```

Older versions of this guide used `unclutter --timeout 0.5 --start-hidden`,
which are not valid options for Debian's classic `unclutter` package.
Remove that old startup line from `/home/kiosk/.xinitrc`; the X server now
handles cursor hiding directly. To show a local pointer for debugging,
remove `-nocursor` and restart the X11 session.

### Chromium fills only part of the display

Chromium's `--kiosk` flag fills the X11 display. If it appears in only half
of the monitor, X11 started at the wrong HDMI resolution rather than the web
application being constrained. At the Pi's local console or over SSH, inspect
the active X11 output and modes:

```bash
sudo -u kiosk DISPLAY=:0 XAUTHORITY=/home/kiosk/.Xauthority xrandr --query
```

Find the line ending in `connected` (normally `HDMI-1`) and a mode marked
with `+`, which is the monitor's preferred resolution. Set that mode now,
substituting the output and resolution shown by the preceding command:

```bash
sudo -u kiosk DISPLAY=:0 XAUTHORITY=/home/kiosk/.Xauthority \
  xrandr --output HDMI-1 --mode 1920x1080
```

The `xrandr --output HDMI-1 --auto` line in step 9 makes the selected
monitor mode persistent each time the kiosk starts. If the connected output
has a different name, replace `HDMI-1` in `/home/kiosk/.xinitrc` with the
name reported by `xrandr`, then reboot:

```bash
sudo nano /home/kiosk/.xinitrc
sudo reboot
```

If `xrandr` offers no correct mode, check your monitor, cable and the Pi's
display-driver documentation. The following legacy firmware example may
not apply to modern KMS drivers or every Pi model. If your driver supports
it, configure the HDMI mode before X11 starts. Current Raspberry Pi OS stores this file at
`/boot/firmware/config.txt`; older Raspberry Pi OS releases use
`/boot/config.txt`. Edit the file that exists and add these lines for a
1080p monitor:

```text
hdmi_group=2
hdmi_mode=82
disable_overscan=1
```

`hdmi_mode=82` is 1920x1080 at 60 Hz. Use a mode supported by the monitor;
for a 720p monitor use `hdmi_mode=85` instead. Reboot after saving:

```bash
sudo reboot
```

### Chromium displays a NEON SIMD hardware warning

The original Raspberry Pi Zero W's ARMv6 CPU does not implement NEON SIMD.
Current Raspberry Pi OS Chromium requires NEON and exits after showing a
message similar to:

```text
The hardware on this system lacks support for NEON SIMD extensions.
```

This cannot be fixed by changing Chromium flags, X11 configuration, or the
Flask service. Use a Raspberry Pi Zero 2 W or newer for Chromium kiosk mode.
Older browsers may render a limited static page, but they are not a supported
replacement for this application's JavaScript and Server-Sent Events display.

### `No module named 'lgpio'`, `swig: No such file or directory`, or `cannot find -llgpio`

Install all packages from step 2, particularly `swig` and `liblgpio-dev`,
then reinstall the project's dependencies:

```bash
sudo -u kiosk -H bash -c '
  set -e
  cd /home/kiosk/escape-room-screen
  /home/kiosk/.local/bin/poetry install --only main
  /home/kiosk/.local/bin/poetry run gunicorn --version
'
```

### `lgpio.error: 'GPIO busy'`

A saved GPIO input mapping is attempting to use a pin claimed by another
process or system overlay. For example, BCM GPIO 18 (physical pin 12) is
often used by audio/PWM configuration.

To restore the display without deleting display settings, remove only the
blocked input mapping, then restart:

```bash
sudo systemctl stop escape-room-screen.service

sudo -u kiosk -H python3 -c '
import sqlite3
database = "/home/kiosk/escape-room-screen/src/instance/home_screen.db"
connection = sqlite3.connect(database)
connection.execute("DELETE FROM gpio_mappings WHERE pin = ?", (18,))
connection.commit()
print("Removed BCM GPIO 18 mapping.")
'

sudo systemctl start escape-room-screen.service
```

Rewire the input to an unused BCM pin, such as GPIO 17 (physical pin 11), and
add it again from **Admin > GPIO**. Avoid GPIO 2/3, GPIO 14/15, and GPIO 18
while resolving pin conflicts.

> [!NOTE]
> Flask stores its database at
> `/home/kiosk/escape-room-screen/src/instance/home_screen.db`, not at
> `/home/kiosk/escape-room-screen/instance/home_screen.db`.

## Maintenance

```bash
# Follow application logs.
sudo journalctl -u escape-room-screen.service -f

# Restart after backend code or environment changes.
sudo systemctl restart escape-room-screen.service

# Update from Git, then restart.
sudo -u kiosk -H bash -c '
  set -e
  cd /home/kiosk/escape-room-screen
  git pull --ff-only
  /home/kiosk/.local/bin/poetry install --only main
  /home/kiosk/.local/bin/poetry run gunicorn --version
' && sudo systemctl restart escape-room-screen.service
```

Back up `src/instance/` and `/etc/escape-room-screen/environment` before
updates. Preserve local changes; if `git pull --ff-only` fails, resolve the
reported conflict rather than overwriting the checkout.

Reload NGINX only after `sudo nginx -t` succeeds. Changes to `.xinitrc`,
`.bash_profile` or `.asoundrc` need a new Chromium/X11 session, normally
`sudo reboot`; an application-service restart alone does not apply them.
