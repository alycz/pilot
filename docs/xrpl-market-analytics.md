# XRPL market analytics workspace

Pilot's `/markets` workspace consumes Harbor's typed
`analytics.marketSnapshot` read. Testnet live is the default. Mainnet, when
selected, is labelled read-only and uses a separate issuer identity and request;
observations and browser-session samples never cross network boundaries.

The optional illustrative demo is a checked fixture. Its source and status are
shown as fixture data and it is never presented as live.

## Source coverage

| Panel or field | Harbor source | Method | Coverage and limitation |
| --- | --- | --- | --- |
| Pair/network/issuer identity | Request plus normalized result | Exact identity match before display | Issued assets always retain issuer identity |
| Best bid, best ask, spread, midpoint | Two `book_offers` reads | Funded offers on validated ledgers | Midpoint omitted when book ledger indexes differ |
| Order-book depth | Two `book_offers` reads | Bounded funded levels, maximum 100 per side | Capped reads are labelled; pagination is not implied |
| Executable liquidity/slippage | Normalized funded depth | Bounded book walk for at most five base sizes | Estimate only; no signing, pathfinding, or transaction simulation |
| AMM reserves, implied reserve ratio, fee | `amm_info` | Pair-matched validated pool state | Reserve ratio is not represented as an executable quote or yield |
| Price history | Current Harbor snapshot plus browser memory | One live observation retained per 25-second visible refresh, at most 250 per network | Explicitly incomplete session sample; intervals over 60 seconds become visible gaps and no candles are synthesized |
| Recent trades | None | Unsupported | Current-state methods do not provide a canonical trade tape |
| Revenue, valuation bands, P/S, APR, derivatives | None | Not displayed | No defensible XRPL source exists in this slice |

Every populated workspace includes network, asset identities, source operation,
providers, ledger indexes when available, Harbor observation time, freshness,
and units. Invalid, stale, empty, partial, and error responses have distinct
states; an error replaces prior data rather than making stale data look live.

## Terminal composition

The market surface is an embedded terminal rather than a list-and-dialog flow.
At desktop widths it keeps a searchable observed-pair rail, the selected
market's provenance and analytics, and a sticky book/trade-preview rail visible
together. The preview uses only Harbor's bounded executable estimates and
never treats an observation as a reserved quote. A Testnet handoff enters the
existing Pilot conversation and approval workflow; mainnet and illustrative
fixtures expose no approval entry.

On smaller viewports, Overview, Book, Liquidity, and Compare become a single
roving-tab interface. Pair selection, search text, data-source mode, session
history, and the selected panel are retained independently. The global harness
owns the only chat session and overlays this terminal; this feature adds no
chat transport, wallet state, signing, or submission authority.
