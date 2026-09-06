export function onRequestGet() {
  return Response.json({ok: true, app: 'ConsultaMed', version: '2.3'});
}
