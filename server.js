// SABHAN AI - FREE Image Translation & Text Replacement Server
// -----------------------------------------------------------------
// Uses only free/open-source tools - no paid API required:
//   - Tesseract.js  -> OCR (detects text + its location in the image)
//   - LibreTranslate -> free machine translation API
//   - sharp         -> draws translated text back onto the image
//
// NOTE: Free tools are less accurate than paid AI models, especially
// with stylized fonts, curved text, or busy backgrounds. Expect lower
// quality than a paid solution (e.g. OpenAI vision models).
// -----------------------------------------------------------------

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');
const path = require('path');

// Optional SDK Initialization: Google Cloud Translate
let googleTranslate = null;
if (process.env.GOOGLE_TRANSLATE_API_KEY) {
  try {
    const { Translate } = require('@google-cloud/translate').v2;
    googleTranslate = new Translate({ key: process.env.GOOGLE_TRANSLATE_API_KEY });
    console.log('[Init] Official Google Cloud Translation API initialized.');
  } catch (err) {
    console.warn('[Init] @google-cloud/translate package not installed. Using MyMemory engine.');
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory cache to store translations (saves API requests & speeds up response time)
const translationCache = new Map();

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
    console.log(`[OCR] Found ${lines.length} text lines.`);
    return lines;
  } finally {
    await worker.terminate();
  }
}

// ---------- DUAL-ENGINE TRANSLATION WITH IN-MEMORY CACHING ----------
async function translateSingleLine(text, targetCode) {
  const cacheKey = `${targetCode}:${text.trim()}`;
  
  // Return cached result immediately if available
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  // Engine 1: Google Cloud Translate API (Primary if configured)
  if (googleTranslate) {
    try {
      const [translation] = await googleTranslate.translate(text, targetCode);
      translationCache.set(cacheKey, translation);
      return translation;
    } catch (err) {
      console.error('[Google API Error]:', err.message);
    }
  }

  // Engine 2: MyMemory Translate REST API (Free, no IP bans on cloud platforms)
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=autodetect|${targetCode}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data && data.responseData && data.responseData.translatedText) {
      const translated = data.responseData.translatedText;
      translationCache.set(cacheKey, translated);
      return translated;
    }
  } catch (err) {
    console.error('[MyMemory API Error]:', err.message);
  }

  // Fallback: Return original text if processing fails
  return text;
}

async function translateBatch(texts, targetCode) {
  if (!texts || texts.length === 0) return [];

  // Execute all line translations concurrently via Promise.all
  const translationPromises = texts.map((text) => translateSingleLine(text, targetCode));
  return await Promise.all(translationPromises);
}

function buildOverlaySVG(width, height, blocks, rtl) {
  const rects = [];
  const texts = [];
  for (const block of blocks) {
    const x = Math.max(0, block.x);
    const y = Math.max(0, block.y);
    const w = Math.max(2, block.w);
    const h = Math.max(2, block.h);
    const text = escapeXML(block.translated || '');
    rects.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="white" />`);
    const fsiz = Math.max(10, Math.min(Math.round(h * 0.6), Math.floor(h * 0.9), 72));
    const textY = y + h / 2 + fsiz / 3;
    const anchor = rtl ? 'end' : 'start';
    const textX = rtl ? x + w - 6 : x + 6;
    texts.push(
      `<text x="${textX}" y="${textY}" font-size="${fsiz}" fill="black" ` +
      `text-anchor="${anchor}" font-family="Noto Naskh Arabic, KacstOne, DejaVu Sans, sans-serif" ` +
      `font-weight="500">${text}</text>`
    );
  }
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" xml:space="preserve">
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

    const originalTexts = lines.map((l) => l.text);
    const translatedTexts = await translateBatch(originalTexts, targetCode);

    lines.forEach((line, i) => {
      line.translated = translatedTexts[i] || line.text;
    });

    if (lines[0]) {
      console.log('[Server] First line process:', lines[0].text, '→', lines[0].translated);
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
app.listen(PORT, () => console.log(`SABHAN AI server running locally on port ${PORT}`));
