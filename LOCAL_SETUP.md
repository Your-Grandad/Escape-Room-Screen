# Running Escape Room Screen on Windows and Linux

This guide runs the application as a local Flask server for development,
testing, or a non-Raspberry Pi display. Physical GPIO and Raspberry Pi monitor
power controls are unavailable on standard Windows and Linux computers, but
the screen, admin panel, timer, hints, sounds, and settings continue to work.

## Requirements

- Python 3.11 or newer
- Git
- Poetry 2.x

The examples use HTTPS to clone the repository. You can use the SSH URL
instead if your GitHub SSH key is already configured.

## Windows

### 1. Install the tools

Install Python from [python.org](https://www.python.org/downloads/windows/)
and select **Add Python to PATH** during installation. Install Git from
[git-scm.com](https://git-scm.com/download/win).

Open a new PowerShell window and install Poetry through `pipx`:

```powershell
py -m pip install --user pipx
py -m pipx ensurepath
```

Close and reopen PowerShell so the updated `PATH` is loaded, then run:

```powershell
pipx install poetry
python --version
poetry --version
```

### 2. Clone and install the application

```powershell
git clone https://github.com/Your-Grandad/Escape-Room-Screen.git
Set-Location Escape-Room-Screen
poetry install
```

### 3. Configure and start the server

Environment variables set this way last only for the current PowerShell
window:

```powershell
$env:SECRET_KEY = py -c "import secrets; print(secrets.token_urlsafe(32))"
$env:ADMIN_PASSWORD = "replace-with-a-long-unique-password"
poetry run flask --app escape_room_screen.app:create_app run --host=0.0.0.0 --port=5000
```

If Windows asks whether Flask may communicate through the firewall, allow
access only on trusted private networks.

## Linux

### 1. Install the tools

On Debian or Ubuntu:

```bash
sudo apt update
sudo apt install -y git pipx python3 python3-venv
pipx ensurepath
```

Open a new terminal so the updated `PATH` is loaded, then run:

```bash
pipx install poetry
python3 --version
poetry --version
```

If `python3 --version` is older than 3.11, install a supported Python version
using your distribution's packages or [pyenv](https://github.com/pyenv/pyenv).

### 2. Clone and install the application

```bash
git clone https://github.com/Your-Grandad/Escape-Room-Screen.git
cd Escape-Room-Screen
poetry install
```

### 3. Configure and start the server

Environment variables exported this way last only for the current terminal:

```bash
export SECRET_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export ADMIN_PASSWORD="replace-with-a-long-unique-password"
poetry run flask --app escape_room_screen.app:create_app run --host=0.0.0.0 --port=5000
```

## Open the application

Keep the terminal running, then open:

- Display: <http://127.0.0.1:5000/>
- Admin panel: <http://127.0.0.1:5000/admin>

To use another device on the same network, replace `127.0.0.1` with the
server computer's local IP address. Use `ipconfig` on Windows or `hostname -I`
on Linux to find it. The `0.0.0.0` server binding allows network access; use
`--host=127.0.0.1` instead if the application should remain accessible only
from the same computer.

Press `Ctrl+C` in the server terminal to stop the application.

Sign in initially with username `admin` and the configured `ADMIN_PASSWORD`.
This account is the superuser and can create, reset, and delete standard
users under **Settings > Users**. Standard users can use all room controls and
settings but cannot manage accounts. Each user's changed password is stored
securely in the local database; the `admin` user's stored password takes
precedence over the `ADMIN_PASSWORD` environment variable.

## Local data

Settings, statistics, and uploaded sounds are stored under `src/instance/`.
That directory is ignored by Git. Back it up before replacing the checkout if
you need to preserve local application data.

## Troubleshooting

### `poetry` is not recognized or not found

Close and reopen the terminal after `pipx ensurepath`. If the command remains
unavailable, run `pipx list` and follow the displayed `PATH` instructions.

### Port 5000 is already in use

Start the application on another port:

```text
poetry run flask --app escape_room_screen.app:create_app run --host=0.0.0.0 --port=5001
```

Then use `http://127.0.0.1:5001/`.

### GPIO warnings appear

Warnings that GPIO hardware is unavailable are expected on Windows and
non-Raspberry Pi Linux computers. They do not prevent the web application
from running.

## Raspberry Pi

For GPIO support, automatic startup, Chromium kiosk mode, HDMI audio, and
monitor controls, use [RASPBERRY_PI_KIOSK.md](RASPBERRY_PI_KIOSK.md).
