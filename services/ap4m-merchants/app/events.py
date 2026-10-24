"""Bounded in-memory event feed for the local merchant console."""

import asyncio
from collections import deque
from datetime import UTC, datetime
from typing import Any, AsyncIterator


class EventRing:
    def __init__(self, capacity: int = 256) -> None:
        self._events: deque[dict[str, Any]] = deque(maxlen=capacity)
        self._condition = asyncio.Condition()
        self._next_id = 1

    async def append(self, kind: str, **detail: Any) -> dict[str, Any]:
        async with self._condition:
            event = {
                "id": self._next_id,
                "kind": kind,
                "at": datetime.now(UTC).isoformat(),
                **detail,
            }
            self._next_id += 1
            self._events.append(event)
            self._condition.notify_all()
        return event

    def snapshot(self) -> list[dict[str, Any]]:
        return list(self._events)

    async def stream(self, after: int = 0) -> AsyncIterator[dict[str, Any]]:
        cursor = after
        while True:
            ready = [event for event in self._events if int(event["id"]) > cursor]
            if ready:
                for event in ready:
                    cursor = int(event["id"])
                    yield event
                continue
            async with self._condition:
                try:
                    await asyncio.wait_for(self._condition.wait(), timeout=15)
                except TimeoutError:
                    yield {"id": cursor, "kind": "keepalive"}


events = EventRing()
