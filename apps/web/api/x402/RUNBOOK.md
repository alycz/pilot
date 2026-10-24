# Local runbook

Run from the Pilot repository root with Python 3.11, matching CI and the lock's resolver target. Use a temporary virtual environment and install the complete hash-locked graph from official PyPI. Initial installation needs network access; the tests below do not.

## Install and test

```bash
python3.11 -m venv /tmp/pilot-x402-venv
/tmp/pilot-x402-venv/bin/python -m pip install \
  --index-url https://pypi.org/simple \
  --require-hashes \
  --requirement apps/web/api/x402/requirements-test.lock
HTTP_PROXY=http://127.0.0.1:9 \
HTTPS_PROXY=http://127.0.0.1:9 \
NO_PROXY=127.0.0.1,localhost \
PYTHONDONTWRITEBYTECODE=1 \
/tmp/pilot-x402-venv/bin/python -m pytest -q apps/web/api/x402/tests
```

## Configure

All values below are public configuration. Do not add a wallet seed, private key, API credential, or `.env` file.

```bash
export XRPL_X402_PAY_TO=rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr
export XRPL_X402_PRICE_DROPS=5000
export XRPL_X402_SOURCE_TAG=2610240
export XRPL_X402_TIMEOUT_SECONDS=60
export XRPL_X402_MAX_PAYER_FEE_DROPS=100
export XRPL_X402_FACILITATOR_URL=https://xrpl-facilitator-testnet.t54.ai
```

`2610240` is the current Harbor local x402 profile's public SourceTag. Before a
combined run, check the active environment-resolved merchant configuration
directly against Harbor's checked-in profile (never pass a `.dev.vars`, `.env`,
or other secrets file):

```bash
/tmp/pilot-x402-venv/bin/python -m apps.web.api.x402.profile_contract \
  /path/to/harbor/wrangler.local-x402.jsonc \
  --harbor-origin http://127.0.0.1:8791
```

For the isolated profile, pass
`wrangler.local-x402-isolated-v1.jsonc` and the exact origin
`http://127.0.0.2:8792`. The preflight rejects the retired `.3:8791` design
and any price or receiver other than the exact values shown above.

Invoice storage is fixed at `apps/web/api/x402/.local/invoices.sqlite3`; an environment-selected path is rejected. The facilitator and read-only ledger endpoints are allowlisted to exact Testnet origins. Mainnet, issued assets, caller-selected targets, alternate resources, redirects, and fee sponsorship are rejected or unavailable.

## Start on loopback only

The isolated lane must use its fail-closed entrypoint:

```bash
/tmp/pilot-x402-venv/bin/python -m uvicorn apps.web.api.x402.isolated_compare:app \
  --host 127.0.0.1 --port 8000
```

The reusable `apps.web.api.x402.compare:app` entrypoint retains the generic
configurable-price contract and is not the isolated fail-closed lane.

In another shell, inspect the unpaid challenge:

```bash
curl --include --request GET \
  --header 'Accept: application/json' \
  http://127.0.0.1:8000/api/x402/compare
```

Expected: HTTP `402`, JSON body, and a `PAYMENT-REQUIRED` header. Do not send a real signed transaction during this code-only demo: a paid request enables the fixed Testnet verify-then-settle runtime path. Stop Uvicorn with `Ctrl-C` when finished.

## Cleanup

```bash
rm -f apps/web/api/x402/.local/invoices.sqlite3 \
  apps/web/api/x402/.local/invoices.sqlite3-shm \
  apps/web/api/x402/.local/invoices.sqlite3-wal
```

The database deletion is optional and removes only local invoice/cache state. It does not affect any ledger or external service.
