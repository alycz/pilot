ALTER TABLE links RENAME TO links_before_aws_kms_delegate_keys;

CREATE TABLE links (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  owner TEXT NOT NULL,
  network TEXT NOT NULL,
  delegate TEXT NOT NULL,
  delegate_seed_enc BLOB,
  iv BLOB,
  key_backend TEXT NOT NULL DEFAULT 'local' CHECK (key_backend IN ('local', 'kms')),
  kms_key_id TEXT,
  kms_alias TEXT,
  permissions TEXT NOT NULL,
  status TEXT NOT NULL,
  last_ledger INTEGER,
  revoke_tx TEXT,
  created_at TEXT NOT NULL,
  frozen_at TEXT,
  frozen_reason TEXT,
  UNIQUE (principal, owner, network),
  CHECK (
    (
      key_backend = 'local' AND
      delegate_seed_enc IS NOT NULL AND
      iv IS NOT NULL AND
      kms_key_id IS NULL AND
      kms_alias IS NULL
    ) OR (
      key_backend = 'kms' AND
      delegate_seed_enc IS NULL AND
      iv IS NULL AND
      kms_key_id IS NOT NULL AND
      length(kms_key_id) > 0 AND
      kms_alias IS NOT NULL AND
      kms_alias = 'alias/harbor/' || network || '/' || id
    )
  )
);

INSERT INTO links (
  id, principal, owner, network, delegate, delegate_seed_enc, iv,
  key_backend, kms_key_id, kms_alias, permissions, status, last_ledger,
  revoke_tx, created_at, frozen_at, frozen_reason
)
SELECT
  id, principal, owner, network, delegate, delegate_seed_enc, iv,
  'local', NULL, NULL, permissions, status, last_ledger,
  revoke_tx, created_at, frozen_at, frozen_reason
FROM links_before_aws_kms_delegate_keys;

DROP TABLE links_before_aws_kms_delegate_keys;
