// functions/sandbox/index.js
//
// GET /sandbox — redirects to /sandbox/assistant (Claudia is the
// default sandbox tab now). The Flow Chart wrapper that used to
// live here moved to /sandbox/flow-chart so the redirect is unambiguous.
//
// Wes-only — same email gate as the rest of /sandbox/*.

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

export async function onRequestGet(context) {
  const user = context.data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }
  return new Response(null, {
    status: 302,
    headers: { Location: '/sandbox/assistant' },
  });
}
