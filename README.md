# Escape Room Screen

Fullscreen, browser-based escape-room display for a Raspberry Pi. The
connected display shows the room screen at `/`; staff can use `/admin` from
another device on the same network to control it in real time.

## Install and run

Clone the repository and install its Poetry environment:

```bash
git clone git@github.com:Your-Grandad/Escape-Room-Screen.git
cd Escape-Room-Screen
poetry install
```

For complete platform-specific instructions, see
[Running on Windows and Linux](LOCAL_SETUP.md). For a dedicated Raspberry Pi
kiosk, see [Raspberry Pi deployment](RASPBERRY_PI_KIOSK.md).

Set a unique Flask signing key and the admin password, then start the app:

```bash
export SECRET_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
export ADMIN_PASSWORD="choose-a-strong-password"
poetry run flask --app escape_room_screen.app:create_app run --host=0.0.0.0
```

`ADMIN_PASSWORD` supplies the initial password for the `admin` superuser.
Sign in with username `admin`. The superuser can create standard users under
**Settings > Users**; standard users can use all room controls and settings
but cannot manage accounts. Each user can replace their own password under
**Settings > Change admin password**. Passwords are securely hashed in the
application database, persist across restarts, and password changes sign out
that user's existing sessions.

Open `http://<pi-address>:5000/` in Chromium's kiosk mode on the Pi. Browse to
`http://<pi-address>:5000/admin` from an authorised device to log in and alter
the title, message, and colours. Changes are stored in SQLite and pushed to
the display through Server-Sent Events without refreshing the page.

For this built-in live-update broker, run one application worker. If the
application later needs multiple workers or multiple Pis, replace the broker
with a shared service such as Redis pub/sub.

## Languages

English is the default language. Use the language selector on any rendered
page to choose a supported language; the choice is retained in that browser
session. Set `DEFAULT_LOCALE` to change the default when needed.

Catalogs live in `src/escape_room_screen/translations/`. To add a language, copy
`en.json` to a new locale code, translate every value, then add that code and
optionally its display name to `SUPPORTED_LOCALES` and `LOCALE_NAMES` in
`create_app`.

## GPIO

The optional `GPIO_OUTPUTS` variable maps a friendly output name to a BCM GPIO
pin number. Each output gains On and Off controls in `/admin`:

```bash
export GPIO_OUTPUTS='{"door-light": 17, "buzzer": 27}'
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

The admin controls include a **Toggle monitor power** button. On Raspberry Pi
OS, it uses `vcgencmd display_power` to switch the kiosk HDMI output off or on.
The same operation can be assigned to a physical GPIO button by adding
`display-toggle` to `GPIO_INPUTS`, for example:

```bash
export GPIO_INPUTS='{"display-toggle": 17}'
```

The `vcgencmd` command must be available to the account running the app. The
web button is disabled on hosts where it is not installed.

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

## Raspberry Pi deployment

For the complete Raspberry Pi OS Lite installation, systemd service, Chromium
kiosk, GPIO, audio, and troubleshooting instructions, see
[RASPBERRY_PI_KIOSK.md](RASPBERRY_PI_KIOSK.md).
