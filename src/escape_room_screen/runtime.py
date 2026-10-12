from datetime import datetime, timedelta, timezone
import subprocess
from threading import Lock, Timer

from flask import Flask
from gpiozero.exc import GPIOZeroError

from .display import (
    GpioOutputAction,
    DisplaySettings,
    DisplaySettingsStore,
)
from .display_power import DisplayPowerController
from .events import DisplayUpdateBroker
from .gpio import GpioController


class DisplayRuntime:
    def __init__(
        self,
        app: Flask,
        store: DisplaySettingsStore,
        broker: DisplayUpdateBroker,
        gpio: GpioController,
        display_power: DisplayPowerController,
        configured_gpio_inputs: dict[str, int],
    ) -> None:
        self.app = app
        self.store = store
        self.broker = broker
        self.gpio = gpio
        self.display_power = display_power
        self._configured_gpio_inputs = configured_gpio_inputs
        self._auto_hint_timer: Timer | None = None
        self._auto_fail_timer: Timer | None = None
        self._completion_lock = Lock()

    def initialize(self) -> None:
        self._clear_expired_announcement()
        self.configure_gpio_inputs()
        self.schedule_timer_events(self.store.get())

    def publish_current_settings(self) -> None:
        self.broker.publish()

    def record_action(self, action_type: str, description: str) -> None:
        try:
            self.store.record_action(action_type, description)
        except Exception:
            self.app.logger.exception("Failed to record action")

    def trigger_gpio_output_action(self, action: GpioOutputAction) -> bool:
        target = action.pin if action.pin is not None else action.output_name
        if target is None:
            raise ValueError("GPIO output action has no target.")
        is_on = self.gpio.send_signal(target, action.state, action.duration_seconds)
        self.record_action(
            "gpio",
            f"Triggered extra GPIO button '{action.title}' for "
            f"{action.output_name or f'BCM {action.pin}'} "
            f"({'on' if is_on else 'off'}; signal={action.state}"
            f"{f'; duration={action.duration_seconds}s' if action.duration_seconds else ''})",
        )
        return is_on

    def complete_room(self) -> tuple[DisplaySettings, list[str]]:
        with self._completion_lock:
            settings = self.store.get()
            if settings.room_completed_at is not None:
                return settings, []
            settings = self.store.complete_room()
            self.cancel_timer_events()
            self.record_action("room", "Completed room")
            failed_actions: list[str] = []
            for action in self.store.get_gpio_output_actions():
                if action.trigger != "room-complete":
                    continue
                try:
                    self.trigger_gpio_output_action(action)
                except (KeyError, ValueError, RuntimeError, OSError, GPIOZeroError):
                    failed_actions.append(action.title)
                    self.app.logger.exception(
                        "Room completed, but GPIO output action %s (%s) failed.",
                        action.id, action.title,
                    )
                    self.record_action(
                        "gpio",
                        f"FAILED room-complete GPIO action '{action.title}' for "
                        f"{action.output_name or f'BCM {action.pin}'}",
                    )
            self.publish_current_settings()
            return settings, failed_actions

    def configure_gpio_inputs(self) -> None:
        inputs = self.gpio_inputs()
        self.gpio.configure_inputs(inputs, self.handle_gpio_event)

    def gpio_inputs(self) -> list[tuple[str, int]]:
        saved_mappings = self.store.get_gpio_mappings()
        if not saved_mappings:
            return list(self._configured_gpio_inputs.items())
        return [(mapping.event, mapping.pin) for mapping in saved_mappings]

    def is_gpio_input_pin(self, pin: int) -> bool:
        return any(input_pin == pin for _event, input_pin in self.gpio_inputs())

    def handle_gpio_event(self, pin: int, event: str) -> None:
        paused, _activity = self.store.get_gpio_activity()
        if paused:
            self.store.record_gpio_event(pin, event, accepted=False)
            return
        try:
            mapping = self.store.get_gpio_mapping_by_pin(pin)
            event = mapping.event if mapping is not None else event
            if (
                event in ("complete-room", "send-preset")
                and not self.store.get().timer_is_running
            ):
                self.store.record_gpio_event(pin, event, accepted=False)
                return
            if mapping is None:
                self._handle_legacy_gpio_event(pin, event)
                return
            if mapping.event == "complete-room":
                self.complete_room()
                self.store.record_gpio_event(pin, mapping.event, accepted=True)
                return
            if mapping.event == "start-timer":
                self._start_timer_from_gpio(pin, mapping.event)
                return
            if mapping.event == "send-preset":
                self._send_gpio_preset(pin, mapping.preset_id)
                return
            if mapping.event == "display-toggle":
                self.toggle_display_power(pin)
        except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError):
            self.store.record_gpio_event(pin, event, accepted=False)
            self.app.logger.warning(
                "Ignored GPIO event %s on pin %s.", event, pin
            )

    def schedule_automatic_hint(self, settings: DisplaySettings) -> None:
        self.cancel_automatic_hint()
        if (
            settings.auto_hint_remaining_minutes is None
            or settings.auto_hint_message is None
        ):
            return
        started_at = datetime.fromisoformat(settings.timer_started_at)
        if started_at.tzinfo is None:
            started_at = started_at.replace(tzinfo=timezone.utc)
        elapsed_seconds = max(
            0,
            (datetime.now(timezone.utc) - started_at).total_seconds(),
        )
        target_seconds = (
            settings.timer_base_seconds
            + settings.extra_time_seconds
            - settings.penalty_time_seconds
            - settings.auto_hint_remaining_minutes * 60
        )
        delay = max(0, target_seconds - elapsed_seconds)

        def send_if_room_is_incomplete() -> None:
            current = self.store.get()
            if (
                current.timer_started_at == settings.timer_started_at
                and current.room_completed_at is None
                and current.room_failed_at is None
            ):
                self.store.send_announcement(settings.auto_hint_message)
                self.publish_current_settings()

        self._auto_hint_timer = Timer(delay, send_if_room_is_incomplete)
        self._auto_hint_timer.daemon = True
        self._auto_hint_timer.start()

    def schedule_automatic_failure(self, settings: DisplaySettings) -> None:
        self.cancel_automatic_failure()
        if (
            settings.timer_started_at is None
            or settings.timer_paused_at is not None
            or settings.room_completed_at is not None
            or settings.room_failed_at is not None
        ):
            return
        started_at = datetime.fromisoformat(settings.timer_started_at)
        if started_at.tzinfo is None:
            started_at = started_at.replace(tzinfo=timezone.utc)
        deadline = started_at.timestamp() + (
            settings.timer_base_seconds
            + settings.extra_time_seconds
            - settings.penalty_time_seconds
        )
        delay = deadline - datetime.now(timezone.utc).timestamp()
        failed_at = datetime.fromtimestamp(deadline, timezone.utc).isoformat()

        def fail_if_room_is_active() -> None:
            updated = self.store.fail_room_if_active(
                settings.timer_started_at,
                failed_at,
            )
            if updated is None:
                return
            self.cancel_automatic_hint()
            self.record_action("room", "Automatically failed room when timer expired")
            self.publish_current_settings()

        if delay <= 0:
            fail_if_room_is_active()
            return
        self._auto_fail_timer = Timer(delay, fail_if_room_is_active)
        self._auto_fail_timer.daemon = True
        self._auto_fail_timer.start()

    def schedule_timer_events(self, settings: DisplaySettings) -> None:
        if (
            settings.timer_started_at is None
            or settings.timer_paused_at is not None
            or settings.room_completed_at is not None
            or settings.room_failed_at is not None
        ):
            self.cancel_timer_events()
            return
        self.schedule_automatic_hint(settings)
        self.schedule_automatic_failure(settings)

    def cancel_automatic_hint(self) -> None:
        if self._auto_hint_timer is None:
            return
        self._auto_hint_timer.cancel()
        self._auto_hint_timer = None

    def cancel_automatic_failure(self) -> None:
        if self._auto_fail_timer is None:
            return
        self._auto_fail_timer.cancel()
        self._auto_fail_timer = None

    def cancel_timer_events(self) -> None:
        self.cancel_automatic_hint()
        self.cancel_automatic_failure()

    def _clear_expired_announcement(self) -> None:
        try:
            if self.store.clear_expired_announcement():
                self.publish_current_settings()
        except Exception:
            self.app.logger.exception(
                "Failed to clear expired announcement at startup"
            )

    def _handle_legacy_gpio_event(self, pin: int, event: str) -> None:
        if event == "start-timer":
            self._start_timer_from_gpio(pin, event)
            return
        if event != "complete-room":
            if event == "display-toggle":
                self.toggle_display_power(pin)
            return
        self.complete_room()
        self.store.record_gpio_event(pin, event, accepted=True)

    def toggle_display_power(self, pin: int | None = None) -> bool:
        try:
            is_on = self.display_power.toggle()
        except (RuntimeError, OSError, subprocess.CalledProcessError):
            if pin is not None:
                self.store.record_gpio_event(pin, "display-toggle", accepted=False)
            self.app.logger.exception("Failed to toggle Raspberry Pi display power")
            raise
        if pin is not None:
            self.store.record_gpio_event(pin, "display-toggle", accepted=True)
        self.record_action("display", f"Turned HDMI display {'on' if is_on else 'off'}")
        return is_on

    def _start_timer_from_gpio(self, pin: int, event: str) -> None:
        settings = self.store.start_timer_if_not_running(
            allow_briefing=not self.app.config["DISABLE_SCREEN_MEDIA"],
        )
        if settings is None:
            self.store.record_gpio_event(pin, event, accepted=False)
            return
        self.record_action(
            "timer",
            "Started video briefing from GPIO" if settings.briefing_token
            else f"Started timer ({timedelta(seconds=settings.timer_base_seconds)}) from GPIO",
        )
        self.publish_current_settings()
        self.schedule_timer_events(settings)
        self.store.record_gpio_event(pin, event, accepted=True)

    def _send_gpio_preset(self, pin: int, preset_id: int | None) -> None:
        if preset_id is None:
            self.store.record_gpio_event(pin, "send-preset", accepted=False)
            self.app.logger.warning("GPIO mapping has no preset_id.")
            return
        preset = self.store.get_hint_preset(preset_id)
        if preset is None:
            self.store.record_gpio_event(pin, "send-preset", accepted=False)
            self.app.logger.warning(
                "GPIO mapping refers to missing preset id %s.", preset_id
            )
            return
        media_type = None if preset.kind == "text" else preset.kind
        try:
            self.store.send_announcement(
                preset.message or "",
                media_type=media_type,
                media_filename=preset.media_filename,
                media_full_screen=preset.full_screen,
            )
        except ValueError:
            self.store.record_gpio_event(pin, "send-preset", accepted=False)
            self.app.logger.warning(
                "Ignored GPIO send-preset input because the timer is not running."
            )
            return
        self.record_action("announcement", f"GPIO sent preset hint: {preset.title}")
        self.publish_current_settings()
        self.store.record_gpio_event(pin, "send-preset", accepted=True)
