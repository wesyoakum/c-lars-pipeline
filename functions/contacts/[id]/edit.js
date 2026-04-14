// functions/contacts/[id]/edit.js
//
// GET /contacts/:id/edit — redirects to the inline-editable detail page.
// The separate edit form has been replaced by click-to-edit on the
// detail page (/contacts/:id).

export async function onRequestGet(context) {
  const contactId = context.params.id;
  return new Response(null, {
    status: 302,
    headers: { Location: `/contacts/${contactId}` },
  });
}
