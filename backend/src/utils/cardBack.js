const { normalizeUploadedImage } = require('./uploadedImage');

async function normalizeCardBack(body, preserveWebp = false) {
  const invalid = () => Object.assign(new Error('Invalid card back: choose a #RRGGBB color, a PNG/JPEG/WebP image, or neither'), { status: 400 });
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'color') || !Object.hasOwn(body, 'image')
      || (body.color !== null && (typeof body.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(body.color)))
      || (body.image !== null && typeof body.image !== 'string')
      || (body.color !== null && body.image !== null)) throw invalid();
  if (body.image === null) return { card_back_color: body.color?.toUpperCase() ?? null, card_back_image: null };
  try {
    return { card_back_color: null, card_back_image: await normalizeUploadedImage(body.image, 488, 680, preserveWebp) };
  } catch {
    throw invalid();
  }
}

module.exports = { normalizeCardBack };
