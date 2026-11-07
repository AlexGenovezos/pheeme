-- Gmail's mailbox size at the start of a backfill. NULL for existing accounts
-- until their next backfill page reads a profile.
ALTER TABLE sync_state ADD COLUMN mailbox_messages_total INTEGER;
