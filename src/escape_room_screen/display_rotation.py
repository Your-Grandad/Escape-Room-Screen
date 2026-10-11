import argparse
from contextlib import closing
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
from threading import Lock

from .database import connect


ROTATIONS = {0: "normal", 90: "right", 180: "inverted", 270: "left"}


class DisplayRotationController:
    """Opt-in rotation of the kiosk's X11 output, independent of web content."""

    def __init__(self, database_path: Path | str, output: str) -> None:
        if output and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", output):
            raise ValueError("HDMI_ROTATION_OUTPUT must be an X11 output name.")
        self.database_path = database_path
        self.output = output
        self.command = shutil.which("xrandr")
        self._lock = Lock()

    @property
    def available(self) -> bool:
        return bool(self.output and self.command and os.environ.get("DISPLAY"))

    @property
    def saved_rotation(self) -> int:
        with closing(connect(self.database_path)) as connection:
            row = connection.execute(
                "SELECT rotation FROM hdmi_rotation WHERE id = 1"
            ).fetchone()
        if row is None:
            raise RuntimeError("HDMI rotation settings are missing.")
        return row["rotation"]

    def _run(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        if not self.available or self.command is None:
            raise RuntimeError("Configure HDMI_ROTATION_OUTPUT, DISPLAY and X11 access first.")
        return subprocess.run(
            [self.command, *arguments],
            check=True, capture_output=True, text=True, timeout=10,
        )

    def _current_rotation(self) -> str:
        result = self._run("--query")
        for line in result.stdout.splitlines():
            words = line.split()
            if len(words) >= 2 and words[:2] == [self.output, "connected"]:
                prefix, separator, supported = line.partition("(")
                if not separator or not all(mode in supported.split() for mode in ROTATIONS.values()):
                    raise RuntimeError("The selected output does not advertise rotation support.")
                current = prefix.split()[-1]
                return current if current in ROTATIONS.values() else "normal"
        raise RuntimeError("The configured HDMI output is not connected.")

    def apply(self, rotation: int, *, persist: bool = True) -> None:
        if type(rotation) is not int or rotation not in ROTATIONS:
            raise ValueError("HDMI rotation must be 0, 90, 180 or 270 degrees.")
        with self._lock:
            previous = self._current_rotation()
            with closing(connect(self.database_path)) as connection:
                if persist:
                    connection.execute("BEGIN IMMEDIATE")
                    connection.execute(
                        "UPDATE hdmi_rotation SET rotation = ? WHERE id = 1", (rotation,)
                    )
                self._run("--output", self.output, "--rotate", ROTATIONS[rotation])
                try:
                    connection.commit()
                except sqlite3.Error:
                    self._run("--output", self.output, "--rotate", previous)
                    raise


def main() -> None:
    parser = argparse.ArgumentParser(description="Restore saved kiosk HDMI rotation after X11 starts.")
    parser.add_argument("--database", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args()
    controller = DisplayRotationController(arguments.database, arguments.output)
    controller.apply(controller.saved_rotation, persist=False)


if __name__ == "__main__":
    main()
