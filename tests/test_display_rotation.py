from contextlib import closing
import os
from pathlib import Path
import subprocess
import sqlite3
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from escape_room_screen import create_app
from escape_room_screen.database import connect, initialize
from escape_room_screen.display_rotation import DisplayRotationController, ROTATIONS, main


class DisplayRotationTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.database = Path(self.folder.name) / "screen.db"
        initialize(self.database)
        self.command_patch = patch("escape_room_screen.display_rotation.shutil.which", return_value="/usr/bin/xrandr")
        self.command_patch.start()
        self.addCleanup(self.command_patch.stop)
        self.environment_patch = patch.dict(os.environ, {"DISPLAY": ":0"})
        self.environment_patch.start()
        self.addCleanup(self.environment_patch.stop)
        self.controller = DisplayRotationController(self.database, "HDMI-1")
        self.connected = subprocess.CompletedProcess(
            [], 0, "HDMI-1 connected primary 1920x1080+0+0 (normal left inverted right x axis y axis)\n"
        )

    def test_each_rotation_is_applied_and_persists_across_initialization(self):
        for rotation, mode in ROTATIONS.items():
            with self.subTest(rotation=rotation), patch(
                "escape_room_screen.display_rotation.subprocess.run",
                side_effect=[self.connected, subprocess.CompletedProcess([], 0, "")],
            ) as run:
                self.controller.apply(rotation)
                run.assert_called_with(
                    ["/usr/bin/xrandr", "--output", "HDMI-1", "--rotate", mode],
                    check=True, capture_output=True, text=True, timeout=10,
                )
                initialize(self.database)
                self.assertEqual(
                    DisplayRotationController(self.database, "HDMI-1").saved_rotation, rotation
                )

    def test_restore_does_not_write_database_or_change_player_rotation(self):
        with closing(connect(self.database)) as connection:
            connection.execute("UPDATE hdmi_rotation SET rotation = 180 WHERE id = 1")
            connection.execute("UPDATE display_settings SET screen_rotation = 90 WHERE id = 1")
            connection.commit()
        with patch("escape_room_screen.display_rotation.subprocess.run", return_value=self.connected):
            self.controller.apply(self.controller.saved_rotation, persist=False)
        with closing(connect(self.database)) as connection:
            self.assertEqual(connection.execute("SELECT screen_rotation FROM display_settings").fetchone()[0], 90)
        self.assertEqual(self.controller.saved_rotation, 180)

    def test_command_failure_and_timeout_do_not_save_rotation(self):
        for error in (
            subprocess.CalledProcessError(1, ["xrandr"]),
            subprocess.TimeoutExpired(["xrandr"], 10),
        ):
            with self.subTest(error=type(error)), patch(
                "escape_room_screen.display_rotation.subprocess.run",
                side_effect=[self.connected, error],
            ):
                with self.assertRaises(type(error)):
                    self.controller.apply(180)
                self.assertEqual(self.controller.saved_rotation, 0)

    def test_disconnected_or_unsupported_output_is_rejected_before_rotation(self):
        for output in (
            "HDMI-1 disconnected (normal left inverted right x axis y axis)",
            "HDMI-2 connected 1920x1080+0+0 (normal left inverted right x axis y axis)",
            "HDMI-1 connected 1920x1080+0+0 (normal)",
        ):
            with self.subTest(output=output), patch(
                "escape_room_screen.display_rotation.subprocess.run",
                return_value=subprocess.CompletedProcess([], 0, output),
            ) as run:
                with self.assertRaises(RuntimeError):
                    self.controller.apply(180)
                self.assertEqual(run.call_count, 1)
                self.assertEqual(self.controller.saved_rotation, 0)

    def test_invalid_rotation_never_runs_a_command(self):
        for rotation in (True, 45, "180", None, 180.0):
            with self.subTest(rotation=rotation), patch(
                "escape_room_screen.display_rotation.subprocess.run"
            ) as run:
                with self.assertRaises(ValueError):
                    self.controller.apply(rotation)
                run.assert_not_called()

    def test_commit_failure_restores_previous_physical_orientation(self):
        actual = connect(self.database)
        connection = MagicMock(wraps=actual)
        connection.commit.side_effect = sqlite3.OperationalError("disk full")
        query = subprocess.CompletedProcess(
            [], 0, "HDMI-1 connected primary 1080x1920+0+0 left (normal left inverted right x axis y axis)"
        )
        with patch.object(self.controller, "_current_rotation", return_value="left"), patch(
            "escape_room_screen.display_rotation.connect", return_value=connection
        ), patch("escape_room_screen.display_rotation.subprocess.run", return_value=query) as run:
            with self.assertRaises(sqlite3.OperationalError):
                self.controller.apply(180)
            self.assertEqual(run.call_args_list[-1].args[0][-1], "left")
        self.assertEqual(self.controller.saved_rotation, 0)

    def test_startup_command_applies_saved_orientation(self):
        with closing(connect(self.database)) as connection:
            connection.execute("UPDATE hdmi_rotation SET rotation = 180 WHERE id = 1")
            connection.commit()
        with patch("sys.argv", ["display_rotation", "--database", str(self.database), "--output", "HDMI-1"]), patch(
            "escape_room_screen.display_rotation.subprocess.run", return_value=self.connected
        ) as run:
            main()
            self.assertEqual(run.call_args.args[0][-1], "inverted")
        self.assertEqual(self.controller.saved_rotation, 180)

    def test_configuration_is_opt_in_and_needs_display_and_xrandr(self):
        self.assertFalse(DisplayRotationController(self.database, "").available)
        with patch.dict(os.environ, {"DISPLAY": ""}):
            self.assertFalse(self.controller.available)
        with patch("escape_room_screen.display_rotation.shutil.which", return_value=None):
            self.assertFalse(DisplayRotationController(self.database, "HDMI-1").available)
        with self.assertRaises(ValueError):
            DisplayRotationController(self.database, "--help")

    def app_client(self):
        app = create_app({
            "TESTING": True, "SECRET_KEY": "test", "ADMIN_PASSWORD": "test-password",
            "DATABASE": str(self.database), "UPLOAD_FOLDER": str(Path(self.folder.name) / "uploads"),
            "GPIO_OUTPUTS": {}, "GPIO_INPUTS": {}, "HDMI_ROTATION_OUTPUT": "HDMI-1",
        })
        self.addCleanup(app.extensions["gpio"].close)
        self.addCleanup(app.extensions["display_runtime"].cancel_timer_events)
        client = app.test_client()
        client.post("/admin/login", data={"username": "admin", "password": "test-password"})
        with client.session_transaction() as session:
            csrf = session["csrf_token"]
        return app, client, csrf

    def test_route_requires_authentication_and_csrf(self):
        app, client, csrf = self.app_client()
        with patch.object(app.extensions["display_rotation"], "apply") as apply:
            self.assertEqual(app.test_client().post("/admin/display/rotation", json={"rotation": 180}).status_code, 401)
            self.assertEqual(client.post("/admin/display/rotation", json={"rotation": 180}).status_code, 400)
            apply.assert_not_called()

    def test_route_applies_json_and_form_without_changing_player_rotation(self):
        app, client, csrf = self.app_client()
        with patch("escape_room_screen.display_rotation.subprocess.run", return_value=self.connected):
            response = client.post("/admin/display/rotation", json={"rotation": 180}, headers={"X-CSRF-Token": csrf})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json(), {"hdmi_rotation": 180})
            self.assertEqual(app.extensions["display_store"].get().screen_rotation, 0)
            self.assertEqual(client.post("/admin/display/rotation", data={"rotation": "0", "csrf_token": csrf}).status_code, 302)
            self.assertEqual(self.controller.saved_rotation, 0)
        body = client.get("/admin/settings").get_data(as_text=True)
        self.assertIn('action="/admin/display/rotation"', body)
        self.assertIn("Raspberry Pi HDMI rotation", body)

    def test_route_validation_and_hardware_errors_are_explicit(self):
        app, client, csrf = self.app_client()
        for rotation in (True, 45, "180; reboot", 180.0, None):
            with self.subTest(rotation=rotation):
                response = client.post("/admin/display/rotation", json={"rotation": rotation}, headers={"X-CSRF-Token": csrf})
                self.assertEqual(response.status_code, 400)
        with patch.object(app.extensions["display_rotation"], "apply", side_effect=RuntimeError("private diagnostic")), patch.object(app.logger, "exception") as log:
            response = client.post("/admin/display/rotation", json={"rotation": 180}, headers={"X-CSRF-Token": csrf})
            self.assertEqual(response.status_code, 503)
            self.assertNotIn("private diagnostic", response.get_json()["error"])
            log.assert_called_once()
            response = client.post("/admin/display/rotation", data={"rotation": "180", "csrf_token": csrf})
            self.assertEqual(response.status_code, 503)
            self.assertIn(b"Unable to rotate the HDMI display", response.data)
