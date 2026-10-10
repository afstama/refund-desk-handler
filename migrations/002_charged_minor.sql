-- What an approved refund counts against its order, in the ORDER'S currency.
-- It equals amount_minor when the refund and the order share a currency (always, for an automatic approval).
-- When a person approves a refund in another currency, it is the amount converted at the fixed rates.
-- So orders.refunded_minor is always the sum of charged_minor over the order's approved refunds.
ALTER TABLE refunds ADD COLUMN charged_minor bigint CHECK (charged_minor IS NULL OR charged_minor > 0);

UPDATE refunds SET charged_minor = amount_minor WHERE decision IN ('auto_approved', 'approved');

-- charged_minor is set exactly when the refund is approved (automatically or by a person)
ALTER TABLE refunds
  ADD CONSTRAINT refunds_charged_matches_decision
  CHECK ((charged_minor IS NOT NULL) = (decision IN ('auto_approved', 'approved')));
