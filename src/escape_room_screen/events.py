from collections.abc import Callable, Generator
import json
from threading import Condition


class DisplayUpdateBroker:
    def __init__(self) -> None:
        self._condition = Condition()
        self._revision = 0

    def publish(self) -> None:
        with self._condition:
            self._revision += 1
            self._condition.notify_all()

    def stream(
        self, get_snapshot: Callable[[], dict[str, object]]
    ) -> Generator[str, None, None]:
        revision = -1
        while True:
            with self._condition:
                if revision == self._revision:
                    self._condition.wait_for(
                        lambda: revision != self._revision, timeout=20
                    )
                revision = self._revision
            payload = json.dumps(get_snapshot(), separators=(",", ":"))
            yield f"event: display\ndata: {payload}\n\n"
