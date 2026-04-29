-- 0055_contact_linkedin.sql
--
-- v3+: AI-recommended LinkedIn URLs on contacts.
--
-- The AI Inbox extractor pulls LinkedIn URLs out of the source material
-- (business cards, email signatures, document text) when a profile URL
-- is explicitly present. The "↑ push" affordance on a matched person
-- writes the URL onto the contact row and marks it as ai_suggested so
-- the contacts list / detail page can surface it as a recommendation.
--
-- linkedin_url_source values:
--   'ai_suggested'  — AI Inbox pushed it; user has not confirmed
--   'user'          — user manually entered or confirmed the URL
--   NULL            — no URL set
--
-- We deliberately keep this on the contacts table (not contact-side
-- AI Inbox links) so the recommendation is visible everywhere a
-- contact is rendered, not only on the originating entry page.

ALTER TABLE contacts ADD COLUMN linkedin_url TEXT;
ALTER TABLE contacts ADD COLUMN linkedin_url_source TEXT;
