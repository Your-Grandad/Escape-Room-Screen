# ORBPuzzles (Escape Room Screen)

Fullscreen, browser-based escape-room display for a Raspberry Pi. The
connected display shows the room screen at `/`; staff can use `/admin` from
another device on the same network to control it in real time.

## Install and run

Requires Python 3.11 or newer, Git and Poetry 2.x. Clone the public repository
over HTTPS and install its Poetry environment:

```bash
git clone https://github.com/Your-Grandad/Escape-Room-Screen.git
cd Escape-Room-Screen
poetry install
```

For complete platform-specific instructions, see
[Running on Windows, Linux and macOS](LOCAL_SETUP.md). For a dedicated Raspberry Pi
kiosk, see [Raspberry Pi deployment](RASPBERRY_PI_KIOSK.md).

For development, set a unique Flask signing key and the admin password, then
start Flask's development server:

```bash
export SECRET_KEY="$(poetry run python -c 'import secrets; print(secrets.token_urlsafe(32))')"
export ADMIN_PASSWORD="choose-a-strong-password"
poetry run flask --app escape_room_screen.app:create_app run --host=0.0.0.0 --port=5000
```

These are Unix-shell commands; use the local setup guide's PowerShell section
on Windows. Reuse a stable signing key on later launches and keep it outside
Git. Restrict this development server to the trusted local network.

`ADMIN_PASSWORD` supplies the initial password for the `admin` superuser.
Sign in with username `admin`. The superuser can create standard users under
**Settings > Users**; standard users can use all room controls and settings
but cannot manage accounts. Each user can replace their own password under
**Settings > Change admin password**. Passwords are securely hashed in the
application database, persist across restarts, and password changes sign out
that user's existing sessions.

For this local development command, open `http://127.0.0.1:5000/` for the
display and `http://127.0.0.1:5000/admin` for staff controls. On another device,
replace `127.0.0.1` with the server computer's trusted local-network IP,
keeping `:5000`. Do not use this development server for the always-on Pi kiosk.
The Pi production setup below uses port-free URLs instead. Changes are stored
in SQLite and pushed through Server-Sent Events without refreshing the page.

Staff pages use a separate `static/admin.css` stylesheet for the navigation,
utility forms, and responsive layouts. It is not loaded by the room display,
so admin styling can be adjusted without changing the home screen.
In the single-column tablet/mobile layout, Room controls and Adjust time
appear before the announcement and hint panel; desktop keeps its two columns.

Customisation stacks the starting duration below Display text, alongside Colours
and images. Background and logo images have compact previews, including local
previews of newly selected files before saving.

Use **Settings > Dark mode** on staff pages (or the toggle on the login page)
to switch themes. The choice is saved in that browser; without a saved choice, the
admin interface follows the device's light/dark preference. It does not
change the room display.

The timer shows a large remaining-time readout and a separate elapsed time,
with explicit running, paused, and result states. The remaining time is
highlighted when five minutes or less remain, with a stronger warning in the
last minute. Room controls label active, paused, off, and unavailable states;
the pause-timer button is disabled until a run starts and after it ends.

**Start timer** is disabled once a session has started, including while paused
and after finishing; reset it before starting another run. Duplicate starts are
also rejected by the server without changing the current timer or hints.
**Reset timer** checks the latest state and asks for confirmation while a run
is in progress (running or paused). Cancelling leaves the run unchanged.

Staff can delete individual entries under **Leaderboard** using the row's
**Delete** button and confirmation prompt. Deletion is permanent and updates
the completion statistics; it does not reset or otherwise change the current
room session. Previous teams and their results are shown on staff pages only,
not on the player screen.

### Screen layout editor

Open **Settings > Screen editor** (`/admin/screen-layout`) to drag and resize
the header, message, logo, timer, and hint area. Select a block to edit its
percentage position and size, font size, alignment, and visibility. The yellow
corner resizes the selected block; arrows move it, arrows on the corner resize
it, and Shift makes larger steps. Grid snapping is optional. Numeric controls
and keyboard editing remain available if pointer dragging is unsupported.

Choose stacked media/text, side-by-side, text-only, or media-only hints.
Text-only hints still show their text in media-only mode, and media hints
without captions remain visible in text-only mode. Fullscreen hints and
completion/failure screens retain their original presentation.

Edits stay in the local preview until **Save and apply layout** publishes them
to the player screen. **Cancel edits** restores the last saved design.
**Reset preview positions** resets the draft; it does not change the live
screen. **Use original default screen** disables custom positioning immediately,
without deleting the saved design or changing the timer, hints, or room settings.

The original layout is the default for existing and new installations. The
editor uses vanilla JavaScript, no media/image decoders or preview iframe,
and animation frames only while editing or resizing the preview. The player
loads only the small layout renderer/CSS, not the editor, and no extra polling
loop is added. The 16:9 preview uses placeholders and percentage-based positions;
check the actual target TV, especially if it has a different aspect ratio.
Use compressed images and Pi-compatible video resolutions; layout fallbacks
do not fix memory pressure caused by Chromium itself or oversized media.

Fallbacks for a Raspberry Pi 3 with 1 GB RAM:

- Open `/?layout=default` to force the original layout in that browser.
- Use **Use original default screen** from the editor, even if editor JavaScript
  cannot load. The form still works without JavaScript.
- Set `DISABLE_CUSTOM_LAYOUT=true` in the server environment and restart the app
  to force the original screen for all browsers while retaining saved designs.

Invalid saved layouts, missing layout scripts/CSS, or unavailable layout
capabilities fall back to the original screen; diagnostics are logged to the
server or browser console. Invalid stored layouts also show a warning in the
editor. Saving a valid design repairs that configuration.

Set the starting timer duration in **Settings > Customisation** using hours,
minutes, and seconds, then save the display settings. The default is 1 hour
(60 minutes); the duration must be at least 1 second, with minutes and seconds
between 0 and 59. The setting persists in SQLite and is used by manual and GPIO
starts. Saving a new duration leaves the current running, paused, or finished
session unchanged; resetting shows the saved duration for the next start.
The room display, automatic hints/failure, and results use the current run's
captured duration, including added time and penalties.

The display receives live updates for pauses and hints, with an uncached HTTP
refresh every five seconds as a fallback if the stream stalls or disconnects.
Refreshes do not overlap and time out after eight seconds; unchanged snapshots
do not reload media. The stream sends an initial snapshot, then waits for a
change or a 20-second heartbeat instead of repeatedly sending duplicate frames.
The staff live-preview iframe is lazy-loaded when opened, so an unused preview
does not consume another live connection and polling loop on the Pi.

For this built-in live-update broker, run one application worker. If the
application later needs multiple workers or multiple Pis, replace the broker
with a shared service such as Redis pub/sub.

## Production on Raspberry Pi (no port in the URL)

Use Gunicorn on **127.0.0.1:8080** behind NGINX on **port 80**. Browsers use
port 80 automatically for HTTP, so staff can open `http://<pi-ip-address>/admin`
and the display can open `http://<pi-ip-address>/` without entering a port.
Port 8080 alone would still require `:8080` in the browser.

Gunicorn is included in the Poetry dependencies on Unix platforms, not Windows. The
[Raspberry Pi deployment guide](RASPBERRY_PI_KIOSK.md) includes the production
systemd service, NGINX configuration, and kiosk startup URLs. Keep a single
application worker with threaded request handling for live-update streams.
This HTTP setup is for a trusted local network; use a VPN or configure HTTPS
before allowing access from an untrusted network.

Before enabling the service, verify `poetry run gunicorn --version` as the
`kiosk` user inside `/home/kiosk/escape-room-screen`. A missing executable
causes a restart loop and NGINX 502 responses; the guide includes a Poetry
repair for older checkouts. The main HTTP check, after configuring NGINX, is
`curl -I --max-time 10 http://127.0.0.1/`. Port 8080 is only the internal
backend and its optional diagnostic URL.

The X11 startup line uses `startx -- :0 -keeptty -nolisten tcp -nocursor`.
This permanently hides the kiosk pointer without a separate `unclutter`
process; staff browsers on other computers are unaffected.

## Sound and live preview

Use **Settings > Sounds** to save custom notification, completed-room and
failed-room audio. Without a custom file, the app uses a built-in tone.
Audio hint presets are separate files in **Settings > Hint library**.
The embedded **Open live preview** is deliberately silent; test sound on
the main player display, not a URL with `preview=1` or `preview=true`.

For Pi HDMI audio, find the actual device with `aplay -L` and test it as the
`kiosk` user. The guide's example is `hdmi:CARD=vc4hdmi,DEV=0`, not a universal
device name. Use the same working card in Chromium's `--alsa-output-device`
flag and both `.asoundrc` references (`slave.pcm` and `ctl.!default`).
Keep `--autoplay-policy=no-user-gesture-required` in the kiosk startup.
Stop any running speaker test before testing the app.

Changing `.xinitrc`, `.bash_profile` or `.asoundrc` requires restarting the
Chromium/X11 session, normally with a Pi reboot; restarting only the web
service does not apply those changes. The deployment guide includes privileged
file checks, timestamped audio-config backups and an existing-install repair.

## Admin appearance

Choose light or dark mode under **Settings**. The choice is stored in that
browser's local storage, not in the room database. Until you choose a mode,
the admin pages follow the device's system preference. Use a persistent
browser profile if the choice should survive closing Chromium; incognito
storage is discarded when its last window closes.

Staff pages include their theme initialization and admin stylesheet directly
in the HTML, before the page content. This avoids separate theme/style
downloads and keeps the old blue/yellow styling from becoming the fallback
when those downloads are delayed or fail on a busy Pi. The room display's
colours and styling are unchanged.

Restart the application after deploying code or changing admin theme assets,
then reload staff pages; the embedded assets are read once at app startup.

## Languages

English is the default language. Use the language selector on any rendered
page to choose a supported language; the choice is retained in that browser
session. Set `DEFAULT_LOCALE` to change the default when needed.

Catalogs live in `src/escape_room_screen/translations/`. To add a language, copy
`en.json` to a new locale code, translate every value, then add that code and
optionally its display name to `SUPPORTED_LOCALES` and `LOCALE_NAMES` in
`create_app`.

## Donation widget

The donation widget is shown by default. To hide it, including its external
scripts, set this environment variable before starting the app:

```bash
export HIDE_DONATIONS=true
```

Leave `HIDE_DONATIONS` unset or set it to `false` to show the widget. The value
`true` is case-insensitive and may have surrounding whitespace. Restart the
app after changing the setting.

## GPIO

The optional `GPIO_OUTPUTS` variable maps a friendly output name to a BCM GPIO
pin number. Each output gains On and Off controls in `/admin`:

```bash
export GPIO_OUTPUTS='{"door-light": 27, "buzzer": 23}'
```

To configure a room-complete input before opening the admin page, set
`GPIO_INPUTS` with the event name and BCM pin:

```bash
export GPIO_INPUTS='{"complete-room": 17}'
```

Mappings saved under **Admin > GPIO** take precedence over `GPIO_INPUTS`.
Use an unused GPIO such as BCM 17 (physical pin 11). Do not use BCM 2 or 3:
they are I2C pins with board pull-ups and may be claimed by the operating
system, preventing the application from receiving a button press.

The web **Toggle monitor power** button is temporarily hidden. The backend
and optional GPIO control remain available. On Raspberry Pi OS, monitor
control uses `vcgencmd display_power` to switch the kiosk HDMI output off or on.
The operation can be assigned to a physical GPIO button by adding
`display-toggle` to `GPIO_INPUTS`, for example:

```bash
export GPIO_INPUTS='{"complete-room": 17, "display-toggle": 22}'
```

Use this combined input assignment instead of the earlier input example,
not as a second environment entry. Keep input pins distinct from output pins
and check overlays before using any example number. **Pause room interaction**
in Admin and **Pause GPIO events** in Settings share one GPIO pause state.
Neither pauses the countdown nor turns off an active output; use the separate
timer control for the clock.

Gameplay inputs (**Complete room** and **Send preset**) are only accepted while
the timer is running, unpaused, and has time remaining. They are ignored before
starting, during a timer pause, and after resetting, completing, failing, or
running out of time. The room interaction button reflects this automatically;
resuming the timer re-enables gameplay unless interaction was manually paused.
Physical **Start timer** and **Toggle monitor power** inputs do not require a
running timer, but still respect the manual GPIO pause. Staff controls and
existing output states are unchanged.

The `vcgencmd` command must be available to the account running the app for
GPIO monitor control to work.
On current Raspberry Pi OS Trixie and updated Bookworm, install it with
`sudo apt install -y raspi-utils-core`. The older `libraspberrypi-bin`
package is unavailable on Trixie.

GPIO Zero controls the pins on Raspberry Pi OS. On a development computer,
the app logs that physical GPIO is unavailable and continues without touching
hardware. GPIO uses 3.3V logic only; use suitable interface hardware for
relays, motors, or other higher-voltage devices.

On Raspberry Pi OS, install the GPIO pin driver before installing/running the
Poetry project:

```bash
sudo apt install python3-lgpio
```

Use **Admin > GPIO** to link a BCM-numbered input pin to the **Complete room**
event. The page can pause all mapped GPIO events before a pin is pressed; a
paused or invalid trigger is recorded as ignored instead of completing the
room. The home screen displays the recent GPIO activity.

## Test

```bash
poetry run python -m unittest discover -s tests -v
```

For the client-side timer, theme, and screen editor checks, using Node.js:

```bash
node --test tests/*.test.cjs
```

## Raspberry Pi deployment

For the complete Raspberry Pi OS Lite installation, systemd service, Chromium
kiosk, GPIO, audio, and troubleshooting instructions, see
[RASPBERRY_PI_KIOSK.md](RASPBERRY_PI_KIOSK.md).
