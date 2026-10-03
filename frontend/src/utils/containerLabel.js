export function containerLabelUrl(id, publicBaseUrl, currentUrl) {
  if (!/^[1-9]\d*$/.test(String(id))) throw new Error('Invalid container');
  const url = publicBaseUrl ? new URL(publicBaseUrl) : new URL(new URL(currentUrl).pathname, currentUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid public URL');
  url.search = '';
  url.hash = '';
  url.searchParams.set('storageContainer', String(id));
  return url.href;
}

export async function containerLabelQr(url) {
  const { default: qrcode } = await import('qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  return qr;
}

export function pendingContainerLink() {
  const params = new URLSearchParams(window.location.search);
  let id = params.get('storageContainer');
  if (!id && (params.has('oidc_token') || params.has('oidc_error'))) {
    try { id = sessionStorage.getItem('manafolio_login_container'); } catch { /* optional browser storage */ }
  }
  return /^[1-9]\d*$/.test(id || '') ? id : null;
}
