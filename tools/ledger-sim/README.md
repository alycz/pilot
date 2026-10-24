# tools/ledger-sim — virtual Ledger for Pilot

A virtual Ledger Nano X running Ledger's real XRP app (2.8.2) in Speculos, driven through Ledger's
Device Management Kit. Used for development, CI-optional conformance, E2E and the event demo fallback.
Test networks only. See `LEDGER_INTEGRATION_ADDENDUM.md` (work package LG-0) for how this fits.

| File | Purpose |
| --- | --- |
| `fixtures/xrp-2.8.2-nanox-api27.elf` | Prebuilt XRP app (LedgerHQ/app-xrp 2.8.2, Apache-2.0), SDK v27.1.2. Checksum in `fixtures/SHA256SUMS` |
| `build-elf.sh` | Rebuilds the ELF from source (Linux / Ubuntu container) |
| `run-speculos.sh` | Starts the emulator on :5000 (pip `speculos` if installed, else Docker image) |
| `drive.mjs` | Button driver: `review("approve"\|"reject")`, `setBlindSigning(bool)`, `screen()`, `press()` |
| `conformance.mjs` | 10 checks covering every transaction shape Pilot asks an owner to sign |
| `proxy-route/route.ts` | Same-origin Next.js proxy template (Speculos sends no CORS headers) |
| `reference/browser-poc-*.{tsx,mjs}` | Proven browser path: Next 15 page + Playwright driver |

## Run

```bash
pip install speculos                      # Linux; on macOS the script falls back to Docker
ELF=tools/ledger-sim/fixtures/xrp-2.8.2-nanox-api27.elf tools/ledger-sim/run-speculos.sh &
npx tsx tools/ledger-sim/conformance.mjs  # expect 10/10 on a FRESH emulator (blind signing off)
```

`tsx` is required for Node scripts: the DMK's ESM build uses directory imports that plain `node`
rejects (`ERR_UNSUPPORTED_DIR_IMPORT`). Next.js and Vite bundle it without changes.

## Verified on 2026-10-21 (planning sandbox, Linux, speculos 0.27.1)

```
PASS  app config  — XRP app 2.8.2
PASS  address + compressed pubkey  — ra7Zr8ddy9tB88RaXL8B87YkqhEJG2vkAJ
PASS  verify address on device  — index 1 rGRdukvhGdJCgBHX9FUqnw2vndYupSoG2E
PASS  wallet sign-in challenge (AccountSet + memo)  — 8 screens
PASS  chat action proof (AccountSet + JSON memo)  — 11 screens
PASS  RLUSD TrustSet  — 9 screens
PASS  OfferCreate fill-or-kill  — 11 screens
PASS  DelegateSet with blind signing OFF is refused  — got 6985
PASS  DelegateSet with blind signing ON  — 15 screens
PASS  user rejects  — got 6985
10/10 passed
```

Browser path (reference/): Next 15.5.6 production build; DMK lazy-loaded into its own chunk;
Chromium → `/api/ledger-sim/{apdu,events}` proxy → Speculos; TrustSet signed; `verifySignature` true.

## Gotchas

- Build with an SDK **release tag**. `master` reports API level 0, which Speculos refuses. Speculos 0.27.1
  supports API levels 22 and 24–27; SDK v22 tags do not compile the current app.
- Emulator state (seed, blind-sign setting) resets on restart. Default seed = Speculos's public test mnemonic.
- Speculos API used: `GET /events[?currentscreenonly=true|?stream=true]`, `POST /apdu`, `GET /screenshot`,
  `POST /button/{left|right|both}` with `{"action":"press-and-release"}`. No CORS headers.
- `pkill -f speculos` from a shell whose command line contains "speculos" kills that shell. Kill by PID.
