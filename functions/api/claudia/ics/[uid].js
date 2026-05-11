// functions/api/claudia/ics/[uid].js
//
// GET /api/claudia/ics/:uid — download a previously-generated ICS that
// Claudia's `create_ics_file` tool wrote to R2. Returned as a download
// so the user can open it in their calendar app.
//
// Auth: any signed-in user. Files are not user-scoped at the key
// level — the uid is a random UUID, so the key itself is the cap.
// If we ever expose Claudia to multiple operators, scope by user_id
// in the key prefix instead.

const ICS_PREFIX = 'claudia-ics/';

export async function onRequestGet(context) {
  const { env, data, params } = context;
  const user = data?.user;
  if (!user) return new Response('Sign in required', { status: 401 });

  const uid = String(params.uid || '').trim();
  if (!uid || !/^[A-Za-z0-9_-]+$/.test(uid)) {
    return new Response('Invalid uid', { status: 400 });
  }

  const key = `${ICS_PREFIX}${uid}.ics`;
  const obj = await env.DOCS.get(key);
  if (!obj) return new Response('Not found', { status: 404 });

  const filename = obj.customMetadata?.filename || `claudia-${uid}.ics`;

  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
      'Cache-Control': 'no-store',
    },
  });
}
