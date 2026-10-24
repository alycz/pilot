"""Stable, non-sensitive MM2 validation failures."""

from dataclasses import dataclass
from typing import Literal


Stage = Literal["wba", "intent", "credential", "payment"]


@dataclass(frozen=True)
class ValidationFailure(Exception):
    stage: Stage
    code: str
    message: str
    http_status: int

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


def fail(stage: Stage, code: str, message: str, http_status: int = 400) -> None:
    raise ValidationFailure(stage, code, message, http_status)
