# Offline procedure improvement fixtures

This directory contains synthetic and explicitly redacted replay-shaped evidence
for Pilot's bounded offline procedure evaluator. The design is inspired by
[Google Research Harness²](https://github.com/google-research/harness2), especially
its evidence-driven comparison of a baseline with a proposed harness. It is not
a Google integration and does not install, import, or run Harness².

The evaluator only parses declarative procedure versions, compares already
recorded metrics, and returns three review artifacts:

- a versioned review report;
- a promotion manifest that remains `pending_human_review`; and
- a rollback manifest that remains `prepared_not_applied`.

It has no model or executor callback and no filesystem, network, order,
transaction, policy, runtime-code, promotion, or rollback write path. The files
under `fixtures/` contain no real user identifiers, credentials, wallet data, or
order data. `replay-redacted.json` is a constructed, replay-shaped fixture whose
redaction flags are part of the validated schema; it is not captured production
traffic.

Passing these fixtures demonstrates only Pilot's offline schema, comparison, and
artifact behavior. It does not demonstrate upstream Harness² compatibility or a
live Hermes/model integration.
