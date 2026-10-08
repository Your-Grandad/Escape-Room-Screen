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

Set the starting timer duration in **Settings > Customisation** using hours,
minutes, and seconds, then save the display settings. The default is 1 hour
(60 minutes); the duration must be at least 1 second, with minutes and seconds
between 0 and 59. The setting persists in SQLite and is used by manual and GPIO
starts. Saving a new duration leaves the current running, paused, or finished
session unchanged; resetting shows the saved duration for the next start.
The room display, automatic hints/failure, and results use the current run's
captured duration, including added time and penalties.

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

For the client-side timer and theme checks, using Node.js:

```bash
node --test tests/admin-ui.test.cjs
```

## Raspberry Pi deployment

For the complete Raspberry Pi OS Lite installation, systemd service, Chromium
kiosk, GPIO, audio, and troubleshooting instructions, see
[RASPBERRY_PI_KIOSK.md](RASPBERRY_PI_KIOSK.md).
