// functions/sandbox/counties.js
//
// GET /sandbox/counties — kept as a thin 302 redirect to the unified
// /sandbox/us-map?layer=counties. The standalone counties map was
// folded into the US-Map platform; any old bookmarks land here and
// get forwarded to the right layer.

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

export async function onRequestGet(context) {
  const user = context.data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }
  return new Response(null, {
    status: 302,
    headers: { Location: '/sandbox/us-map?layer=counties' },
  });
}
