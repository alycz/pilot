# AP4M demo merchants

Mock-first FastAPI service for the two XRPL Testnet demo merchants: **Venue
Yield Desk** and **Risk Oracle**. It exposes Mastercard Level 3-shaped REST and
MCP discovery surfaces, typed deterministic products, x402 challenges, and an
SSE event feed for the later demo console.

This MM1 implementation does not accept, sign, submit, or settle payments. The
shared validator deliberately fails closed until MM2 adds Web Bot Auth,
Verifiable Intent, credential, and XRPL payment verification in the required
order. `setup_testnet.py` is also dry-run-only and never reads credentials.

## Local checks

```bash
python3.13 -m venv .venv
.venv/bin/pip install -e '.[test]'
.venv/bin/pytest -q
.venv/bin/python setup_testnet.py --dry-run
```

Run the mock merchant locally with:

```bash
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8794
```

The service is labelled mock/Testnet and contains no wallet seeds, Mastercard
credentials, environment files, or live network calls.
