import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from threading import TIMEOUT_MAX
from unittest.mock import MagicMock, patch

from gpiozero import Device
from gpiozero.pins.mock import MockFactory

from escape_room_screen import create_app
from escape_room_screen.database import connect, initialize
from escape_room_screen.gpio import GpioController


class GpioSignalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.factory = MockFactory()
        factory_patch = patch.object(Device, "pin_factory", self.factory)
        factory_patch.start()
        self.addCleanup(factory_patch.stop)
        self.controller = GpioController(output_pins={"light": 17})
        self.addCleanup(self.controller.close)
        timer_patch = patch("escape_room_screen.gpio.Timer")
        self.timer = timer_patch.start()
        self.addCleanup(timer_patch.stop)

    def test_toggle_uses_the_live_pin_state_for_named_and_direct_outputs(self) -> None:
        for target, pin in (("light", 17), (18, 18)):
            with self.subTest(target=target):
                self.assertTrue(self.controller.send_signal(target, "toggle"))
                self.assertTrue(self.factory.pin(pin).state)
                self.assertFalse(self.controller.send_signal(target, "toggle"))
                self.controller.send_signal(target, "on")
                self.assertFalse(self.controller.send_signal(target, "toggle"))
                self.assertFalse(self.factory.pin(pin).state)

    def test_timed_output_turns_on_then_off_at_the_requested_duration(self) -> None:
        for target, pin in (("light", 17), (18, 18)):
            with self.subTest(target=target):
                self.assertTrue(self.controller.send_signal(target, "timed", 10))
                seconds, callback = self.timer.call_args.args
                self.assertEqual(seconds, 10)
                self.assertTrue(self.timer.return_value.daemon)
                self.timer.return_value.start.assert_called()
                self.assertTrue(self.factory.pin(pin).state)
                callback()
                self.assertFalse(self.factory.pin(pin).state)

    def test_retrigger_restarts_countdown_and_ignores_stale_callbacks(self) -> None:
        first, second = MagicMock(), MagicMock()
        self.timer.side_effect = [first, second]
        self.controller.send_signal(18, "timed", 5)
        old_callback = self.timer.call_args.args[1]
        self.controller.send_signal(18, "timed", 20)
        new_callback = self.timer.call_args.args[1]
        first.cancel.assert_called_once()
        self.assertEqual(self.timer.call_args.args[0], 20)
        old_callback()
        self.assertTrue(self.factory.pin(18).state)
        new_callback()
        self.assertFalse(self.factory.pin(18).state)

    def test_manual_commands_cancel_auto_off_for_both_target_types(self) -> None:
        for target, pin in (("light", 17), (18, 18)):
            for state in ("on", "off", "toggle"):
                with self.subTest(target=target, state=state):
                    self.timer.return_value = MagicMock()
                    self.controller.send_signal(target, "timed", 10)
                    callback = self.timer.call_args.args[1]
                    self.controller.send_signal(target, state)
                    self.timer.return_value.cancel.assert_called_once()
                    callback()
                    self.assertEqual(self.factory.pin(pin).state, state == "on")

    def test_legacy_controls_also_cancel_timed_signals(self) -> None:
        for target, command, pin in (
            ("light", self.controller.activate, 17),
            ("light", self.controller.deactivate, 17),
            (18, self.controller.activate_pin, 18),
            (18, self.controller.deactivate_pin, 18),
        ):
            with self.subTest(command=command):
                self.timer.return_value = MagicMock()
                self.controller.send_signal(target, "timed", 5)
                callback = self.timer.call_args.args[1]
                command(target)
                expected = self.factory.pin(pin).state
                self.timer.return_value.cancel.assert_called_once()
                callback()
                self.assertEqual(self.factory.pin(pin).state, expected)

    def test_different_pins_have_independent_countdowns(self) -> None:
        self.timer.side_effect = [MagicMock(), MagicMock()]
        self.controller.send_signal(18, "timed", 3)
        first_callback = self.timer.call_args.args[1]
        self.controller.send_signal(19, "timed", 7)
        second_callback = self.timer.call_args.args[1]
        first_callback()
        self.assertFalse(self.factory.pin(18).state)
        self.assertTrue(self.factory.pin(19).state)
        second_callback()
        self.assertFalse(self.factory.pin(19).state)

    def test_release_and_close_cancel_callbacks_before_devices_are_closed(self) -> None:
        self.controller.send_signal(18, "timed", 5)
        callback = self.timer.call_args.args[1]
        self.controller.release_pin(18)
        self.timer.return_value.cancel.assert_called_once()
        callback()
        self.controller.send_signal(18, "on")
        callback()
        self.assertTrue(self.factory.pin(18).state)
        self.timer.return_value = MagicMock()
        self.controller.send_signal("light", "timed", 5)
        callback = self.timer.call_args.args[1]
        self.controller.close()
        self.timer.return_value.cancel.assert_called_once()
        callback()

    def test_invalid_timed_command_does_not_change_an_active_output(self) -> None:
        self.controller.send_signal(18, "timed", 10)
        callback = self.timer.call_args.args[1]
        with self.assertRaises(ValueError):
            self.controller.send_signal(18, "timed", 0)
        self.timer.return_value.cancel.assert_not_called()
        callback()
        self.assertFalse(self.factory.pin(18).state)

    def test_auto_off_hardware_errors_are_logged(self) -> None:
        self.controller.send_signal("light", "timed", 5)
        callback = self.timer.call_args.args[1]
        with (
            patch("gpiozero.OutputDevice.off", side_effect=OSError("test failure")),
            self.assertLogs("escape_room_screen.gpio", level="ERROR") as logs,
        ):
            callback()
        self.assertIn("Failed to turn off timed GPIO output BCM 17", logs.output[0])

    def test_failure_to_start_countdown_switches_the_output_back_off(self) -> None:
        self.timer.return_value.start.side_effect = RuntimeError("test failure")
        with self.assertRaises(RuntimeError):
            self.controller.send_signal(18, "timed", 5)
        self.assertFalse(self.factory.pin(18).state)
        self.timer.call_args.args[1]()
        self.assertFalse(self.factory.pin(18).state)


class GpioSignalRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.factory = MockFactory()
        factory_patch = patch.object(Device, "pin_factory", self.factory)
        factory_patch.start()
        self.addCleanup(factory_patch.stop)
        self.database = Path(self.directory.name) / "screen.db"
        self.app = create_app({
            "TESTING": True,
            "SECRET_KEY": "test-secret",
            "ADMIN_PASSWORD": "test-password",
            "DATABASE": str(self.database),
            "UPLOAD_FOLDER": str(Path(self.directory.name) / "uploads"),
            "GPIO_OUTPUTS": {"light": 17},
            "GPIO_INPUTS": {"complete-room": 23},
        })
        self.addCleanup(self.app.extensions["gpio"].close)
        self.addCleanup(self.app.extensions["display_runtime"].cancel_timer_events)
        self.store = self.app.extensions["display_store"]
        self.client = self.app.test_client()
        self.client.post("/admin/login", data={"username": "admin", "password": "test-password"})
        with self.client.session_transaction() as session:
            self.csrf = session["csrf_token"]
        timer_patch = patch("escape_room_screen.gpio.Timer")
        self.timer = timer_patch.start()
        self.addCleanup(timer_patch.stop)

    def create_action(self, title: str, state: str, **values: object) -> int:
        response = self.client.post("/admin/gpio/actions", data={
            "csrf_token": self.csrf, "title": title, "pin": "18", "state": state, **values,
        })
        self.assertEqual(response.status_code, 302)
        return self.store.get_gpio_output_actions()[-1].id

    def trigger(self, action_id: int):
        return self.client.post(
            f"/admin/gpio/actions/{action_id}/trigger",
            headers={"X-CSRF-Token": self.csrf},
        )

    def test_toggle_button_alternates_and_other_buttons_can_share_an_active_pin(self) -> None:
        action_id = self.create_action("Toggle light", "toggle")
        first = self.trigger(action_id)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.get_json()["state"], "on")
        self.assertTrue(self.factory.pin(18).state)
        off_id = self.create_action("Light off", "off")
        self.assertEqual(self.trigger(off_id).get_json()["state"], "off")
        self.assertEqual(self.trigger(action_id).get_json()["state"], "on")
        self.assertEqual(self.trigger(action_id).get_json()["state"], "off")
        self.assertFalse(self.factory.pin(18).state)

    def test_timed_settings_persist_render_and_trigger_automatic_off(self) -> None:
        action_id = self.create_action("Light briefly", "timed", duration_seconds="10")
        initialize(self.database)
        action = self.store.get_gpio_output_action(action_id)
        self.assertEqual(action.duration_seconds, 10)
        self.assertEqual(action.state, "timed")
        for path in ("/admin/gpio", "/admin"):
            page = self.client.get(path)
            self.assertIn(b"Timed on, then off", page.data)
            self.assertIn(b"10 seconds", page.data)
        response = self.trigger(action_id)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["state"], "on")
        self.assertEqual(response.get_json()["signal"], "timed")
        self.assertEqual(response.get_json()["duration_seconds"], 10)
        self.assertTrue(self.factory.pin(18).state)
        self.assertEqual(self.timer.call_args.args[0], 10)
        self.timer.call_args.args[1]()
        self.assertFalse(self.factory.pin(18).state)

    def test_named_output_actions_support_toggle_and_timed_signals(self) -> None:
        toggle_id = self.create_action(
            "Named toggle", "toggle", output_name="light", label="Named toggle",
        )
        self.assertEqual(self.trigger(toggle_id).get_json()["state"], "on")
        self.assertEqual(self.trigger(toggle_id).get_json()["state"], "off")
        timed_id = self.create_action(
            "Named timed", "timed", output_name="light", label="Named timed",
            duration_seconds="3",
        )
        self.assertEqual(self.trigger(timed_id).get_json()["duration_seconds"], 3)
        self.assertTrue(self.factory.pin(17).state)
        self.timer.call_args.args[1]()
        self.assertFalse(self.factory.pin(17).state)

    def test_existing_named_on_control_cancels_a_timed_action(self) -> None:
        action_id = self.create_action(
            "Named timed", "timed", output_name="light", duration_seconds="5",
        )
        self.trigger(action_id)
        callback = self.timer.call_args.args[1]
        response = self.client.post(
            "/admin/gpio/light/on", headers={"X-CSRF-Token": self.csrf},
        )
        self.assertEqual(response.status_code, 200)
        self.timer.return_value.cancel.assert_called_once()
        callback()
        self.assertTrue(self.factory.pin(17).state)

    def test_invalid_durations_and_signals_are_rejected_without_saving(self) -> None:
        for value in ("", "0", "-1", "1.5", "nan", "abc", str(int(TIMEOUT_MAX) + 1)):
            with self.subTest(value=value):
                response = self.client.post("/admin/gpio/actions", data={
                    "csrf_token": self.csrf, "title": "Invalid", "pin": "18",
                    "state": "timed", "duration_seconds": value,
                })
                self.assertEqual(response.status_code, 400)
                self.assertIn(b"positive whole number of seconds", response.data)
        self.assertEqual(self.store.get_gpio_output_actions(), [])
        action_id = self.create_action("Untimed", "on", duration_seconds="invalid")
        self.assertIsNone(self.store.get_gpio_output_action(action_id).duration_seconds)

    def test_timed_and_toggle_controls_require_authentication_and_csrf(self) -> None:
        for state in ("toggle", "timed"):
            action_id = self.create_action(state, state, duration_seconds="5")
            url = f"/admin/gpio/actions/{action_id}/trigger"
            self.assertEqual(self.client.post(url).status_code, 400)
            self.assertEqual(self.app.test_client().post(url).status_code, 401)
        self.assertFalse(self.factory.pin(18).state)
        self.timer.assert_not_called()

    def test_deleting_last_action_releases_pin_and_cancels_timer(self) -> None:
        timed_id = self.create_action("Timed", "timed", duration_seconds="5")
        off_id = self.create_action("Off", "off")
        self.trigger(timed_id)
        callback = self.timer.call_args.args[1]
        url = "/admin/gpio/actions/{}/delete"
        self.client.post(url.format(off_id), data={"csrf_token": self.csrf})
        self.timer.return_value.cancel.assert_not_called()
        self.client.post(url.format(timed_id), data={"csrf_token": self.csrf})
        self.timer.return_value.cancel.assert_called_once()
        callback()
        self.assertFalse(self.factory.pin(18).state)

    def test_hardware_failure_returns_an_explicit_error(self) -> None:
        action_id = self.create_action("Toggle", "toggle")
        with (
            patch("gpiozero.OutputDevice.toggle", side_effect=OSError("test failure")),
            self.assertLogs(self.app.logger, level="ERROR"),
        ):
            response = self.trigger(action_id)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json(), {"error": "Failed to control GPIO output."})

    def test_admin_completion_toggles_bcm_9_and_16_once_per_room(self) -> None:
        for pin in (9, 16):
            self.create_action(
                f"Finish light {pin}", "toggle", pin=str(pin), trigger="room-complete",
            )
        manual_id = self.create_action("Manual only", "toggle")
        self.store.start_timer()
        for _ in range(2):
            response = self.client.post(
                "/admin/complete", headers={"X-CSRF-Token": self.csrf},
            )
            self.assertEqual(response.status_code, 200)
            self.assertIsNotNone(response.get_json()["room_completed_at"])
            self.assertTrue(self.factory.pin(9).state)
            self.assertTrue(self.factory.pin(16).state)
            self.assertFalse(self.factory.pin(18).state)
        self.store.reset_timer()
        self.store.start_timer()
        self.client.post("/admin/complete", headers={"X-CSRF-Token": self.csrf})
        self.assertFalse(self.factory.pin(9).state)
        self.assertFalse(self.factory.pin(16).state)
        self.assertEqual(self.trigger(manual_id).get_json()["state"], "on")

    def test_physical_bcm_23_completion_runs_both_outputs_and_keeps_input_gates(self) -> None:
        runtime = self.app.extensions["display_runtime"]
        self.store.add_gpio_mapping("23", "complete-room")
        runtime.configure_gpio_inputs()
        for pin in (9, 16):
            self.create_action(
                f"Finish light {pin}", "toggle", pin=str(pin), trigger="room-complete",
            )
        runtime.handle_gpio_event(23, "complete-room")
        self.assertFalse(self.store.get_gpio_activity()[1][0].accepted)
        self.store.start_timer()
        self.store.set_gpio_paused(True)
        runtime.handle_gpio_event(23, "complete-room")
        self.assertFalse(self.store.get_gpio_activity()[1][0].accepted)
        self.store.set_gpio_paused(False)
        self.store.toggle_timer_paused()
        runtime.handle_gpio_event(23, "complete-room")
        self.assertFalse(self.store.get_gpio_activity()[1][0].accepted)
        self.assertFalse(self.factory.pin(9).state)
        self.assertFalse(self.factory.pin(16).state)
        self.store.toggle_timer_paused()
        self.factory.pin(23).drive_low()
        self.assertIsNotNone(self.store.get().room_completed_at)
        self.assertTrue(self.store.get_gpio_activity()[1][0].accepted)
        self.assertTrue(self.factory.pin(9).state)
        self.assertTrue(self.factory.pin(16).state)
        self.factory.pin(23).drive_high()
        self.factory.pin(23).drive_low()
        self.assertFalse(self.store.get_gpio_activity()[1][0].accepted)
        self.assertTrue(self.factory.pin(9).state)
        self.assertTrue(self.factory.pin(16).state)

    def test_legacy_gpio_input_also_runs_completion_outputs(self) -> None:
        self.create_action("Finish light", "toggle", pin="9", trigger="room-complete")
        self.assertEqual(self.store.get_gpio_mappings(), [])
        self.store.start_timer()
        self.factory.pin(23).drive_low()
        self.assertTrue(self.factory.pin(9).state)
        self.assertIsNotNone(self.store.get().room_completed_at)
        self.assertTrue(self.store.get_gpio_activity()[1][0].accepted)

    def test_concurrent_completion_requests_do_not_toggle_outputs_twice(self) -> None:
        self.create_action("Finish light", "toggle", pin="9", trigger="room-complete")
        self.store.start_timer()
        runtime = self.app.extensions["display_runtime"]
        with (
            patch.object(runtime.gpio, "send_signal", wraps=runtime.gpio.send_signal) as signal,
            ThreadPoolExecutor(max_workers=4) as pool,
        ):
            results = list(pool.map(lambda _: runtime.complete_room(), range(4)))
        signal.assert_called_once_with(9, "toggle", None)
        self.assertTrue(self.factory.pin(9).state)
        self.assertTrue(all(settings.room_completed_at for settings, _failures in results))

    def test_completion_uses_on_off_and_timed_signals_for_named_and_direct_outputs(self) -> None:
        self.create_action("On", "on", pin="9", trigger="room-complete")
        self.create_action("Off", "off", pin="16", trigger="room-complete")
        self.create_action(
            "Timed", "timed", output_name="light", duration_seconds="5",
            trigger="room-complete",
        )
        self.app.extensions["gpio"].activate_pin(16)
        self.store.start_timer()
        response = self.client.post("/admin/complete", headers={"X-CSRF-Token": self.csrf})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(self.factory.pin(9).state)
        self.assertFalse(self.factory.pin(16).state)
        self.assertTrue(self.factory.pin(17).state)
        self.assertEqual(self.timer.call_args.args[0], 5)
        self.timer.call_args.args[1]()
        self.assertFalse(self.factory.pin(17).state)

    def test_existing_actions_can_be_changed_to_automatic_and_back_without_recreation(self) -> None:
        action_id = self.create_action("Finish light", "toggle", pin="9")
        self.assertEqual(self.store.get_gpio_output_action(action_id).trigger, "manual")
        url = f"/admin/gpio/actions/{action_id}/trigger-setting"
        for trigger in ("room-complete", "manual"):
            response = self.client.post(url, data={"csrf_token": self.csrf, "trigger": trigger})
            self.assertEqual(response.status_code, 302)
            initialize(self.database)
            action = self.store.get_gpio_output_action(action_id)
            self.assertEqual(action.trigger, trigger)
            self.assertEqual(action.pin, 9)
            self.assertEqual(action.state, "toggle")
            page = self.client.get("/admin/gpio")
            self.assertIn(f'value="{trigger}" selected'.encode(), page.data)
        self.store.start_timer()
        self.client.post("/admin/complete", headers={"X-CSRF-Token": self.csrf})
        self.assertFalse(self.factory.pin(9).state)

    def test_automatic_trigger_settings_require_valid_values_authentication_and_csrf(self) -> None:
        action_id = self.create_action("Finish light", "toggle", pin="9")
        url = f"/admin/gpio/actions/{action_id}/trigger-setting"
        data = {"trigger": "room-complete", "csrf_token": self.csrf}
        self.assertEqual(self.app.test_client().post(url, data=data).status_code, 401)
        self.assertEqual(self.client.post(url, data={"trigger": "room-complete"}).status_code, 400)
        self.assertEqual(self.client.post(url, data={**data, "trigger": "invalid"}).status_code, 400)
        self.assertEqual(self.client.post(
            "/admin/gpio/actions/999/trigger-setting", data=data,
        ).status_code, 404)
        self.assertEqual(self.store.get_gpio_output_action(action_id).trigger, "manual")
        response = self.client.post("/admin/gpio/actions", data={
            "csrf_token": self.csrf, "title": "Invalid trigger", "pin": "16",
            "state": "toggle", "trigger": "invalid",
        })
        self.assertEqual(response.status_code, 400)
        self.assertIn(b"Choose when the GPIO output action runs.", response.data)
        self.store.start_timer()
        self.assertEqual(self.app.test_client().post("/admin/complete").status_code, 401)
        self.assertEqual(self.client.post("/admin/complete").status_code, 400)
        self.assertIsNone(self.store.get().room_completed_at)

    def test_failed_completion_output_is_reported_and_does_not_block_the_other_pin(self) -> None:
        for pin in (9, 16):
            self.create_action(
                f"Finish light {pin}", "toggle", pin=str(pin), trigger="room-complete",
            )
        gpio = self.app.extensions["gpio"]
        send_signal = gpio.send_signal

        def send_with_failure(
            target: str | int, state: str, duration: int | None,
        ) -> bool:
            if target == 9:
                raise OSError("test failure")
            return send_signal(target, state, duration)

        self.store.start_timer()
        with (
            patch.object(gpio, "send_signal", side_effect=send_with_failure),
            self.assertLogs(self.app.logger, level="ERROR"),
        ):
            response = self.client.post("/admin/complete", headers={"X-CSRF-Token": self.csrf})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["failed_actions"], ["Finish light 9"])
        self.assertIn("Room completed", response.get_json()["error"])
        self.assertIsNotNone(self.store.get().room_completed_at)
        self.assertTrue(self.factory.pin(16).state)
        self.assertTrue(any(
            "FAILED room-complete GPIO action 'Finish light 9'" in entry["description"]
            for entry in self.store.get_actions_for_current_run()
        ))

    def test_physical_completion_remains_accepted_when_an_output_fails(self) -> None:
        self.create_action("Finish light", "toggle", pin="9", trigger="room-complete")
        self.store.start_timer()
        with (
            patch.object(self.app.extensions["gpio"], "send_signal", side_effect=OSError("test failure")),
            self.assertLogs(self.app.logger, level="ERROR"),
        ):
            self.factory.pin(23).drive_low()
        self.assertIsNotNone(self.store.get().room_completed_at)
        self.assertTrue(self.store.get_gpio_activity()[1][0].accepted)

    def test_failure_expiry_reset_and_completion_before_start_do_not_run_outputs(self) -> None:
        self.create_action("Finish light", "toggle", pin="9", trigger="room-complete")
        response = self.client.post("/admin/complete", headers={"X-CSRF-Token": self.csrf})
        self.assertEqual(response.status_code, 409)
        self.assertFalse(self.factory.pin(9).state)
        self.store.start_timer()
        self.client.post("/admin/fail", headers={"X-CSRF-Token": self.csrf})
        self.assertFalse(self.factory.pin(9).state)
        self.store.reset_timer()
        self.assertFalse(self.factory.pin(9).state)
        self.store.start_timer()
        expired = self.store.adjust_timer(-3600)
        self.app.extensions["display_runtime"].schedule_automatic_failure(expired)
        self.assertIsNotNone(self.store.get().room_failed_at)
        self.assertFalse(self.factory.pin(9).state)

    def test_existing_timed_schema_migrates_without_losing_signals_or_durations(self) -> None:
        legacy = Path(self.directory.name) / "timed-legacy.db"
        with closing(connect(legacy)) as connection:
            connection.executescript("""
                CREATE TABLE gpio_output_actions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL UNIQUE,
                    output_name TEXT,
                    pin INTEGER,
                    state TEXT NOT NULL,
                    duration_seconds INTEGER
                );
                INSERT INTO gpio_output_actions
                VALUES (4, 'Timed', NULL, 9, 'timed', 10), (7, 'Toggle', NULL, 16, 'toggle', NULL);
            """)
        initialize(legacy)
        initialize(legacy)
        with closing(connect(legacy)) as connection:
            rows = connection.execute(
                "SELECT id, title, pin, state, duration_seconds, trigger FROM gpio_output_actions ORDER BY id"
            ).fetchall()
        self.assertEqual([tuple(row) for row in rows], [
            (4, "Timed", 9, "timed", 10, "manual"),
            (7, "Toggle", 16, "toggle", None, "manual"),
        ])

    def test_current_schema_migrates_direct_and_named_actions_without_losing_ids(self) -> None:
        legacy = Path(self.directory.name) / "legacy.db"
        with closing(connect(legacy)) as connection:
            connection.executescript("""
                CREATE TABLE gpio_output_actions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL UNIQUE,
                    output_name TEXT,
                    pin INTEGER CHECK (pin IS NULL OR pin BETWEEN 0 AND 27),
                    state TEXT NOT NULL CHECK (state IN ('on', 'off')),
                    CHECK ((output_name IS NOT NULL AND pin IS NULL)
                        OR (output_name IS NULL AND pin IS NOT NULL))
                );
                INSERT INTO gpio_output_actions (id, title, output_name, pin, state)
                VALUES (4, 'Named', 'light', NULL, 'on'), (7, 'Direct', NULL, 18, 'off');
            """)
        initialize(legacy)
        initialize(legacy)
        with closing(connect(legacy)) as connection:
            rows = connection.execute(
                "SELECT id, title, output_name, pin, state, duration_seconds FROM gpio_output_actions ORDER BY id"
            ).fetchall()
        self.assertEqual([tuple(row) for row in rows], [
            (4, "Named", "light", None, "on", None),
            (7, "Direct", None, 18, "off", None),
        ])


if __name__ == "__main__":
    unittest.main()
