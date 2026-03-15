-- Add 'auto_topup' to credit_transactions type check
ALTER TABLE credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_type_check;
ALTER TABLE credit_transactions ADD CONSTRAINT credit_transactions_type_check
  CHECK (type IN ('purchase', 'usage', 'refund', 'auto_topup'));
