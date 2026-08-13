-- Existing active rules predate the signed authority contract. Keep the
-- upgrade fail-closed and operator-visible: review + re-activation derives
-- and signs the exact current graph before it can execute again.
UPDATE `automation_rules`
SET `status`='paused'
WHERE `status`='active'
  AND (`authority_hash` IS NULL OR length(`authority_hash`) != 64);
