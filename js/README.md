# Vendored client-side JS

HTMX and Alpine.js will be vendored here in M2 so the layout's
`<script defer src="/js/htmx.min.js">` and
`<script defer src="/js/alpine.min.js">` resolve cleanly.

We vendor (not CDN) because Cloudflare Access + CSP behave better when
scripts come from the same origin.

M1 pages do not rely on HTMX or Alpine, so the 404s during M1 are
harmless.
