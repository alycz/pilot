-- Forward-only hosted lifecycle for the canonical native-NEAR -> Arbitrum
-- canonical-USDC route. This migration is review-only until explicitly applied.
-- A reserved sidecar row is inserted in the same D1 batch as schema-0018's
-- attempt reservation. Later, one revision-guarded sidecar UPDATE drives the
-- base attempt/evidence/budget through triggers in the same SQL transaction.

CREATE TABLE near_native_to_arbitrum_usdc_lifecycles (
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 200),
  principal_id TEXT NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 200),
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 2 AND 64),
  network TEXT NOT NULL CHECK (network = 'near:mainnet'),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 200),
  reservation_id TEXT NOT NULL CHECK (length(reservation_id) BETWEEN 1 AND 200),
  approval_digest TEXT NOT NULL CHECK (
    length(approval_digest) = 64 AND approval_digest NOT GLOB '*[^0-9A-F]*'
  ),
  quote_id TEXT NOT NULL CHECK (length(quote_id) BETWEEN 1 AND 200),
  quote_hash TEXT NOT NULL CHECK (length(quote_hash) BETWEEN 43 AND 45),
  correlation_id TEXT NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 200),
  origin_chain TEXT NOT NULL CHECK (origin_chain = 'near'),
  origin_network TEXT NOT NULL CHECK (origin_network = 'near:mainnet'),
  origin_asset_id TEXT NOT NULL CHECK (origin_asset_id = 'nep141:wrap.near'),
  origin_token_contract TEXT NOT NULL CHECK (origin_token_contract = 'wrap.near'),
  origin_token_decimals INTEGER NOT NULL CHECK (origin_token_decimals = 24),
  source_transfer_asset TEXT NOT NULL CHECK (source_transfer_asset = 'native-near'),
  amount_yocto_near TEXT NOT NULL CHECK (
    length(amount_yocto_near) BETWEEN 1 AND 128
    AND amount_yocto_near NOT GLOB '*[^0-9]*'
    AND substr(amount_yocto_near, 1, 1) BETWEEN '1' AND '9'
  ),
  source_account_id TEXT NOT NULL CHECK (length(source_account_id) BETWEEN 2 AND 64),
  refund_account_id TEXT NOT NULL CHECK (length(refund_account_id) BETWEEN 2 AND 64),
  deposit_account_id TEXT NOT NULL CHECK (length(deposit_account_id) BETWEEN 2 AND 64),
  deposit_memo TEXT CHECK (deposit_memo IS NULL),
  source_transaction_hash TEXT CHECK (source_transaction_hash IS NULL OR length(source_transaction_hash) BETWEEN 43 AND 45),
  source_receipt_id TEXT CHECK (source_receipt_id IS NULL OR length(source_receipt_id) BETWEEN 43 AND 45),
  source_block_height INTEGER CHECK (source_block_height IS NULL OR source_block_height > 0),
  source_included_at TEXT,
  source_verified_at TEXT,
  destination_chain TEXT NOT NULL CHECK (destination_chain = 'arb'),
  destination_chain_id INTEGER NOT NULL CHECK (destination_chain_id = 42161),
  destination_asset_id TEXT NOT NULL CHECK (
    destination_asset_id = 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near'
  ),
  destination_token_contract TEXT NOT NULL CHECK (
    destination_token_contract = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
  ),
  destination_token_decimals INTEGER NOT NULL CHECK (destination_token_decimals = 6),
  destination_recipient TEXT NOT NULL CHECK (
    length(destination_recipient) = 42 AND substr(destination_recipient, 1, 2) = '0x'
    AND substr(destination_recipient, 3) NOT GLOB '*[^0-9a-f]*'
  ),
  min_amount_out TEXT NOT NULL CHECK (
    length(min_amount_out) BETWEEN 1 AND 128
    AND min_amount_out NOT GLOB '*[^0-9]*'
    AND substr(min_amount_out, 1, 1) BETWEEN '1' AND '9'
  ),
  destination_transaction_hash TEXT CHECK (
    destination_transaction_hash IS NULL OR (
      length(destination_transaction_hash) = 66
      AND substr(destination_transaction_hash, 1, 2) = '0x'
      AND substr(destination_transaction_hash, 3) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  destination_log_index INTEGER CHECK (destination_log_index IS NULL OR destination_log_index >= 0),
  refund_transaction_hash TEXT CHECK (refund_transaction_hash IS NULL OR length(refund_transaction_hash) BETWEEN 43 AND 45),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN (
    'reserved','source_verified','provider_observed','destination_verified','refunded'
  )),
  lifecycle_revision INTEGER NOT NULL CHECK (lifecycle_revision >= 0),
  entry_revision INTEGER NOT NULL CHECK (entry_revision >= 1),
  last_transition_id TEXT CHECK (last_transition_id IS NULL OR length(last_transition_id) BETWEEN 1 AND 200),
  last_evidence_kind TEXT CHECK (last_evidence_kind IS NULL OR last_evidence_kind IN (
    'source_funding','provider_observation','destination_receipt','refund_receipt'
  )),
  last_provider_status TEXT CHECK (last_provider_status IS NULL OR last_provider_status IN (
    'KNOWN_DEPOSIT_TX','PENDING_DEPOSIT','INCOMPLETE_DEPOSIT','PROCESSING','SUCCESS','REFUNDED','FAILED'
  )),
  last_evidence_digest TEXT CHECK (
    last_evidence_digest IS NULL OR (
      length(last_evidence_digest) = 64 AND last_evidence_digest NOT GLOB '*[^0-9A-F]*'
    )
  ),
  last_evidence_json TEXT CHECK (last_evidence_json IS NULL OR json_valid(last_evidence_json)),
  updated_at TEXT NOT NULL,
  counter_expected_atomic TEXT NOT NULL CHECK (
    length(counter_expected_atomic) BETWEEN 1 AND 128
    AND counter_expected_atomic NOT GLOB '*[^0-9]*'
    AND (counter_expected_atomic = '0' OR substr(counter_expected_atomic, 1, 1) BETWEEN '1' AND '9')
  ),
  counter_expected_revision INTEGER NOT NULL CHECK (counter_expected_revision >= 0),
  counter_next_atomic TEXT NOT NULL CHECK (
    length(counter_next_atomic) BETWEEN 1 AND 128
    AND counter_next_atomic NOT GLOB '*[^0-9]*'
    AND (counter_next_atomic = '0' OR substr(counter_next_atomic, 1, 1) BETWEEN '1' AND '9')
  ),
  PRIMARY KEY (tenant_id, principal_id, idempotency_key),
  UNIQUE (tenant_id, source_transaction_hash),
  UNIQUE (tenant_id, destination_transaction_hash, destination_log_index),
  UNIQUE (tenant_id, refund_transaction_hash),
  FOREIGN KEY (tenant_id, principal_id, idempotency_key)
    REFERENCES near_hosted_attempts(tenant_id, principal_id, idempotency_key),
  CHECK (account_id = source_account_id),
  CHECK ((destination_transaction_hash IS NULL) = (destination_log_index IS NULL)),
  CHECK (
    (lifecycle_state = 'reserved' AND lifecycle_revision = 0 AND entry_revision = 1
      AND source_transaction_hash IS NULL AND source_receipt_id IS NULL
      AND source_block_height IS NULL AND source_included_at IS NULL AND source_verified_at IS NULL
      AND last_transition_id IS NULL AND last_evidence_kind IS NULL
      AND last_provider_status IS NULL AND last_evidence_digest IS NULL AND last_evidence_json IS NULL)
    OR (lifecycle_state <> 'reserved' AND lifecycle_revision >= 1 AND entry_revision >= 2
      AND source_transaction_hash IS NOT NULL AND source_receipt_id IS NOT NULL
      AND source_block_height IS NOT NULL AND source_included_at IS NOT NULL AND source_verified_at IS NOT NULL
      AND last_transition_id IS NOT NULL AND last_evidence_kind IS NOT NULL
      AND last_evidence_digest IS NOT NULL AND last_evidence_json IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_near_native_to_arbitrum_usdc_scope
  ON near_native_to_arbitrum_usdc_lifecycles(tenant_id, principal_id, account_id, network, lifecycle_state);

CREATE TRIGGER near_native_to_arbitrum_usdc_binding_admission
AFTER INSERT ON near_native_to_arbitrum_usdc_lifecycles
BEGIN
  SELECT RAISE(ABORT, 'near native-to-arbitrum binding has no exact reservation')
  WHERE NOT EXISTS (
    SELECT 1 FROM near_hosted_attempts
    WHERE tenant_id = NEW.tenant_id AND principal_id = NEW.principal_id
      AND account_id = NEW.account_id AND idempotency_key = NEW.idempotency_key
      AND attempt_id = NEW.attempt_id AND reservation_id = NEW.reservation_id
      AND approval_digest = NEW.approval_digest AND quote_id = NEW.quote_id
      AND quote_hash = NEW.quote_hash AND asset_id = NEW.origin_asset_id
      AND amount_atomic = NEW.amount_yocto_near
      AND deposit_address = NEW.deposit_account_id AND deposit_memo IS NULL
      AND state = 'approved' AND reservation_state = 'reserved' AND entry_revision = 1
  );
END;

CREATE TRIGGER near_native_to_arbitrum_usdc_immutable_binding
BEFORE UPDATE ON near_native_to_arbitrum_usdc_lifecycles
WHEN NEW.tenant_id IS NOT OLD.tenant_id OR NEW.principal_id IS NOT OLD.principal_id
  OR NEW.account_id IS NOT OLD.account_id OR NEW.network IS NOT OLD.network
  OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.reservation_id IS NOT OLD.reservation_id OR NEW.approval_digest IS NOT OLD.approval_digest
  OR NEW.quote_id IS NOT OLD.quote_id OR NEW.quote_hash IS NOT OLD.quote_hash
  OR NEW.correlation_id IS NOT OLD.correlation_id OR NEW.origin_chain IS NOT OLD.origin_chain
  OR NEW.origin_network IS NOT OLD.origin_network OR NEW.origin_asset_id IS NOT OLD.origin_asset_id
  OR NEW.origin_token_contract IS NOT OLD.origin_token_contract
  OR NEW.origin_token_decimals IS NOT OLD.origin_token_decimals
  OR NEW.source_transfer_asset IS NOT OLD.source_transfer_asset
  OR NEW.amount_yocto_near IS NOT OLD.amount_yocto_near
  OR NEW.source_account_id IS NOT OLD.source_account_id
  OR NEW.refund_account_id IS NOT OLD.refund_account_id
  OR NEW.deposit_account_id IS NOT OLD.deposit_account_id OR NEW.deposit_memo IS NOT OLD.deposit_memo
  OR NEW.destination_chain IS NOT OLD.destination_chain
  OR NEW.destination_chain_id IS NOT OLD.destination_chain_id
  OR NEW.destination_asset_id IS NOT OLD.destination_asset_id
  OR NEW.destination_token_contract IS NOT OLD.destination_token_contract
  OR NEW.destination_token_decimals IS NOT OLD.destination_token_decimals
  OR NEW.destination_recipient IS NOT OLD.destination_recipient
  OR NEW.min_amount_out IS NOT OLD.min_amount_out
  OR (OLD.source_transaction_hash IS NOT NULL AND (
    NEW.source_transaction_hash IS NOT OLD.source_transaction_hash
    OR NEW.source_receipt_id IS NOT OLD.source_receipt_id
    OR NEW.source_block_height IS NOT OLD.source_block_height
    OR NEW.source_included_at IS NOT OLD.source_included_at
    OR NEW.source_verified_at IS NOT OLD.source_verified_at
  ))
BEGIN
  SELECT RAISE(ABORT, 'near native-to-arbitrum immutable binding changed');
END;

CREATE TRIGGER near_native_to_arbitrum_usdc_transition_guard
BEFORE UPDATE ON near_native_to_arbitrum_usdc_lifecycles
BEGIN
  SELECT RAISE(ABORT, 'near native-to-arbitrum revision conflict')
    WHERE NEW.lifecycle_revision <> OLD.lifecycle_revision + 1
      OR NEW.entry_revision <> OLD.entry_revision + 1
      OR NEW.updated_at < OLD.updated_at;
  SELECT RAISE(ABORT, 'near native-to-arbitrum terminal state is immutable')
    WHERE OLD.lifecycle_state IN ('destination_verified','refunded');
  SELECT RAISE(ABORT, 'near native-to-arbitrum transition invalid')
    WHERE NOT (
      (OLD.lifecycle_state = 'reserved' AND NEW.lifecycle_state = 'source_verified'
        AND NEW.last_evidence_kind = 'source_funding'
        AND OLD.source_transaction_hash IS NULL AND NEW.source_transaction_hash IS NOT NULL
        AND NEW.source_receipt_id IS NOT NULL AND NEW.source_block_height IS NOT NULL
        AND NEW.source_included_at IS NOT NULL AND NEW.source_verified_at IS NOT NULL
        AND NEW.last_provider_status IS NULL)
      OR (NEW.last_evidence_kind = 'provider_observation'
        AND OLD.lifecycle_state IN ('source_verified','provider_observed')
        AND NEW.lifecycle_state = 'provider_observed'
        AND NEW.source_transaction_hash IS OLD.source_transaction_hash
        AND NEW.destination_transaction_hash IS NULL AND NEW.refund_transaction_hash IS NULL)
      OR (NEW.last_evidence_kind = 'destination_receipt'
        AND OLD.lifecycle_state IN ('source_verified','provider_observed')
        AND NEW.lifecycle_state = 'destination_verified'
        AND OLD.last_provider_status = 'SUCCESS' AND NEW.last_provider_status = 'SUCCESS'
        AND NEW.destination_transaction_hash IS NOT NULL AND NEW.destination_log_index IS NOT NULL
        AND NEW.refund_transaction_hash IS NULL)
      OR (NEW.last_evidence_kind = 'refund_receipt'
        AND OLD.lifecycle_state IN ('source_verified','provider_observed')
        AND NEW.lifecycle_state = 'refunded' AND NEW.last_provider_status = 'REFUNDED'
        AND NEW.refund_transaction_hash IS NOT NULL AND NEW.destination_transaction_hash IS NULL)
    );
  SELECT RAISE(ABORT, 'near native-to-arbitrum refund counter invalid')
    WHERE NEW.lifecycle_state = 'refunded' AND NOT (
      length(NEW.counter_next_atomic) < length(NEW.counter_expected_atomic)
      OR (length(NEW.counter_next_atomic) = length(NEW.counter_expected_atomic)
        AND NEW.counter_next_atomic < NEW.counter_expected_atomic)
    );
END;

CREATE TRIGGER near_native_to_arbitrum_usdc_update_attempt
AFTER UPDATE ON near_native_to_arbitrum_usdc_lifecycles
BEGIN
  UPDATE near_hosted_attempts SET
    state = CASE NEW.lifecycle_state WHEN 'destination_verified' THEN 'settled'
      WHEN 'refunded' THEN 'refunded' ELSE 'unknown' END,
    reservation_state = CASE NEW.lifecycle_state WHEN 'destination_verified' THEN 'committed'
      WHEN 'refunded' THEN 'released' ELSE 'outcome_unknown' END,
    provider_status = CASE NEW.lifecycle_state WHEN 'destination_verified' THEN 'SUCCESS'
      WHEN 'refunded' THEN 'REFUNDED' ELSE NULL END,
    entry_revision = entry_revision + 1, reservation_revision = reservation_revision + 1,
    updated_at = NEW.updated_at,
    unknown_since = CASE WHEN NEW.lifecycle_state IN ('destination_verified','refunded')
      THEN NULL ELSE COALESCE(unknown_since, NEW.updated_at) END,
    last_transition_id = NEW.last_transition_id,
    last_evidence_outcome = CASE WHEN NEW.lifecycle_state IN ('destination_verified','refunded')
      THEN 'terminal' ELSE 'unknown' END,
    last_provider_status = CASE NEW.lifecycle_state WHEN 'destination_verified' THEN 'SUCCESS'
      WHEN 'refunded' THEN 'REFUNDED' ELSE NULL END,
    last_unknown_reason = CASE WHEN NEW.lifecycle_state IN ('destination_verified','refunded')
      THEN NULL ELSE 'unavailable' END,
    last_evidence_digest = CASE WHEN NEW.lifecycle_state IN ('destination_verified','refunded')
      THEN NEW.last_evidence_digest ELSE NULL END,
    last_safe_to_resubmit = 0, last_evidence_json = NEW.last_evidence_json,
    counter_expected_atomic = NEW.counter_expected_atomic,
    counter_expected_revision = NEW.counter_expected_revision,
    counter_next_atomic = NEW.counter_next_atomic
  WHERE tenant_id = NEW.tenant_id AND principal_id = NEW.principal_id
    AND account_id = NEW.account_id AND idempotency_key = NEW.idempotency_key
    AND attempt_id = NEW.attempt_id AND reservation_id = NEW.reservation_id
    AND approval_digest = NEW.approval_digest AND entry_revision = OLD.entry_revision
    AND ((OLD.lifecycle_state = 'reserved' AND state = 'approved' AND reservation_state = 'reserved')
      OR (OLD.lifecycle_state <> 'reserved' AND state = 'unknown' AND reservation_state = 'outcome_unknown'));
  SELECT RAISE(ABORT, 'near native-to-arbitrum transition CAS conflict') WHERE changes() <> 1;
END;
