import logging
from collections.abc import Callable
from collections.abc import Iterable
from threading import RLock, Timer, TIMEOUT_MAX

from gpiozero import Button, OutputDevice
from gpiozero.exc import BadPinFactory, GPIOPinInUse, GPIOZeroError


LOGGER = logging.getLogger(__name__)


def validate_output_signal(state: object, duration_seconds: object = None) -> int | None:
    if state not in ("on", "off", "toggle", "timed"):
        raise ValueError("Choose an on, off, toggle, or timed GPIO signal.")
    if state != "timed":
        return None
    try:
        if isinstance(duration_seconds, bool) or not isinstance(duration_seconds, (str, int)):
            raise ValueError
        if isinstance(duration_seconds, str) and not duration_seconds.strip().isdecimal():
            raise ValueError
        duration = int(duration_seconds)
        if not 0 < duration <= TIMEOUT_MAX:
            raise ValueError
    except ValueError as error:
        raise ValueError("Timed GPIO signals require a positive whole number of seconds.") from error
    return duration


class GpioController:
    """Manages named and persisted direct BCM GPIO outputs."""

    def __init__(
        self,
        output_pins: dict[str, int] | None = None,
        input_pins: Iterable[tuple[str, int]] | dict[str, int] | None = None,
    ) -> None:
        self._outputs: dict[str, OutputDevice] = {}
        self._configured_output_pins = set((output_pins or {}).values())
        self._direct_outputs: dict[int, OutputDevice] = {}
        self._buttons: dict[int, Button] = {}
        self._output_lock = RLock()
        self._output_timers: dict[int, Timer] = {}
        self.available = True
        try:
            for name, pin in (output_pins or {}).items():
                self._outputs[name] = OutputDevice(pin)
            self.configure_inputs(input_pins or {}, self._log_input)
        except BadPinFactory:
            self.available = False
            self.close()
            LOGGER.warning("GPIO hardware is unavailable; running without physical pin control.")

    def output_names(self) -> list[str]:
        return sorted(self._outputs)

    def output_pins(self) -> dict[str, int]:
        return {
            name: output.pin.number
            for name, output in self._outputs.items()
        }

    def input_names(self) -> list[str]:
        return []

    def is_input_pin(self, pin: int) -> bool:
        return pin in self._buttons

    def is_output_pin(self, pin: int) -> bool:
        return (
            pin in self._configured_output_pins
            or pin in self._direct_outputs
            or any(output.pin.number == pin for output in self._outputs.values())
        )

    def configure_inputs(
        self,
        input_pins: Iterable[tuple[str, int]] | dict[str, int],
        callback: Callable[[int, str], None],
    ) -> None:
        for button in self._buttons.values():
            button.close()
        self._buttons.clear()
        try:
            pins = input_pins.items() if isinstance(input_pins, dict) else input_pins
            for name, pin in pins:
                button = Button(pin)
                button.when_pressed = lambda pin=pin, name=name: callback(pin, name)
                self._buttons[pin] = button
        except GPIOPinInUse as error:
            for button in self._buttons.values():
                button.close()
            self._buttons.clear()
            raise ValueError("That BCM pin is already configured as an output.") from error
        except BadPinFactory:
            self.available = False
            self.close()
            LOGGER.warning("GPIO hardware is unavailable; running without physical pin control.")

    def activate(self, name: str) -> None:
        self.send_signal(name, "on")

    def deactivate(self, name: str) -> None:
        self.send_signal(name, "off")

    def activate_pin(self, pin: int) -> None:
        self.send_signal(pin, "on")

    def deactivate_pin(self, pin: int) -> None:
        self.send_signal(pin, "off")

    def send_signal(
        self, target: str | int, state: str, duration_seconds: int | None = None,
    ) -> bool:
        duration = validate_output_signal(state, duration_seconds)
        with self._output_lock:
            if isinstance(target, str):
                output = self._outputs.get(target)
                if output is None:
                    raise KeyError(target)
                pin = output.pin.number
            else:
                pin = target
                output = self._direct_output(pin)
            self._cancel_output_timer(pin)
            if state == "off":
                output.off()
            elif state == "toggle":
                output.toggle()
            else:
                output.on()
            if duration is not None:
                def turn_off() -> None:
                    with self._output_lock:
                        # A cancelled callback may already be waiting for the lock.
                        if self._output_timers.get(pin) is not timer:
                            return
                        self._output_timers.pop(pin)
                        try:
                            output.off()
                        except (RuntimeError, OSError, GPIOZeroError):
                            LOGGER.exception("Failed to turn off timed GPIO output BCM %s.", pin)

                timer = Timer(duration, turn_off)
                timer.daemon = True
                self._output_timers[pin] = timer
                try:
                    timer.start()
                except RuntimeError:
                    self._output_timers.pop(pin)
                    output.off()
                    raise
            return bool(output.value)

    def _cancel_output_timer(self, pin: int) -> None:
        timer = self._output_timers.pop(pin, None)
        if timer is not None:
            timer.cancel()

    def release_pin(self, pin: int) -> None:
        with self._output_lock:
            self._cancel_output_timer(pin)
            output = self._direct_outputs.pop(pin, None)
            if output is not None:
                try:
                    output.off()
                finally:
                    output.close()

    def close(self) -> None:
        with self._output_lock:
            for pin in list(self._output_timers):
                self._cancel_output_timer(pin)
            for output in (*self._outputs.values(), *self._direct_outputs.values()):
                try:
                    output.off()
                finally:
                    output.close()
            for button in self._buttons.values():
                button.close()
            self._outputs.clear()
            self._direct_outputs.clear()
            self._buttons.clear()

    def _direct_output(self, pin: int) -> OutputDevice:
        if not isinstance(pin, int) or not 0 <= pin <= 27:
            raise ValueError("GPIO pin must be a BCM pin number from 0 to 27.")
        output = self._direct_outputs.get(pin)
        if output is not None:
            return output
        if self.is_input_pin(pin):
            raise ValueError("That BCM pin is already configured as an input.")
        if self.is_output_pin(pin):
            raise ValueError("That BCM pin is already configured as an output.")
        try:
            output = OutputDevice(pin, initial_value=False)
        except GPIOPinInUse as error:
            raise ValueError("That BCM pin is already in use.") from error
        except BadPinFactory as error:
            self.available = False
            raise RuntimeError("GPIO hardware is unavailable.") from error
        self._direct_outputs[pin] = output
        return output

    @staticmethod
    def _log_input(pin: int, name: str) -> None:
        LOGGER.info("GPIO %s input '%s' was activated.", pin, name)
