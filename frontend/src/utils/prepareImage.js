export async function prepareImage(file, crop, maxWidth = 488, maxHeight = 680, maxPixels = Infinity) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('format');
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > maxPixels) throw new Error('size');
    const x = (crop?.x ?? 0) * bitmap.width;
    const y = (crop?.y ?? 0) * bitmap.height;
    const width = (crop?.width ?? 1) * bitmap.width;
    const height = (crop?.height ?? 1) * bitmap.height;
    const rotated = crop?.rotate === 90;
    const scale = Math.min(1, maxWidth / (rotated ? height : width), maxHeight / (rotated ? width : height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((rotated ? height : width) * scale));
    canvas.height = Math.max(1, Math.round((rotated ? width : height) * scale));
    const context = canvas.getContext('2d');
    if (rotated) context.setTransform(0, 1, -1, 0, canvas.width, 0);
    context.drawImage(bitmap, x, y, width, height, 0, 0, rotated ? canvas.height : canvas.width, rotated ? canvas.width : canvas.height);
    const image = canvas.toDataURL('image/webp', 0.82);
    if (!image.startsWith('data:image/webp;base64,') || image.length >= 500_000) throw new Error('size');
    return image;
  } finally {
    bitmap.close();
  }
}

export async function prepareStorageImage(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10_000_000) throw new Error('format');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const tag = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  // Reject animated sources before canvas flattens them to a single frame.
  if (file.type === 'image/png') {
    if (view.byteLength < 24 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) throw new Error('format');
    if (view.getUint32(16) * view.getUint32(20) > 20_000_000) throw new Error('size');
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      if (tag(offset + 4) === 'acTL') throw new Error('animation');
      if (offset + length + 12 > bytes.length) throw new Error('format');
      offset += length + 12;
    }
  } else if (file.type === 'image/webp') {
    if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP') throw new Error('format');
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const length = view.getUint32(offset + 4, true);
      if (['ANIM', 'ANMF'].includes(tag(offset)) || (tag(offset) === 'VP8X' && (bytes[offset + 8] & 2))) throw new Error('animation');
      if (offset + length + 8 > bytes.length) throw new Error('format');
      offset += length + 8 + (length % 2);
    }
  } else if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('format');
  return prepareImage(file, null, 980, 700, 20_000_000);
}
