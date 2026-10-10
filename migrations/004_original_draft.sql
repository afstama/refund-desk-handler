-- When the draft check finds a promise in the model's draft (a refund, an approval, money), the ledger must not show it:
-- draft_reply holds a neutral line instead (NEUTRAL_DRAFT in src/triage/guards.ts) and what the model wrote is kept here.
-- Not in the ledger. NULL for every draft that was kept as written.
ALTER TABLE messages ADD COLUMN original_draft text;
