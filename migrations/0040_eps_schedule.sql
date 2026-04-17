-- Migration 0040 — EPS default payment schedule
--
-- Moves the hardcoded EPS default payment schedule
-- (25% PO / 25% w/3 wks ARO / 25% 2w/3 wks ARO / 15% FAT / 10% docs)
-- out of the quote detail page and into an admin-editable JSON blob
-- on site_prefs. Admins can now change the percentages, labels, number
-- of milestones, and the ARO-weeks formula from /settings.
--
-- Shape: JSON { rows: [ {percent, label, weeks_num?, weeks_den?}, … ] }
--
--   percent     — number 0-100. All rows must sum to exactly 100.
--   label       — milestone description. May contain "{weeks}" which
--                 gets replaced with floor(weeks_num * W / weeks_den)
--                 at render time, where W = parsed delivery weeks.
--   weeks_num,
--   weeks_den   — optional positive integers. If either is present,
--                 both must be; omit both for a static label.
--
-- Rendering: each row becomes "<percent>% <label>" on its own line,
-- identical to the output of the old epsDefaultTerms(weeks) JS.
--
-- Column is nullable TEXT; NULL means "use the hardcoded DEFAULT_EPS
-- fallback in lib/eps-schedule.js". The seed below writes the current
-- default verbatim so admins can edit-in-place from day one.

ALTER TABLE site_prefs ADD COLUMN eps_schedule TEXT;

UPDATE site_prefs
SET eps_schedule = '{"rows":[' ||
      '{"percent":25,"label":"Due upon receipt of purchase order"},' ||
      '{"percent":25,"label":"Due {weeks} weeks ARO","weeks_num":1,"weeks_den":3},' ||
      '{"percent":25,"label":"Due {weeks} weeks ARO","weeks_num":2,"weeks_den":3},' ||
      '{"percent":15,"label":"Due upon completion of FAT"},' ||
      '{"percent":10,"label":"Due upon delivery of final documentation"}' ||
    ']}'
WHERE id = 1;
