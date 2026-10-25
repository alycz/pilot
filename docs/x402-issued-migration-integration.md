# Issued x402 migration integration handoff

Apply this only after the coordinated PR12/PR13 rebase. The feature branch does
not modify the conductor-owned generated profile or integrity manifests.

Source migration:

- `services/harbor/migrations-local-x402/0010_issued_x402_authority.sql`
- SHA-256: `40aea548d97d9b985bb92e21b07d2ff04d4087948b56d2ff0c3c8b7558f803de`

Required integration patch:

1. Append `0010_issued_x402_authority.sql` to
   `X402_ISOLATED_V1_MIGRATIONS` in
   `services/harbor/scripts/isolated-migration-profiles.mjs`.
2. Add the filename and SHA-256 above to that profile's `sha256` map.
3. Regenerate the copied file under
   `services/harbor/migrations-profile-x402-isolated-v1/` through the normal
   profile generator; do not hand-edit the generated copy.
4. Append the migration name to `MIGRATION_NAMES` in
   `services/harbor/scripts/local-x402-isolated-state.mjs`, update its exact
   table/column/index inventory for the issued state, budget, lock and journal
   tables, then recompute the expected schema fingerprint with the repository's
   normal verifier.
5. Run the isolated migration-profile and state-root suites before refreshing
   the repository integrity manifest on the final rebased tree.

Bootstrap constructs no service until `D1IssuedX402State.recoverAll()` succeeds.
Recovery failure is terminal for that request/startup and must never be ignored
or converted into an empty state.
