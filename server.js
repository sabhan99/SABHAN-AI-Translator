const express = require('express');
const multer = require('multer');
const cors = require('cors');
const sharp = require('sharp');
const fetch = require('node-fetch');
const { createWorker } = require('tesseract.js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const LIBRETRANSLATE_URL = process.env.LIBRETRANSLATE_URL || 'https://libretranslate.de';

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const LANG_CODES = {
  Arabic: 'ar',
  English: 'en',
  French: 'fr',
  Spanish: 'es',
  Turkish: 'tr',
};

const RTL_CODES = new Set(['ar', 'fa', 'he', 'ur']);

function escapeXML(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function runOCR(buffer) {
  const worker = await createWorker('eng+ara+spa+tur+fra');
  try {
    const { data } = await worker.recognize(buffer);
    const lines = (data.lines || [])
      .filter((l) => l.text && l.text.trim().length > 0)
      .map((l) => ({
        text: l.text.trim(),
        x: l.bbox.x0,
        y: l.bbox.y0,
        w: l.bbox.x1 - l.bbox.x0,
        h: l.bbox.y1 - l.bbox.y0,
      }));
    return lines;
  } finally {
    await worker.terminate();
  }
}

async function translateText(text, targetCode) {
  try {
    const res = await fetch(`${LIBRETRANSLATE_URL}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: text,
        source: 'auto',
        target: targetCode,
        format: 'text',
      }),
    });
    if (!res.ok) throw new Error(`LibreTranslate HTTP ${res.status}`);
    const json = await res.json();
    return json.translatedText || text;
  } catch (err) {
    console.error('Translation failed for line, using original text:', err.message);
    return text;
  }
}

function buildOverlaySVG(width, height, blocks, rtl) {
  const rects = [];
  const texts = [];

  for (const block of blocks) {
    const x = Math.max(0, block.x);
    const y = Math.max(0, block.y);
    const w = Math.max(1, block.w);
    const h = Math.max(1, block.h);
    const text = escapeXML(block.translated || '');

    rects.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="white" />`);

    const fsiz = Math.max(10, Math.min(Math.round(h * 0.6), Math.floor(h * 0.9), 72));
    const textX = rtl ? x + w - 4 : x + 4;
    const anchor = rtl ? 'end' : 'start';
    const textY = y + h / 2 + fsiz / 3;

    texts.push(
      `<text x="${textX}" y="${textY}" font-size="${fsiz}" fill="black" ` +
      `text-anchor="${anchor}" font-family="Arial, sans-serif" ` +
      `direction="${rtl ? 'rtl' : 'ltr'}">${text}</text>`
    );
  }

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    ${rects.join('\n')}
    ${texts.join('\n')}
  </svg>`;
}

app.post('/api/translate', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded.' });
    }
    const targetLangName = req.body.targetLang || 'Arabic';
    const targetCode = LANG_CODES[targetLangName] || 'ar';
    const rtl = RTL_CODES.has(targetCode);

    const meta = await sharp(req.file.buffer).metadata();
    const width = meta.width;
    const height = meta.height;

    const lines = await runOCR(req.file.buffer);

    if (lines.length === 0) {
      const outputBuffer = await sharp(req.file.buffer).png().toBuffer();
      res.set('Content-Type', 'image/png');
      return res.send(outputBuffer);
    }

    for (const line of lines) {
      line.translated = await translateText(line.text, targetCode);
    }

    const overlaySVG = buildOverlaySVG(width, height, lines, rtl);
    const outputBuffer = await sharp(req.file.buffer)
      .composite([{ input: Buffer.from(overlaySVG), top: 0, left: 0 }])
      .png()
      .toBuffer();

    res.set('Content-Type', 'image/png');
    res.send(outputBuffer);
  } catch (err) {
    console.error('Translation error:', err);
    res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`SABHAN AI (FREE version) server running on port ${PORT}`);
});
