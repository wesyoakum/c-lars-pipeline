-- Add original_filename column to documents so we can show
-- the filename separately from the user-editable title.
ALTER TABLE documents ADD COLUMN original_filename TEXT;
