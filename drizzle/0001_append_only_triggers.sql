-- Enforce append-only at the database level for `ledger` and
-- `subscriber_events`. This is not a convention services are trusted to
-- respect — it is structurally impossible to UPDATE or DELETE a row in
-- either table, full stop, including from a superuser session unless the
-- trigger itself is dropped first.
--
-- `ledger` is the source of truth for every financial claim the system
-- makes; `subscriber_events` is the source of truth for engagement history
-- that cohort retention curves depend on. Both must be perfectly append-only
-- or every downstream number becomes disputable.

CREATE OR REPLACE FUNCTION reject_update_or_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % is not permitted on table %. Correct mistakes with a new, offsetting row instead.',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER ledger_no_update
  BEFORE UPDATE ON "ledger"
  FOR EACH ROW EXECUTE FUNCTION reject_update_or_delete();
--> statement-breakpoint

CREATE TRIGGER ledger_no_delete
  BEFORE DELETE ON "ledger"
  FOR EACH ROW EXECUTE FUNCTION reject_update_or_delete();
--> statement-breakpoint

CREATE TRIGGER subscriber_events_no_update
  BEFORE UPDATE ON "subscriber_events"
  FOR EACH ROW EXECUTE FUNCTION reject_update_or_delete();
--> statement-breakpoint

CREATE TRIGGER subscriber_events_no_delete
  BEFORE DELETE ON "subscriber_events"
  FOR EACH ROW EXECUTE FUNCTION reject_update_or_delete();
