const sharp = require('sharp');

async function normalizeCardBack(body, preserveWebp = false) {
  const invalid = () => Object.assign(new Error('Invalid card back: choose a #RRGGBB color, a PNG/JPEG/WebP image, or neither'), { status: 400 });
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'color') || !Object.hasOwn(body, 'image')
      || (body.color !== null && (typeof body.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(body.color)))
      || (body.image !== null && typeof body.image !== 'string')
      || (body.color !== null && body.image !== null)) throw invalid();
  if (body.image === null) return { card_back_color: body.color?.toUpperCase() ?? null, card_back_image: null };
  if (body.image.length > 700000) throw invalid();
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(body.image);
  if (!match || match[2].length % 4 !== 0) throw invalid();
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.toString('base64') !== match[2]) throw invalid();
  try {
    const image = sharp(bytes, { limitInputPixels: 20000000, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== match[1] || (metadata.pages ?? 1) !== 1) throw invalid();
    const normalized = await image.rotate().resize({ width: 488, height: 680, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
    // Restoring an already-sized WebP must not introduce another lossy generation.
    if (preserveWebp && metadata.format === 'webp' && metadata.width <= 488 && metadata.height <= 680
        && !metadata.orientation && !metadata.exif && !metadata.icc && !metadata.xmp) {
      return { card_back_color: null, card_back_image: body.image };
    }
    return { card_back_color: null, card_back_image: `data:image/webp;base64,${normalized.toString('base64')}` };
  } catch {
    throw invalid();
  }
}

module.exports = { normalizeCardBack };
