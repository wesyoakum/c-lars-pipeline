-- Reset the opportunity sequence so the next allocated number is 26001.
-- nextSequenceValue() does UPDATE next_value = next_value + 1 … RETURNING,
-- then returns (next_value - 1).  So storing 26001 yields 26001 on the
-- next call (26001 → 26002, return 26002 - 1 = 26001).
UPDATE sequences SET next_value = 26001 WHERE scope = 'opportunity';
