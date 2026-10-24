-- Isolated x402 needs the same ledger-account sequence fence as every other
-- signing producer, without importing the unrelated AP4M runtime schema.
-- IF NOT EXISTS / OR IGNORE keep this forward migration safe on the combined
-- lineage, where migration 0008 may already have created these exact objects.

CREATE TABLE IF NOT EXISTS payer_sequence_leases (
  network TEXT NOT NULL CHECK (network IN ('testnet', 'devnet')),
  payer TEXT NOT NULL CHECK (length(payer) BETWEEN 25 AND 64),
  generation INTEGER NOT NULL CHECK (generation > 0),
  lease_token TEXT NOT NULL CHECK (
    length(lease_token) = 64 AND lease_token NOT GLOB '*[^0-9A-F]*'
  ),
  rail TEXT NOT NULL CHECK (rail IN ('ap4m', 'x402', 'legacy')),
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK (state IN (
    'preparing', 'signing', 'signed', 'settlement_unknown',
    'legacy_ambiguous', 'released'
  )),
  sequence INTEGER CHECK (sequence IS NULL OR sequence BETWEEN 0 AND 4294967295),
  first_eligible_ledger_index INTEGER CHECK (
    first_eligible_ledger_index IS NULL OR first_eligible_ledger_index > 0
  ),
  last_ledger_sequence INTEGER CHECK (
    last_ledger_sequence IS NULL OR last_ledger_sequence > 0
  ),
  tx_hash TEXT CHECK (
    tx_hash IS NULL OR
    (length(tx_hash) = 64 AND tx_hash NOT GLOB '*[^0-9A-F]*')
  ),
  acquired_at TEXT NOT NULL,
  signing_started_at TEXT,
  signed_at TEXT,
  updated_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT CHECK (
    release_reason IS NULL OR
    release_reason IN ('pre_sign', 'validated_terminal', 'expired_absent')
  ),
  resolution_ledger_index INTEGER CHECK (
    resolution_ledger_index IS NULL OR resolution_ledger_index > 0
  ),
  PRIMARY KEY (network, payer),
  CHECK (
    first_eligible_ledger_index IS NULL OR last_ledger_sequence IS NULL OR
    first_eligible_ledger_index <= last_ledger_sequence
  ),
  CHECK (
    (state = 'preparing' AND sequence IS NULL AND first_eligible_ledger_index IS NULL
      AND last_ledger_sequence IS NULL AND tx_hash IS NULL
      AND signing_started_at IS NULL AND signed_at IS NULL
      AND released_at IS NULL AND release_reason IS NULL
      AND resolution_ledger_index IS NULL)
    OR
    (state = 'signing' AND sequence IS NOT NULL
      AND first_eligible_ledger_index IS NOT NULL AND last_ledger_sequence IS NOT NULL
      AND tx_hash IS NULL AND signing_started_at IS NOT NULL
      AND signed_at IS NULL AND released_at IS NULL
      AND release_reason IS NULL AND resolution_ledger_index IS NULL)
    OR
    (state IN ('signed', 'settlement_unknown') AND sequence IS NOT NULL
      AND first_eligible_ledger_index IS NOT NULL AND last_ledger_sequence IS NOT NULL
      AND tx_hash IS NOT NULL AND signing_started_at IS NOT NULL
      AND signed_at IS NOT NULL AND released_at IS NULL
      AND release_reason IS NULL AND resolution_ledger_index IS NULL)
    OR
    (state = 'legacy_ambiguous' AND rail = 'legacy'
      AND released_at IS NULL AND release_reason IS NULL
      AND resolution_ledger_index IS NULL)
    OR
    (state = 'released' AND rail IN ('ap4m', 'x402')
      AND released_at IS NOT NULL AND release_reason IS NOT NULL
      AND ((release_reason = 'pre_sign' AND signing_started_at IS NULL
        AND tx_hash IS NULL AND resolution_ledger_index IS NULL)
      OR (release_reason IN ('validated_terminal', 'expired_absent')
        AND tx_hash IS NOT NULL AND resolution_ledger_index IS NOT NULL)))
  )
);

-- A pre-migration nonterminal payment is ambiguous. Fence its payer until the
-- durable payment is reconciled; elapsed time is never non-submission proof.
INSERT OR IGNORE INTO payer_sequence_leases (
  network, payer, generation, lease_token, rail, attempt_id, state,
  sequence, first_eligible_ledger_index, last_ledger_sequence, tx_hash,
  acquired_at, signing_started_at, signed_at, updated_at
)
SELECT
  network,
  delegate,
  1,
  upper(hex(randomblob(32))),
  'legacy',
  'legacy-x402:' || min(id),
  'legacy_ambiguous',
  NULL,
  NULL,
  max(last_ledger_seq),
  NULL,
  min(COALESCE(lease_acquired_at, created_at)),
  min(signing_started_at),
  min(signed_at),
  max(updated_at)
FROM x402_payments
WHERE status NOT IN ('failed', 'delivered')
GROUP BY network, delegate;

CREATE INDEX IF NOT EXISTS idx_payer_sequence_leases_active_attempt
  ON payer_sequence_leases(rail, attempt_id, state);

-- Principal is audit metadata only. The primary key serializes all producers
-- and principals against one exact ledger account on one exact network.
CREATE TABLE IF NOT EXISTS account_sequence_leases (
  principal TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN ('testnet', 'devnet')),
  account TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  lease_token TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('strategy', 'manual', 'ap4m', 'x402')),
  attempt_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'preparing', 'signing', 'signed', 'submitted', 'ambiguous', 'released'
  )),
  sequence INTEGER,
  first_ledger_sequence INTEGER,
  last_ledger_sequence INTEGER,
  tx_hash TEXT,
  acquired_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  released_at TEXT,
  release_evidence TEXT,
  PRIMARY KEY (network, account),
  UNIQUE (network, account, generation),
  UNIQUE (network, account, source, attempt_id)
);

INSERT OR IGNORE INTO account_sequence_leases (
  principal, network, account, generation, lease_token, source, attempt_id,
  state, sequence, first_ledger_sequence, last_ledger_sequence, tx_hash,
  acquired_at, updated_at
)
SELECT
  'legacy:payer-runtime', network, payer, generation, lease_token,
  CASE WHEN rail = 'ap4m' THEN 'ap4m' ELSE 'x402' END,
  attempt_id, 'ambiguous', sequence, first_eligible_ledger_index,
  last_ledger_sequence, tx_hash, acquired_at, updated_at
FROM payer_sequence_leases
WHERE state <> 'released';

CREATE INDEX IF NOT EXISTS idx_account_sequence_leases_state
  ON account_sequence_leases(network, account, state);
