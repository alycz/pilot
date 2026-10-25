CREATE TABLE ap4m_channel_claims (
  principal TEXT NOT NULL CHECK (
    length(principal) BETWEEN 1 AND 256 AND instr(principal, char(0)) = 0
  ),
  mandate_id TEXT NOT NULL CHECK (
    length(mandate_id) BETWEEN 1 AND 128 AND
    substr(mandate_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    mandate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  merchant_id TEXT NOT NULL CHECK (
    length(merchant_id) BETWEEN 1 AND 128 AND
    substr(merchant_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    merchant_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  channel_id TEXT NOT NULL CHECK (
    length(channel_id) = 64 AND channel_id NOT GLOB '*[^0-9A-F]*'
  ),
  payer TEXT NOT NULL CHECK (
    length(payer) BETWEEN 25 AND 64 AND substr(payer, 1, 1) = 'r' AND
    payer NOT GLOB '*[^A-Za-z0-9]*'
  ),
  channel_amount_drops TEXT NOT NULL CHECK (
    length(channel_amount_drops) BETWEEN 1 AND 18 AND
    channel_amount_drops NOT GLOB '*[^0-9]*' AND
    channel_amount_drops <> '0' AND substr(channel_amount_drops, 1, 1) <> '0' AND
    (length(channel_amount_drops) < 18 OR channel_amount_drops <= '100000000000000000')
  ),
  public_key TEXT NOT NULL CHECK (
    length(public_key) = 66 AND substr(public_key, 1, 2) IN ('ED', '02', '03') AND
    public_key NOT GLOB '*[^0-9A-F]*'
  ),
  cumulative_drops TEXT NOT NULL DEFAULT '0' CHECK (
    length(cumulative_drops) BETWEEN 1 AND 18 AND
    cumulative_drops NOT GLOB '*[^0-9]*' AND
    (cumulative_drops = '0' OR substr(cumulative_drops, 1, 1) <> '0') AND
    (length(cumulative_drops) < 18 OR cumulative_drops <= '100000000000000000')
  ),
  last_price_drops TEXT,
  last_idempotency_key TEXT,
  signature TEXT,
  pending_idempotency_key TEXT,
  pending_price_drops TEXT,
  pending_cumulative_drops TEXT,
  pending_token TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  PRIMARY KEY (principal, channel_id),
  UNIQUE (principal, mandate_id, merchant_id),
  FOREIGN KEY (mandate_id) REFERENCES ap4m_mandates(id),
  CHECK (CAST(cumulative_drops AS INTEGER) <= CAST(channel_amount_drops AS INTEGER)),
  CHECK (
    (last_price_drops IS NULL AND last_idempotency_key IS NULL AND signature IS NULL)
    OR
    (last_price_drops IS NOT NULL AND
      length(last_price_drops) BETWEEN 1 AND 18 AND
      last_price_drops NOT GLOB '*[^0-9]*' AND last_price_drops <> '0' AND
      substr(last_price_drops, 1, 1) <> '0' AND
      (length(last_price_drops) < 18 OR last_price_drops <= '100000000000000000') AND
      CAST(last_price_drops AS INTEGER) <= CAST(cumulative_drops AS INTEGER) AND
      last_idempotency_key IS NOT NULL AND length(last_idempotency_key) BETWEEN 1 AND 128 AND
      substr(last_idempotency_key, 1, 1) GLOB '[A-Za-z0-9]' AND
      last_idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      signature IS NOT NULL AND length(signature) BETWEEN 2 AND 256 AND
      length(signature) % 2 = 0 AND signature NOT GLOB '*[^0-9A-F]*')
  ),
  CHECK (
    (pending_idempotency_key IS NULL AND pending_price_drops IS NULL AND
      pending_cumulative_drops IS NULL AND pending_token IS NULL)
    OR
    (pending_idempotency_key IS NOT NULL AND length(pending_idempotency_key) BETWEEN 1 AND 128 AND
      substr(pending_idempotency_key, 1, 1) GLOB '[A-Za-z0-9]' AND
      pending_idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      pending_price_drops IS NOT NULL AND length(pending_price_drops) BETWEEN 1 AND 18 AND
      pending_price_drops NOT GLOB '*[^0-9]*' AND pending_price_drops <> '0' AND
      substr(pending_price_drops, 1, 1) <> '0' AND
      (length(pending_price_drops) < 18 OR pending_price_drops <= '100000000000000000') AND
      pending_cumulative_drops IS NOT NULL AND length(pending_cumulative_drops) BETWEEN 1 AND 18 AND
      pending_cumulative_drops NOT GLOB '*[^0-9]*' AND pending_cumulative_drops <> '0' AND
      substr(pending_cumulative_drops, 1, 1) <> '0' AND
      (length(pending_cumulative_drops) < 18 OR pending_cumulative_drops <= '100000000000000000') AND
      CAST(pending_cumulative_drops AS INTEGER) =
        CAST(cumulative_drops AS INTEGER) + CAST(pending_price_drops AS INTEGER) AND
      CAST(pending_cumulative_drops AS INTEGER) <= CAST(channel_amount_drops AS INTEGER) AND
      pending_token IS NOT NULL AND length(pending_token) = 64 AND
      pending_token NOT GLOB '*[^0-9A-F]*')
  )
) WITHOUT ROWID;

CREATE INDEX idx_ap4m_channel_claims_mandate
  ON ap4m_channel_claims(principal, mandate_id, merchant_id, channel_id);

CREATE TABLE ap4m_channel_claim_attempts (
  principal TEXT NOT NULL CHECK (
    length(principal) BETWEEN 1 AND 256 AND instr(principal, char(0)) = 0
  ),
  channel_id TEXT NOT NULL CHECK (
    length(channel_id) = 64 AND channel_id NOT GLOB '*[^0-9A-F]*'
  ),
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 1 AND 128 AND
    substr(idempotency_key, 1, 1) GLOB '[A-Za-z0-9]' AND
    idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  merchant_id TEXT NOT NULL CHECK (
    length(merchant_id) BETWEEN 1 AND 128 AND
    substr(merchant_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    merchant_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  price_drops TEXT NOT NULL CHECK (
    length(price_drops) BETWEEN 1 AND 18 AND price_drops NOT GLOB '*[^0-9]*' AND
    price_drops <> '0' AND substr(price_drops, 1, 1) <> '0' AND
    (length(price_drops) < 18 OR price_drops <= '100000000000000000')
  ),
  cumulative_drops TEXT NOT NULL CHECK (
    length(cumulative_drops) BETWEEN 1 AND 18 AND cumulative_drops NOT GLOB '*[^0-9]*' AND
    cumulative_drops <> '0' AND substr(cumulative_drops, 1, 1) <> '0' AND
    (length(cumulative_drops) < 18 OR cumulative_drops <= '100000000000000000')
  ),
  claim_token TEXT NOT NULL CHECK (
    length(claim_token) = 64 AND claim_token NOT GLOB '*[^0-9A-F]*'
  ),
  public_key TEXT NOT NULL CHECK (
    length(public_key) = 66 AND substr(public_key, 1, 2) IN ('ED', '02', '03') AND
    public_key NOT GLOB '*[^0-9A-F]*'
  ),
  signature TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  PRIMARY KEY (principal, channel_id, idempotency_key),
  FOREIGN KEY (principal, channel_id) REFERENCES ap4m_channel_claims(principal, channel_id),
  CHECK (
    (status = 'pending' AND signature IS NULL)
    OR
    (status = 'completed' AND signature IS NOT NULL AND
      length(signature) BETWEEN 2 AND 256 AND length(signature) % 2 = 0 AND
      signature NOT GLOB '*[^0-9A-F]*')
  )
) WITHOUT ROWID;

CREATE TABLE ap4m_paychan_purchase_attempts (
  principal TEXT NOT NULL CHECK (
    length(principal) BETWEEN 1 AND 256 AND instr(principal, char(0)) = 0
  ),
  mandate_id TEXT NOT NULL CHECK (
    length(mandate_id) BETWEEN 1 AND 128 AND
    substr(mandate_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    mandate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 1 AND 128 AND
    substr(idempotency_key, 1, 1) GLOB '[A-Za-z0-9]' AND
    idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 256 AND instr(id, char(0)) = 0),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9A-F]*'
  ),
  network TEXT NOT NULL CHECK (network = 'testnet'),
  rail TEXT NOT NULL CHECK (rail = 'xrpl-paychan'),
  merchant_id TEXT NOT NULL CHECK (
    length(merchant_id) BETWEEN 1 AND 128 AND
    substr(merchant_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    merchant_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  sku TEXT NOT NULL CHECK (length(sku) BETWEEN 1 AND 200 AND instr(sku, char(0)) = 0),
  merchant_snapshot_json TEXT NOT NULL CHECK (
    length(merchant_snapshot_json) BETWEEN 2 AND 65536 AND json_valid(merchant_snapshot_json)
  ),
  payer TEXT NOT NULL CHECK (
    length(payer) BETWEEN 25 AND 64 AND substr(payer, 1, 1) = 'r' AND
    payer NOT GLOB '*[^A-Za-z0-9]*'
  ),
  channel_id TEXT NOT NULL CHECK (
    length(channel_id) = 64 AND channel_id NOT GLOB '*[^0-9A-F]*'
  ),
  channel_amount_drops TEXT NOT NULL CHECK (
    length(channel_amount_drops) BETWEEN 1 AND 18 AND
    channel_amount_drops NOT GLOB '*[^0-9]*' AND channel_amount_drops <> '0' AND
    substr(channel_amount_drops, 1, 1) <> '0' AND
    (length(channel_amount_drops) < 18 OR channel_amount_drops <= '100000000000000000')
  ),
  price_drops TEXT NOT NULL CHECK (
    length(price_drops) BETWEEN 1 AND 18 AND price_drops NOT GLOB '*[^0-9]*' AND
    price_drops <> '0' AND substr(price_drops, 1, 1) <> '0' AND
    (length(price_drops) < 18 OR price_drops <= '100000000000000000')
  ),
  previous_drops TEXT NOT NULL CHECK (
    length(previous_drops) BETWEEN 1 AND 18 AND previous_drops NOT GLOB '*[^0-9]*' AND
    (previous_drops = '0' OR substr(previous_drops, 1, 1) <> '0') AND
    (length(previous_drops) < 18 OR previous_drops <= '100000000000000000')
  ),
  cumulative_drops TEXT NOT NULL CHECK (
    length(cumulative_drops) BETWEEN 1 AND 18 AND cumulative_drops NOT GLOB '*[^0-9]*' AND
    cumulative_drops <> '0' AND substr(cumulative_drops, 1, 1) <> '0' AND
    (length(cumulative_drops) < 18 OR cumulative_drops <= '100000000000000000')
  ),
  claim_token TEXT NOT NULL CHECK (
    length(claim_token) = 64 AND claim_token NOT GLOB '*[^0-9A-F]*'
  ),
  public_key TEXT NOT NULL CHECK (
    length(public_key) = 66 AND substr(public_key, 1, 2) IN ('ED', '02', '03') AND
    public_key NOT GLOB '*[^0-9A-F]*'
  ),
  signature TEXT,
  spend_id TEXT NOT NULL,
  spend_day TEXT NOT NULL CHECK (length(spend_day) = 10),
  amount_usd TEXT NOT NULL CHECK (
    length(amount_usd) BETWEEN 1 AND 80 AND amount_usd NOT GLOB '*[^0-9.]*' AND
    substr(amount_usd, 1, 1) GLOB '[0-9]' AND substr(amount_usd, -1, 1) GLOB '[0-9]' AND
    amount_usd NOT LIKE '%.%.%' AND
    (amount_usd = '0' OR substr(amount_usd, 1, 1) <> '0' OR substr(amount_usd, 1, 2) = '0.') AND
    (instr(amount_usd, '.') = 0 OR
      length(amount_usd) - instr(amount_usd, '.') BETWEEN 1 AND 6)
  ),
  intent_id TEXT NOT NULL CHECK (length(intent_id) BETWEEN 1 AND 256 AND instr(intent_id, char(0)) = 0),
  l3a_digest TEXT NOT NULL CHECK (
    length(l3a_digest) = 64 AND l3a_digest NOT GLOB '*[^0-9a-f]*'
  ),
  l3b_digest TEXT NOT NULL CHECK (
    length(l3b_digest) = 64 AND l3b_digest NOT GLOB '*[^0-9a-f]*'
  ),
  retry_material_enc BLOB NOT NULL CHECK (length(retry_material_enc) > 16),
  retry_material_iv BLOB NOT NULL CHECK (length(retry_material_iv) = 12),
  retry_material_digest TEXT NOT NULL CHECK (
    length(retry_material_digest) = 64 AND retry_material_digest NOT GLOB '*[^0-9A-F]*'
  ),
  receipt_id TEXT NOT NULL CHECK (
    length(receipt_id) BETWEEN 1 AND 256 AND instr(receipt_id, char(0)) = 0
  ),
  merchant_response_json TEXT CHECK (
    merchant_response_json IS NULL OR
    (length(merchant_response_json) BETWEEN 2 AND 1048576 AND json_valid(merchant_response_json))
  ),
  result_json TEXT CHECK (
    result_json IS NULL OR (length(result_json) BETWEEN 2 AND 1048576 AND json_valid(result_json))
  ),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'claim_signed', 'merchant_accepted', 'delivered')),
  accepted_at TEXT CHECK (accepted_at IS NULL OR length(accepted_at) BETWEEN 20 AND 40),
  delivered_at TEXT CHECK (delivered_at IS NULL OR length(delivered_at) BETWEEN 20 AND 40),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  PRIMARY KEY (principal, mandate_id, idempotency_key),
  UNIQUE (principal, id),
  UNIQUE (principal, spend_id),
  UNIQUE (principal, receipt_id),
  FOREIGN KEY (mandate_id) REFERENCES ap4m_mandates(id),
  FOREIGN KEY (spend_id) REFERENCES ap4m_spend(id),
  FOREIGN KEY (principal, channel_id, idempotency_key)
    REFERENCES ap4m_channel_claim_attempts(principal, channel_id, idempotency_key),
  CHECK (
    CAST(previous_drops AS INTEGER) + CAST(price_drops AS INTEGER) =
      CAST(cumulative_drops AS INTEGER) AND
    CAST(cumulative_drops AS INTEGER) <= CAST(channel_amount_drops AS INTEGER)
  ),
  CHECK (
    (status = 'reserved' AND signature IS NULL AND
      merchant_response_json IS NULL AND result_json IS NULL AND
      accepted_at IS NULL AND delivered_at IS NULL)
    OR
    (status = 'claim_signed' AND signature IS NOT NULL AND
      merchant_response_json IS NULL AND result_json IS NULL AND
      accepted_at IS NULL AND delivered_at IS NULL)
    OR
    (status = 'merchant_accepted' AND signature IS NOT NULL AND
      merchant_response_json IS NOT NULL AND result_json IS NULL AND
      accepted_at IS NOT NULL AND delivered_at IS NULL)
    OR
    (status = 'delivered' AND signature IS NOT NULL AND
      merchant_response_json IS NOT NULL AND result_json IS NOT NULL AND
      accepted_at IS NOT NULL AND delivered_at IS NOT NULL)
  ),
  CHECK (
    signature IS NULL OR
    (length(signature) BETWEEN 2 AND 256 AND length(signature) % 2 = 0 AND
      signature NOT GLOB '*[^0-9A-F]*')
  )
) WITHOUT ROWID;

CREATE INDEX idx_ap4m_paychan_purchase_recovery
  ON ap4m_paychan_purchase_attempts(principal, status, updated_at);

CREATE INDEX idx_ap4m_paychan_purchase_channel
  ON ap4m_paychan_purchase_attempts(principal, channel_id, created_at);

CREATE TRIGGER trg_ap4m_channel_claim_mandate_insert
BEFORE INSERT ON ap4m_channel_claims
WHEN NOT EXISTS (
  SELECT 1 FROM ap4m_mandates mandate
  WHERE mandate.principal = NEW.principal AND mandate.id = NEW.mandate_id
    AND mandate.network = 'testnet'
)
BEGIN
  SELECT RAISE(ABORT, 'channel claim mandate binding mismatch');
END;

CREATE TRIGGER trg_ap4m_channel_claim_mandate_update
BEFORE UPDATE OF principal, mandate_id ON ap4m_channel_claims
WHEN NOT EXISTS (
  SELECT 1 FROM ap4m_mandates mandate
  WHERE mandate.principal = NEW.principal AND mandate.id = NEW.mandate_id
    AND mandate.network = 'testnet'
)
BEGIN
  SELECT RAISE(ABORT, 'channel claim mandate binding mismatch');
END;

CREATE TRIGGER trg_ap4m_channel_claim_binding_immutable
BEFORE UPDATE OF principal, mandate_id, merchant_id, channel_id, payer,
  channel_amount_drops, public_key
ON ap4m_channel_claims
WHEN OLD.principal <> NEW.principal OR OLD.mandate_id <> NEW.mandate_id
  OR OLD.merchant_id <> NEW.merchant_id OR OLD.channel_id <> NEW.channel_id
  OR OLD.payer <> NEW.payer OR OLD.channel_amount_drops <> NEW.channel_amount_drops
  OR OLD.public_key <> NEW.public_key
BEGIN
  SELECT RAISE(ABORT, 'channel claim binding mismatch');
END;

CREATE TRIGGER trg_ap4m_channel_attempt_binding_insert
BEFORE INSERT ON ap4m_channel_claim_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM ap4m_channel_claims claim
  WHERE claim.principal = NEW.principal AND claim.channel_id = NEW.channel_id
    AND claim.merchant_id = NEW.merchant_id AND claim.public_key = NEW.public_key
    AND claim.pending_idempotency_key = NEW.idempotency_key
    AND claim.pending_price_drops = NEW.price_drops
    AND claim.pending_cumulative_drops = NEW.cumulative_drops
    AND claim.pending_token = NEW.claim_token
)
BEGIN
  SELECT RAISE(ABORT, 'channel claim attempt binding mismatch');
END;

CREATE TRIGGER trg_ap4m_channel_attempt_binding_update
BEFORE UPDATE OF principal, channel_id, idempotency_key, merchant_id, price_drops,
  cumulative_drops, claim_token, public_key, signature, status
ON ap4m_channel_claim_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM ap4m_channel_claims claim
  WHERE claim.principal = NEW.principal AND claim.channel_id = NEW.channel_id
    AND claim.merchant_id = NEW.merchant_id AND claim.public_key = NEW.public_key
    AND claim.pending_idempotency_key = NEW.idempotency_key
    AND claim.pending_price_drops = NEW.price_drops
    AND claim.pending_cumulative_drops = NEW.cumulative_drops
    AND claim.pending_token = NEW.claim_token
)
BEGIN
  SELECT RAISE(ABORT, 'channel claim attempt binding mismatch');
END;

CREATE TRIGGER trg_ap4m_paychan_purchase_binding_insert
BEFORE INSERT ON ap4m_paychan_purchase_attempts
WHEN NOT EXISTS (
  SELECT 1
  FROM ap4m_channel_claim_attempts attempt
  JOIN ap4m_channel_claims claim
    ON claim.principal = attempt.principal AND claim.channel_id = attempt.channel_id
  JOIN ap4m_mandates mandate
    ON mandate.principal = claim.principal AND mandate.id = claim.mandate_id
  JOIN ap4m_spend spend
    ON spend.principal = claim.principal AND spend.mandate_id = claim.mandate_id
      AND spend.id = NEW.spend_id
  WHERE attempt.principal = NEW.principal AND attempt.channel_id = NEW.channel_id
    AND attempt.idempotency_key = NEW.idempotency_key
    AND attempt.merchant_id = NEW.merchant_id AND attempt.price_drops = NEW.price_drops
    AND attempt.cumulative_drops = NEW.cumulative_drops
    AND attempt.claim_token = NEW.claim_token AND attempt.public_key = NEW.public_key
    AND claim.mandate_id = NEW.mandate_id AND claim.merchant_id = NEW.merchant_id
    AND claim.payer = NEW.payer AND claim.channel_amount_drops = NEW.channel_amount_drops
    AND claim.public_key = NEW.public_key AND mandate.network = 'testnet'
    AND spend.idempotency_key = NEW.idempotency_key AND spend.spend_day = NEW.spend_day
    AND spend.amount_usd = NEW.amount_usd AND spend.status = 'reserved'
    AND ((NEW.signature IS NULL AND attempt.status = 'pending' AND attempt.signature IS NULL
        AND claim.pending_idempotency_key = NEW.idempotency_key
        AND claim.pending_price_drops = NEW.price_drops
        AND claim.pending_cumulative_drops = NEW.cumulative_drops
        AND claim.pending_token = NEW.claim_token)
      OR (NEW.signature IS NOT NULL AND attempt.status = 'completed'
        AND attempt.signature = NEW.signature
        AND claim.last_idempotency_key = NEW.idempotency_key
        AND claim.last_price_drops = NEW.price_drops
        AND claim.cumulative_drops = NEW.cumulative_drops
        AND claim.signature = NEW.signature))
)
BEGIN
  SELECT RAISE(ABORT, 'paychan purchase claim binding mismatch');
END;

CREATE TRIGGER trg_ap4m_paychan_purchase_binding_update
BEFORE UPDATE OF principal, mandate_id, idempotency_key, merchant_id, payer, channel_id,
  channel_amount_drops, price_drops, cumulative_drops, claim_token, public_key, signature,
  spend_id, spend_day, amount_usd
ON ap4m_paychan_purchase_attempts
WHEN NOT EXISTS (
  SELECT 1
  FROM ap4m_channel_claim_attempts attempt
  JOIN ap4m_channel_claims claim
    ON claim.principal = attempt.principal AND claim.channel_id = attempt.channel_id
  JOIN ap4m_mandates mandate
    ON mandate.principal = claim.principal AND mandate.id = claim.mandate_id
  JOIN ap4m_spend spend
    ON spend.principal = claim.principal AND spend.mandate_id = claim.mandate_id
      AND spend.id = NEW.spend_id
  WHERE attempt.principal = NEW.principal AND attempt.channel_id = NEW.channel_id
    AND attempt.idempotency_key = NEW.idempotency_key
    AND attempt.merchant_id = NEW.merchant_id AND attempt.price_drops = NEW.price_drops
    AND attempt.cumulative_drops = NEW.cumulative_drops
    AND attempt.claim_token = NEW.claim_token AND attempt.public_key = NEW.public_key
    AND claim.mandate_id = NEW.mandate_id AND claim.merchant_id = NEW.merchant_id
    AND claim.payer = NEW.payer AND claim.channel_amount_drops = NEW.channel_amount_drops
    AND claim.public_key = NEW.public_key AND mandate.network = 'testnet'
    AND spend.idempotency_key = NEW.idempotency_key AND spend.spend_day = NEW.spend_day
    AND spend.amount_usd = NEW.amount_usd AND spend.status = 'reserved'
    AND ((NEW.signature IS NULL AND attempt.status = 'pending' AND attempt.signature IS NULL
        AND claim.pending_idempotency_key = NEW.idempotency_key
        AND claim.pending_price_drops = NEW.price_drops
        AND claim.pending_cumulative_drops = NEW.cumulative_drops
        AND claim.pending_token = NEW.claim_token)
      OR (NEW.signature IS NOT NULL AND attempt.status = 'completed'
        AND attempt.signature = NEW.signature
        AND claim.last_idempotency_key = NEW.idempotency_key
        AND claim.last_price_drops = NEW.price_drops
        AND claim.cumulative_drops = NEW.cumulative_drops
        AND claim.signature = NEW.signature))
)
BEGIN
  SELECT RAISE(ABORT, 'paychan purchase claim binding mismatch');
END;

CREATE TRIGGER trg_ap4m_paychan_receipt_binding_insert
BEFORE INSERT ON ap4m_receipts
WHEN EXISTS (
  SELECT 1 FROM ap4m_paychan_purchase_attempts purchase
  WHERE purchase.principal = NEW.principal AND purchase.mandate_id = NEW.mandate_id
    AND purchase.idempotency_key = NEW.idempotency_key
) AND NOT EXISTS (
  SELECT 1
  FROM ap4m_paychan_purchase_attempts purchase
  JOIN ap4m_spend spend ON spend.id = purchase.spend_id
  WHERE purchase.principal = NEW.principal AND purchase.mandate_id = NEW.mandate_id
    AND purchase.idempotency_key = NEW.idempotency_key
    AND purchase.status = 'merchant_accepted' AND purchase.merchant_response_json IS NOT NULL
    AND purchase.receipt_id = NEW.id AND purchase.merchant_id = NEW.merchant_id
    AND spend.principal = purchase.principal AND spend.mandate_id = purchase.mandate_id
    AND spend.idempotency_key = purchase.idempotency_key AND spend.spend_day = purchase.spend_day
    AND spend.amount_usd = purchase.amount_usd AND spend.status = 'reserved'
    AND spend.receipt_id IS NULL
    AND json_valid(NEW.json) AND json_type(NEW.json) = 'object'
    AND json_extract(NEW.json, '$.receipt_id') = purchase.receipt_id
    AND json_extract(NEW.json, '$.mandate_id') = purchase.mandate_id
    AND json_extract(NEW.json, '$.merchant_id') = purchase.merchant_id
    AND json_extract(NEW.json, '$.sku') = purchase.sku
    AND json_extract(NEW.json, '$.intent_id') = purchase.intent_id
    AND json_extract(NEW.json, '$.l3a_digest') = purchase.l3a_digest
    AND json_extract(NEW.json, '$.l3b_digest') = purchase.l3b_digest
    AND json_extract(NEW.json, '$.scheme') = 'xrpl-paychan'
    AND json_extract(NEW.json, '$.settlement') = 'claim_accepted'
    AND json_extract(NEW.json, '$.proof.channel_id') = purchase.channel_id
    AND json_extract(NEW.json, '$.proof.cumulative_drops') = purchase.cumulative_drops
    AND json_extract(NEW.json, '$.amount.value') = purchase.amount_usd
)
BEGIN
  SELECT RAISE(ABORT, 'paychan receipt binding mismatch');
END;

CREATE TRIGGER trg_ap4m_paychan_delivered_update
BEFORE UPDATE OF status, result_json, delivered_at ON ap4m_paychan_purchase_attempts
WHEN NEW.status = 'delivered' AND OLD.status <> 'delivered' AND NOT EXISTS (
  SELECT 1
  FROM ap4m_spend spend
  JOIN ap4m_receipts receipt ON receipt.id = NEW.receipt_id
  WHERE spend.id = NEW.spend_id AND spend.principal = NEW.principal
    AND spend.mandate_id = NEW.mandate_id AND spend.idempotency_key = NEW.idempotency_key
    AND spend.spend_day = NEW.spend_day AND spend.amount_usd = NEW.amount_usd
    AND spend.status = 'committed' AND spend.receipt_id = NEW.receipt_id
    AND receipt.principal = NEW.principal AND receipt.mandate_id = NEW.mandate_id
    AND receipt.merchant_id = NEW.merchant_id AND receipt.idempotency_key = NEW.idempotency_key
    AND json_valid(receipt.json) AND json_valid(NEW.result_json)
    AND json_type(NEW.result_json) = 'object'
    AND json(json_extract(NEW.result_json, '$.receipt')) = json(receipt.json)
)
BEGIN
  SELECT RAISE(ABORT, 'paychan delivered binding mismatch');
END;

CREATE TRIGGER trg_ap4m_exact_excludes_paychan_insert
BEFORE INSERT ON ap4m_purchase_attempts
WHEN EXISTS (
  SELECT 1 FROM ap4m_paychan_purchase_attempts paychan
  WHERE paychan.principal = NEW.principal AND paychan.mandate_id = NEW.mandate_id
    AND paychan.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'idempotency key already belongs to paychan rail');
END;

CREATE TRIGGER trg_ap4m_paychan_excludes_exact_insert
BEFORE INSERT ON ap4m_paychan_purchase_attempts
WHEN EXISTS (
  SELECT 1 FROM ap4m_purchase_attempts exact
  WHERE exact.principal = NEW.principal AND exact.mandate_id = NEW.mandate_id
    AND exact.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'idempotency key already belongs to exact rail');
END;
CREATE TRIGGER trg_ap4m_exact_excludes_paychan_update
BEFORE UPDATE OF principal, mandate_id, idempotency_key ON ap4m_purchase_attempts
WHEN EXISTS (
  SELECT 1 FROM ap4m_paychan_purchase_attempts paychan
  WHERE paychan.principal = NEW.principal AND paychan.mandate_id = NEW.mandate_id
    AND paychan.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'idempotency key already belongs to paychan rail');
END;

CREATE TRIGGER trg_ap4m_paychan_excludes_exact_update
BEFORE UPDATE OF principal, mandate_id, idempotency_key ON ap4m_paychan_purchase_attempts
WHEN EXISTS (
  SELECT 1 FROM ap4m_purchase_attempts exact
  WHERE exact.principal = NEW.principal AND exact.mandate_id = NEW.mandate_id
    AND exact.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'idempotency key already belongs to exact rail');
END;
