-- 0098: Task scheduling — "visible after" date
--
-- Allows tasks to be hidden from the list until a specific date.
-- Tasks with visible_after in the future won't appear in the default view.

ALTER TABLE activities ADD COLUMN visible_after TEXT;
