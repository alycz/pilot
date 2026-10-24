-- An XRPL account has one authenticated strategy authority domain in one
-- Harbor database. Multiple strategies for that same principal remain valid,
-- while a second principal can never acquire the same owner/network scope.
-- Existing conflicting rows intentionally make this migration fail closed.

CREATE TABLE strategy_owner_scopes (
  owner TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network = 'testnet'),
  principal TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner, network)
);

INSERT OR ABORT INTO strategy_owner_scopes(owner, network, principal, created_at)
SELECT owner, network, principal, MIN(created_at)
FROM (
  SELECT owner, network, principal, created_at FROM strategies
  UNION ALL
  SELECT owner, network, principal, updated_at AS created_at
  FROM strategy_global_controls
)
GROUP BY owner, network, principal;

CREATE TRIGGER strategy_owner_scope_before_strategy_insert
BEFORE INSERT ON strategies
WHEN EXISTS (
  SELECT 1 FROM strategy_owner_scopes
  WHERE owner = NEW.owner AND network = NEW.network
    AND principal <> NEW.principal
)
BEGIN
  SELECT RAISE(ABORT, 'owner/network strategy scope belongs to another principal');
END;

CREATE TRIGGER strategy_owner_scope_after_strategy_insert
AFTER INSERT ON strategies
BEGIN
  INSERT OR IGNORE INTO strategy_owner_scopes(owner, network, principal, created_at)
  VALUES (NEW.owner, NEW.network, NEW.principal, NEW.created_at);
END;

CREATE TRIGGER strategy_owner_scope_before_control_insert
BEFORE INSERT ON strategy_global_controls
WHEN EXISTS (
  SELECT 1 FROM strategy_owner_scopes
  WHERE owner = NEW.owner AND network = NEW.network
    AND principal <> NEW.principal
)
BEGIN
  SELECT RAISE(ABORT, 'owner/network strategy scope belongs to another principal');
END;

CREATE TRIGGER strategy_owner_scope_after_control_insert
AFTER INSERT ON strategy_global_controls
BEGIN
  INSERT OR IGNORE INTO strategy_owner_scopes(owner, network, principal, created_at)
  VALUES (NEW.owner, NEW.network, NEW.principal, NEW.updated_at);
END;
