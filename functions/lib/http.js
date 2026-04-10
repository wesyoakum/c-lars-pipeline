// functions/lib/http.js
//
// Tiny HTTP helpers that route handlers reach for a lot: building
// redirects (POST-redirect-GET pattern) and parsing form bodies into
// plain objects.

/**
 * Build a 303 See Other redirect response. 303 is the correct status
 * for "I processed your POST, now GET this other URL" — it tells the
 * browser to use GET even though the original request was POST, which
 * is exactly what we want after a form submission.
 */
export function redirect(location, opts = {}) {
  return new Response(null, {
    status: opts.status ?? 303,
    headers: {
      Location: location,
      ...(opts.headers ?? {}),
    },
  });
}

/**
 * Parse a form-encoded or multipart request body into a plain object.
 * Multiple values for the same key become an array. Returns {} on an
 * empty body rather than throwing, which makes handlers a bit friendlier.
 */
export async function formBody(request) {
  let data;
  try {
    data = await request.formData();
  } catch {
    return {};
  }
  const obj = {};
  for (const [k, v] of data.entries()) {
    if (k in obj) {
      if (!Array.isArray(obj[k])) obj[k] = [obj[k]];
      obj[k].push(v);
    } else {
      obj[k] = v;
    }
  }
  return obj;
}

/**
 * Build a cookie-flash-ish redirect: encode a short message into a
 * query-string param so the destination page can render it in a flash
 * banner. No cookies = no middleware parsing. Meant for "Created X",
 * "Saved", "Deleted Y" style notifications after a mutation.
 */
export function redirectWithFlash(location, message, kind = 'success') {
  const url = new URL(location, 'https://dummy.local');
  url.searchParams.set('flash', message);
  url.searchParams.set('flash_kind', kind);
  // Strip the dummy origin so we return a relative location.
  return redirect(url.pathname + url.search);
}

/**
 * Extract a flash message set by redirectWithFlash() from the current
 * request URL. Returns null if no flash is present.
 */
export function readFlash(url) {
  const message = url.searchParams.get('flash');
  if (!message) return null;
  return {
    message,
    kind: url.searchParams.get('flash_kind') || 'info',
  };
}
