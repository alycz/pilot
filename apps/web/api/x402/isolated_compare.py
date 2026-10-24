from __future__ import annotations

import time
import uuid
from typing import Callable, Optional

from fastapi import FastAPI

from .compare import create_app
from .config import MerchantConfig, require_isolated_merchant_config
from .verifier import PaymentFacilitator


def create_isolated_app(
    config: Optional[MerchantConfig] = None,
    verifier: Optional[PaymentFacilitator] = None,
    *,
    clock: Callable[[], float] = time.time,
    invoice_id_factory: Callable[[], str] = lambda: f"pilot-compare-{uuid.uuid4().hex}",
) -> FastAPI:
    """Create the fixed-price app used by the reviewed isolated x402 lane."""

    resolved_config = require_isolated_merchant_config(
        config or MerchantConfig.from_env()
    )
    return create_app(
        resolved_config,
        verifier,
        clock=clock,
        invoice_id_factory=invoice_id_factory,
    )


app = create_isolated_app()
