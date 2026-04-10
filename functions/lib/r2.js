// functions/lib/r2.js
//
// R2 upload/download helpers. R2 is the blob store for documents —
// RFQ PDFs, customer POs, signed OCs, NTPs, drawings, supplier quotes.
//
// Key namespacing: `opp/<opportunity_id>/<uuid>-<safe_filename>` so
// artifacts attached to an opportunity stay grouped in listings and
// deletions can cascade by prefix if we ever need to purge an opp.
//
// TODO(M6): implement multipart upload handler, signed download URLs,
// mime-type sniffing, max-size enforcement (e.g. 50 MB cap).

export function buildR2Key(opportunityId, filename) {
  const safe = (filename ?? 'file')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'file';
  return `opp/${opportunityId}/${crypto.randomUUID()}-${safe}`;
}

/**
 * Upload a File/Blob to R2 and return the stored key.
 */
export async function uploadToR2(docsBinding, key, file, metadata = {}) {
  await docsBinding.put(key, file.stream(), {
    httpMetadata: {
      contentType: file.type || 'application/octet-stream',
    },
    customMetadata: metadata,
  });
  return key;
}

/**
 * Fetch an object from R2 and return a streaming Response.
 * The caller is responsible for auth / ACL checks before calling this.
 */
export async function streamFromR2(docsBinding, key) {
  const obj = await docsBinding.get(key);
  if (!obj) {
    return new Response('Not found', { status: 404 });
  }
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  return new Response(obj.body, { headers });
}

/**
 * Delete an R2 object by key.
 */
export async function deleteFromR2(docsBinding, key) {
  await docsBinding.delete(key);
}
