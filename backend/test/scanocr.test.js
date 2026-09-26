const assert = require('assert');
const sharp = require('sharp');
const { parsePrintingTsv, readPrinting } = require('../src/utils/scanOcr');

function tsv(lines) {
  return lines.map((line, index) => line.map((word, column) => {
    const [text, confidence = 95] = Array.isArray(word) ? word : [word];
    return ['5', '1', '1', '1', index + 1, column + 1, column * 40, index * 30, '35', '20', confidence, text].join('\t');
  }).join('\n')).join('\n');
}

async function main() {
  const parse = (lines, setCodes = ['mkm', 'eld', 'msc', '2xm']) => parsePrintingTsv(tsv(lines), { setCodes });
  assert.deepStrictEqual(parse([['0012', 'R'], ['MKM', '•', 'EN']]), {
    status: 'read', setCode: 'mkm', number: '12', confidence: 0.95,
  });
  assert.deepStrictEqual(parse([['123/269', 'U'], ['ELD', '•', 'EN']]), {
    status: 'read', setCode: 'eld', number: '123', confidence: 0.95,
  });
  assert.equal(parse([['U', '0806', '-'], ['MSC', '«', 'EN', 'Artist']]).number, '806');
  assert.equal(parse([['0012a', 'R'], ['MKM', 'EN']]).number, '12a');
  assert.equal(parse([['123A', '/', '269', 'U'], ['ELD', 'EN']]).number, '123a');
  assert.equal(parse([['123/269', 'U'], ['2XM', 'EN']]).setCode, '2xm');
  assert.equal(parse([['0012'], ['MKM', 'EN']]).number, '12');
  assert.deepStrictEqual(parse([['123/269', 'U']]), { status: 'unreadable', number: '123', confidence: 0.95 });
  assert.deepStrictEqual(parse([['2024']]), { status: 'unreadable' });
  assert.equal(parse([['0012', 'R'], ['XXX', 'EN']]).status, 'unreadable');
  assert.equal(parse([['0012', 'R'], ['Artist', 'MKM', 'EN']]).status, 'unreadable');
  assert.equal(parse([['0012', 'R'], ['MKM', 'English']]).status, 'unreadable');
  assert.equal(parse([['O012', 'R'], ['MKM', 'EN']]).number, undefined);
  assert.equal(parse([['123AB', 'R'], ['MKM', 'EN']]).number, undefined);
  assert.equal(parse([['123456', 'R'], ['MKM', 'EN']]).number, undefined);
  assert.equal(parse([['123/0', 'U'], ['ELD', 'EN']]).number, undefined);
  assert.equal(parse([['123/000', 'U'], ['ELD', 'EN']]).number, undefined);
  assert.equal(parse([[['0012', 69.99], 'R'], ['MKM', 'EN']]).status, 'unreadable');
  assert.equal(parse([['0012', 'R'], [['MKM', 69.99], 'EN']]).status, 'unreadable');
  assert.equal(parse([[['0012', 70], 'R'], [['MKM', 70], 'EN']]).confidence, 0.7);
  assert.deepStrictEqual(parse([['0012', 'R'], ['0013', 'R'], ['MKM', 'EN']]), { status: 'unreadable' });
  assert.deepStrictEqual(parse([['0012', 'R'], ['MKM', 'EN'], ['ELD', 'EN']]), { status: 'unreadable' });
  assert.deepStrictEqual(parsePrintingTsv('not TSV'), { status: 'unreadable' });
  assert.deepStrictEqual(await readPrinting('/etc/passwd'), { status: 'error' });
  assert.deepStrictEqual(await readPrinting(Buffer.alloc(0)), { status: 'error' });

  // Opt-in real native executable smoke: node backend/test/scanocr.test.js --ocr-smoke
  // No downloaded fixtures or database/model/catalog access; sharp renders the footer.
  if (process.argv.includes('--ocr-smoke')) {
    for (const width of [448, 896]) {
      for (const [first, second, setCode, number] of [
        ['0012 R', 'MKM • EN', 'mkm', '12'],
        ['123/269 U', 'ELD • EN', 'eld', '123'],
        ['0012a R', 'MKM • EN', 'mkm', '12a'],
      ]) {
        const image = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}">
          <rect width="100%" height="100%" fill="white"/>
          <rect x="20" y="20" width="${width - 40}" height="${width * 0.76}" fill="#777"/>
          <g font-family="DejaVu Sans Mono" font-size="${width * 0.04}" fill="black">
            <text x="${width * 0.06}" y="${width * 0.88}">${first}</text>
            <text x="${width * 0.06}" y="${width * 0.94}">${second}</text>
          </g></svg>`)).png().toBuffer();
        const result = await readPrinting(image, { setCodes: ['mkm', 'eld'] });
        assert.equal(result.status, 'read', `${width}px ${first}: ${JSON.stringify(result)}`);
        assert.equal(result.setCode, setCode);
        assert.equal(result.number, number);
        console.log(`native OCR ${width}px: ${setCode} ${number} (${result.confidence})`);
      }
    }
  }
  console.log('scanocr.test.js: all assertions passed');
}

main().catch(error => { console.error(error); process.exit(1); });
