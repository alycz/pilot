CREATE TABLE ap4m_evm_channels (
  principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 256 AND instr(principal, char(0)) = 0),
  channel_id TEXT NOT NULL CHECK (length(channel_id) = 66 AND substr(channel_id, 1, 2) = '0x' AND substr(channel_id, 3) NOT GLOB '*[^0-9a-f]*'),
  merchant_id TEXT NOT NULL CHECK (length(merchant_id) BETWEEN 1 AND 128 AND substr(merchant_id, 1, 1) GLOB '[A-Za-z0-9]' AND merchant_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
  agent_wallet TEXT NOT NULL CHECK (length(agent_wallet) = 42 AND substr(agent_wallet, 1, 2) = '0x' AND substr(agent_wallet, 3) NOT GLOB '*[^0-9a-f]*'),
  funding_wallet TEXT NOT NULL CHECK (length(funding_wallet) = 42 AND substr(funding_wallet, 1, 2) = '0x' AND substr(funding_wallet, 3) NOT GLOB '*[^0-9a-f]*'),
  payout_wallet TEXT NOT NULL CHECK (length(payout_wallet) = 42 AND substr(payout_wallet, 1, 2) = '0x' AND substr(payout_wallet, 3) NOT GLOB '*[^0-9a-f]*'),
  token_address TEXT NOT NULL CHECK (
    token_address = '0x27b57a9d0b8d24eb97259c4e2279e45255e016f3'
  ),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  cap_base_units TEXT NOT NULL CHECK (length(cap_base_units) BETWEEN 1 AND 39 AND cap_base_units NOT GLOB '*[^0-9]*' AND cap_base_units <> '0' AND substr(cap_base_units, 1, 1) <> '0'),
  cumulative_base_units TEXT NOT NULL DEFAULT '0' CHECK (length(cumulative_base_units) BETWEEN 1 AND 39 AND cumulative_base_units NOT GLOB '*[^0-9]*' AND (cumulative_base_units = '0' OR substr(cumulative_base_units, 1, 1) <> '0')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  pending_idempotency_key TEXT,
  pending_request_fingerprint TEXT,
  pending_next_cumulative TEXT,
  pending_attempt_token TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  PRIMARY KEY (principal, channel_id),
  CHECK (payout_wallet <> agent_wallet AND payout_wallet <> funding_wallet),
  CHECK (
    length(cumulative_base_units) < length(cap_base_units) OR
    (length(cumulative_base_units) = length(cap_base_units) AND cumulative_base_units <= cap_base_units)
  ),
  CHECK (
    (pending_idempotency_key IS NULL AND pending_request_fingerprint IS NULL AND pending_next_cumulative IS NULL AND pending_attempt_token IS NULL)
    OR
    (pending_idempotency_key IS NOT NULL AND length(pending_idempotency_key) BETWEEN 1 AND 128 AND
      substr(pending_idempotency_key, 1, 1) GLOB '[A-Za-z0-9]' AND pending_idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      pending_request_fingerprint IS NOT NULL AND length(pending_request_fingerprint) = 64 AND pending_request_fingerprint NOT GLOB '*[^0-9a-f]*' AND
      pending_next_cumulative IS NOT NULL AND length(pending_next_cumulative) BETWEEN 1 AND 39 AND pending_next_cumulative NOT GLOB '*[^0-9]*' AND
      pending_next_cumulative <> '0' AND substr(pending_next_cumulative, 1, 1) <> '0' AND
      pending_attempt_token IS NOT NULL AND length(pending_attempt_token) = 64 AND pending_attempt_token NOT GLOB '*[^0-9a-f]*')
  ),
  CHECK (
    pending_next_cumulative IS NULL OR
    length(pending_next_cumulative) > length(cumulative_base_units) OR
    (length(pending_next_cumulative) = length(cumulative_base_units) AND pending_next_cumulative > cumulative_base_units)
  ),
  CHECK (
    pending_next_cumulative IS NULL OR
    length(pending_next_cumulative) < length(cap_base_units) OR
    (length(pending_next_cumulative) = length(cap_base_units) AND pending_next_cumulative <= cap_base_units)
  )
) WITHOUT ROWID;

CREATE TABLE ap4m_evm_attempts (
  principal TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128 AND substr(idempotency_key, 1, 1) GLOB '[A-Za-z0-9]' AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  merchant_id TEXT NOT NULL,
  previous_cumulative TEXT NOT NULL CHECK (length(previous_cumulative) BETWEEN 1 AND 39 AND previous_cumulative NOT GLOB '*[^0-9]*' AND (previous_cumulative = '0' OR substr(previous_cumulative, 1, 1) <> '0')),
  next_cumulative TEXT NOT NULL CHECK (length(next_cumulative) BETWEEN 1 AND 39 AND next_cumulative NOT GLOB '*[^0-9]*' AND next_cumulative <> '0' AND substr(next_cumulative, 1, 1) <> '0'),
  attempt_token TEXT NOT NULL CHECK (length(attempt_token) = 64 AND attempt_token NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'submission_unknown', 'confirmed', 'failed_absent')),
  tx_hash TEXT CHECK (tx_hash IS NULL OR (length(tx_hash) = 66 AND substr(tx_hash, 1, 2) = '0x' AND substr(tx_hash, 3) NOT GLOB '*[^0-9a-f]*')),
  receipt_fingerprint TEXT CHECK (receipt_fingerprint IS NULL OR (length(receipt_fingerprint) = 64 AND receipt_fingerprint NOT GLOB '*[^0-9a-f]*')),
  block_number INTEGER,
  confirmations INTEGER,
  absence_fingerprint TEXT CHECK (absence_fingerprint IS NULL OR (length(absence_fingerprint) = 64 AND absence_fingerprint NOT GLOB '*[^0-9a-f]*')),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  PRIMARY KEY (principal, channel_id, idempotency_key),
  FOREIGN KEY (principal, channel_id) REFERENCES ap4m_evm_channels(principal, channel_id),
  CHECK (
    length(next_cumulative) > length(previous_cumulative) OR
    (length(next_cumulative) = length(previous_cumulative) AND next_cumulative > previous_cumulative)
  ),
  CHECK (
    (status = 'prepared' AND tx_hash IS NULL AND receipt_fingerprint IS NULL AND block_number IS NULL AND confirmations IS NULL AND absence_fingerprint IS NULL)
    OR (status = 'submission_unknown' AND tx_hash IS NOT NULL AND receipt_fingerprint IS NULL AND block_number IS NULL AND confirmations IS NULL AND absence_fingerprint IS NULL)
    OR (status = 'confirmed' AND tx_hash IS NOT NULL AND receipt_fingerprint IS NOT NULL AND block_number IS NOT NULL AND confirmations IS NOT NULL AND confirmations > 0 AND absence_fingerprint IS NULL)
    OR (status = 'failed_absent' AND tx_hash IS NOT NULL AND receipt_fingerprint IS NULL AND block_number IS NULL AND confirmations IS NULL AND absence_fingerprint IS NOT NULL)
  )
) WITHOUT ROWID;

CREATE UNIQUE INDEX idx_ap4m_evm_attempt_tx_hash ON ap4m_evm_attempts(tx_hash) WHERE tx_hash IS NOT NULL;
CREATE INDEX idx_ap4m_evm_attempt_status ON ap4m_evm_attempts(principal, status, updated_at);

CREATE TABLE ap4m_evm_journal (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  principal TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('reserved', 'submission_unknown', 'confirmed', 'failed_absent')),
  transition_key TEXT NOT NULL CHECK (length(transition_key) = 64 AND transition_key NOT GLOB '*[^0-9a-f]*'),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40),
  FOREIGN KEY (principal, channel_id, idempotency_key)
    REFERENCES ap4m_evm_attempts(principal, channel_id, idempotency_key),
  UNIQUE (principal, channel_id, idempotency_key, event, transition_key)
);

CREATE INDEX idx_ap4m_evm_journal_attempt
  ON ap4m_evm_journal(principal, channel_id, idempotency_key, sequence);
