-- 0025_filename_templates_per_template.sql
--
-- Re-key filename_templates from document kinds (quote_pdf, quote_docx)
-- to template catalog keys (quote-service, quote-spares, oc-eps, ntp, …).
-- Each row in TEMPLATE_CATALOG now has a matching filename convention
-- that users edit inline on the Templates list page (/documents/templates).
--
-- The stored template no longer contains a file extension — the
-- generate handler appends `.pdf` / `.docx` at render time so a single
-- convention covers both formats of the same document.
--
-- OC and NTP generators don't exist yet; their rows are seeded
-- pre-emptively so when the generators land they have defaults
-- already configured.

DELETE FROM filename_templates;

INSERT INTO filename_templates (key, template, description, updated_at) VALUES
  ('quote-service',             'C-LARS Quote {quoteNumber}{revisionSuffix}', 'Service quote download',             CURRENT_TIMESTAMP),
  ('quote-spares',              'C-LARS Quote {quoteNumber}{revisionSuffix}', 'Spares quote download',              CURRENT_TIMESTAMP),
  ('quote-eps',                 'C-LARS Quote {quoteNumber}{revisionSuffix}', 'EPS quote download',                 CURRENT_TIMESTAMP),
  ('quote-refurb-baseline',     'C-LARS Quote {quoteNumber}{revisionSuffix}', 'Refurb Baseline quote download',     CURRENT_TIMESTAMP),
  ('quote-refurb-modified',     'C-LARS Quote {quoteNumber}{revisionSuffix}', 'Refurb Modified quote download',     CURRENT_TIMESTAMP),
  ('quote-refurb-supplemental', 'C-LARS Quote {quoteNumber}{revisionSuffix}', 'Refurb Supplemental quote download', CURRENT_TIMESTAMP),
  ('quote-hybrid',              'C-LARS Quote {quoteNumber}{revisionSuffix}', 'Hybrid (multi-type) quote download', CURRENT_TIMESTAMP),
  ('oc-eps',                    'C-LARS OC {ocNumber}',                       'EPS Order Confirmation download',    CURRENT_TIMESTAMP),
  ('oc-spares',                 'C-LARS OC {ocNumber}',                       'Spares Order Confirmation download', CURRENT_TIMESTAMP),
  ('oc-service',                'C-LARS OC {ocNumber}',                       'Service Order Confirmation download',CURRENT_TIMESTAMP),
  ('oc-refurb',                 'C-LARS OC {ocNumber}',                       'Refurb Order Confirmation download', CURRENT_TIMESTAMP),
  ('ntp',                       'C-LARS NTP {ntpNumber}',                     'Notice to Proceed download',         CURRENT_TIMESTAMP);
