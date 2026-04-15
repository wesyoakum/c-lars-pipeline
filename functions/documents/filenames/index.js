// functions/documents/filenames/index.js
//
// The dedicated "Download filenames" admin page was removed — filename
// conventions are now edited inline on /documents/templates, one per
// template catalog row. This route stays as a permanent redirect so
// old bookmarks don't 404.

export async function onRequestGet(context) {
  return Response.redirect(
    new URL('/documents/templates', context.request.url),
    302
  );
}
