const { spawn } = require('child_process');
const sharp = require('sharp');

const MIN_CONFIDENCE = 70;
const MAX_OUTPUT = 256 * 1024;
let active = 0;

// Only footer identities: never correct OCR characters into a plausible catalog ID.
function parsePrintingTsv(tsv, { setCodes = [] } = {}) {
  const known = new Set(setCodes.filter(code => typeof code === 'string' && /^[a-z0-9]{2,6}$/i.test(code))
    .map(code => code.toLowerCase()));
  const lines = new Map();
  for (const row of String(tsv).split('\n')) {
    const cells = row.trimEnd().split('\t');
    if (cells.length !== 12 || cells[0] !== '5' || !cells[11].trim()) continue;
    const confidence = Number(cells[10]);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) continue;
    const key = cells.slice(1, 5).join(':');
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push({ text: cells[11].trim(), confidence });
  }
  const sets = new Map();
  const numbers = new Map();
  for (const words of lines.values()) {
    const text = words.map(word => word.text).join(' ');
    // A language marker prevents artist names and copyright text becoming set codes.
    const set = /^([a-z0-9]{2,6})\s+(?:[^a-z0-9\s]{1,3}\s*)?(?:EN|DE|FR|IT|ES|PT|JA|JP|KO|KR|RU|CS|CT|ZHS|ZHT)\b/i.exec(text);
    if (set && /[a-z]/i.test(set[1]) && (!known.size || known.has(set[1].toLowerCase()))
        && words[0].confidence >= MIN_CONFIDENCE) {
      sets.set(set[1].toLowerCase(), words[0].confidence);
    }
    // Modern number + rarity, old number/total, or a standalone number beside a set line.
    const collector = /^(\d{1,5}[a-z]?)\s*\/\s*(\d{1,5})(?=\s|$)/i.exec(text)
      || /^(\d{1,5}[a-z]?)\s+([CURMLSTPB])(?=\s|$)/i.exec(text)
      || /^[CURMLSTPB]\s+(\d{1,5}[a-z]?)(?=\s|$)/i.exec(text)
      || /^(\d{1,5}[a-z]?)\s*$/i.exec(text);
    if (!collector || /^0+$/.test(collector[2] || '')) continue;
    const confidence = Math.min(...words.filter(word => /\d/.test(word.text)).map(word => word.confidence));
    if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) continue;
    const number = collector[1].toLowerCase().replace(/^0+(?=\d)/, '');
    numbers.set(number, { confidence, standalone: !collector[2] && words.length === 1 });
  }
  // Conflicting OCR readings are not a vote: neither identity is safe to assert.
  if (sets.size > 1 || numbers.size > 1) return { status: 'unreadable' };
  const [setCode, setConfidence] = sets.entries().next().value || [];
  const [number, numberReading] = numbers.entries().next().value || [];
  const evidence = {};
  if (setCode) evidence.setCode = setCode;
  if (number && (setCode || !numberReading.standalone)) evidence.number = number;
  const confidences = [];
  if (evidence.setCode) confidences.push(setConfidence);
  if (evidence.number) confidences.push(numberReading.confidence);
  if (confidences.length) evidence.confidence = Math.min(...confidences) / 100;
  return { status: evidence.setCode && evidence.number ? 'read' : 'unreadable', ...evidence };
}

function recognize(image) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/tesseract', ['stdin', 'stdout', '-l', 'eng', '--psm', '6', 'tsv'], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, OMP_THREAD_LIMIT: '1' },
    });
    let bytes = 0;
    let failure;
    const output = [];
    const errors = [];
    const stop = (error) => {
      failure ||= error;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop(new Error('Footer OCR timed out')), 5000);
    child.on('error', error => { failure = error; });
    child.stdin.on('error', error => stop(error));
    for (const [stream, chunks] of [[child.stdout, output], [child.stderr, errors]]) {
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) stop(new Error('Footer OCR exceeded output limit'));
        else chunks.push(chunk);
      });
      stream.on('error', error => stop(error));
    }
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Footer OCR exited ${code}: ${Buffer.concat(errors).toString('utf8').slice(0, 500)}`));
      else resolve(Buffer.concat(output).toString('utf8'));
    });
    child.stdin.end(image);
  });
}

async function readPrinting(rectifiedImageBuffer, { setCodes = [] } = {}) {
  // Bound work before decoding/spawning; busy callers get an explicit retryable error.
  if (!Buffer.isBuffer(rectifiedImageBuffer) || !rectifiedImageBuffer.length
      || rectifiedImageBuffer.length > 8 * 1024 * 1024 || !Array.isArray(setCodes) || active >= 2) {
    return { status: 'error' };
  }
  active++;
  try {
    const image = sharp(rectifiedImageBuffer, { limitInputPixels: 4 * 1024 * 1024, failOn: 'error' });
    const { width, height, pages } = await image.metadata();
    if (!width || !height || width < 128 || height < 128 || width > 2048 || height > 2048 || pages > 1) {
      return { status: 'error' };
    }
    // ponytail: footer-only OCR avoids full-card text; no card-name recognition needed.
    const top = Math.floor(height * 0.84);
    const footer = await image.extract({ left: 0, top, width: Math.ceil(width * 0.75), height: height - top })
      .flatten({ background: '#fff' }).grayscale().resize({ width: 1344 }).normalise().sharpen()
      .extend({ top: 16, bottom: 16, left: 16, right: 16, background: '#fff' })
      .timeout({ seconds: 3 }).png().toBuffer();
    return parsePrintingTsv(await recognize(footer), { setCodes });
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'unavailable' };
    console.warn('[scanOcr]', error.message);
    return { status: 'error' };
  } finally {
    active--;
  }
}

module.exports = { readPrinting, parsePrintingTsv };
