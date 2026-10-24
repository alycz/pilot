# XRPL market analytics read model

`analytics.marketSnapshot` is a bounded, read-only Harbor operation for one
explicit XRPL asset pair. It performs two validated-ledger `book_offers` reads
and one validated-ledger `amm_info` read, then returns a normalized snapshot for
both Pilot UI and agent tools.

The response carries the requested network and full issued-asset identity,
per-source ledger indexes, Harbor observation time, units, book availability,
malformed-offer counts, and partial-data reasons. Amount and price calculations
use integer rational arithmetic; XRP drops are converted to XRP display units
before prices or depth are calculated.

Executable-liquidity rows are bounded walks of the observed funded book. They
are estimates over the returned depth, not transaction simulations or authority
to sign. A snapshot returns one price observation only. Recent trades are
explicitly unsupported because `book_offers` and `amm_info` do not constitute a
canonical trades feed.

The operation does not claim OHLC candles, protocol revenue, valuation bands,
annualized yield, funding, open interest, or any off-ledger market data.
