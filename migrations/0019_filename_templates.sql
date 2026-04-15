-- 0019_filename_templates.sql
--
-- Configurable download filename templates for generated documents.
-- Users edit these at /documents/filenames. The `{token}` substitution
-- is handled by renderFilenameTemplate() in functions/lib/filename-templates.js.
--
-- Each row maps a document kind (matching the `documents.kind` column
-- that storeGeneratedDoc writes) to a template string. At generation
-- time the helper substitutes placeholders with values from the quote
-- / opportunity / account context.
--
-- Seeded with the two kinds that currently have generate handlers
-- (quote_pdf, quote_docx). Add more rows as OC / NTP generators land.

CREATE TABLE filename_templates (
  key         TEXT PRIMARY KEY,
  template    TEXT NOT NULL,
  description TEXT,
  updated_at  TEXT NOT NULL
);

INSERT INTO filename_templates (key, template, description, updated_at) VALUES
  ('quote_pdf',  'C-LARS Quote {quoteNumber}{revisionSuffix}.pdf',  'Filename for generated quote PDFs',           CURRENT_TIMESTAMP),
  ('quote_docx', 'C-LARS Quote {quoteNumber}{revisionSuffix}.docx', 'Filename for generated quote Word documents', CURRENT_TIMESTAMP);
