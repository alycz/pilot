---
max_per_tx_usd: 2000
daily_cap_usd: 5000
execute_under_usd: 250
max_slippage_bps: 100
allowed_tx_types:
  - OfferCreate
  - OfferCancel
  - TrustSet
  - AMMDeposit
  - AMMWithdraw
  - EscrowFinish
  - CheckCash
issuer_allowlist:
  - RLUSD
block_requireauth_issuers: true
networks:
  - testnet
  - devnet
x402_max_per_call_drops: "10000"
x402_daily_cap_drops: "1000000"
ap4m_enabled: false
---

# Execution policy

Saving this note through Pilot synchronizes it with Harbor's `policy.set` operation.
