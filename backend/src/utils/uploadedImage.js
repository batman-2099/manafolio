const sharp = require('sharp');

async function normalizeUploadedImage(value, width, height, preserveWebp = false) {
  const invalid = () => Object.assign(new Error('Invalid image: choose a PNG, JPEG or WebP image under 700 KB'), { status: 400 });
  if (typeof value !== 'string' || value.length > 700000) throw invalid();
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) throw invalid();
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.toString('base64') !== match[2]) throw invalid();
  // Sharp decodes only the first APNG frame, so reject its animation control chunk explicitly.
  if (match[1] === 'png') {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') throw invalid();
      offset += 12 + length;
    }
  }
  try {
    const image = sharp(bytes, { limitInputPixels: 20000000, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== match[1] || (metadata.pages ?? 1) !== 1) throw invalid();
    // Decode preserved backups to validate the pixels without another lossy generation.
    if (preserveWebp && metadata.format === 'webp' && metadata.width <= width && metadata.height <= height
        && !metadata.orientation && !metadata.exif && !metadata.icc && !metadata.xmp && !metadata.iptc) {
      await image.stats();
      return value;
    }
    const normalized = await image.rotate().resize({ width, height, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
    const result = `data:image/webp;base64,${normalized.toString('base64')}`;
    if (result.length > 700000) throw invalid();
    return result;
  } catch {
    throw invalid();
  }
}

module.exports = { normalizeUploadedImage };
