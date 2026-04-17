// functions/library/index.js
//
// GET /library — redirect to the first library sub-tab.
//
// Matches the Documents section pattern (/documents → /documents/library):
// the top-nav "Library" link opens straight into the first tab rather than
// a separate overview page. Sub-tab switching is handled by librarySubNav.

export async function onRequestGet(context) {
  return Response.redirect(
    new URL('/library/dm-items', context.request.url),
    302
  );
}
