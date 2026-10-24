# AGENTS.md — Pilot + Harbor

This repository contains the Pilot web workspace at the root and the Harbor
execution service under `services/harbor`.

## Safety boundaries

- Never execute on XRPL mainnet or use real funds.
- Never commit or print secrets, wallet seeds, private keys, signed blobs,
  browser sessions, populated vaults, local databases, or provider credentials.
- Pilot never holds an owner XRPL key. Owner authorization stays sign-only in
  the wallet; Harbor may use only explicitly delegated, policy-bounded keys.
- Keep autonomous execution, sponsor adapters, model access, cron, and external
  mutations disabled by default and fail closed when configuration is absent.
- Preserve account, network, permission, quota, approval, stop, and unknown-
  outcome boundaries. Do not weaken tests to make a check pass.
- Never fabricate acceptance logs, transaction receipts, or historical evidence.

## Toolchains

- Pilot: Node and pnpm versions pinned at the repository root.
- Harbor: Node and npm versions pinned in `services/harbor`; run its commands
  with that directory as the working directory.
- AP4M and x402 Python environments remain isolated and lockfile-driven.

## Verification

Run the destination integrity check before dependency installation. Then run
the root and nested typechecks, offline unit suites, production build, browser
fixtures, generated-file checks, contract byte/hash parity, and migration
inventory checks. Live wallets, provider calls, Testnet transactions, remote
migrations, and deployment are separate explicitly authorized acceptance lanes.
