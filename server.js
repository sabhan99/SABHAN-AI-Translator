const express = require('express');
const multer = require('multer');
const cors = require('cors');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
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
    .replace/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function runOCR(buffer) {
  // استخدام محرك الانكليزية + العربية لقراءة الصور بدقة
  const worker = await createWorker('eng');
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
  } catch (e) {
    console.error('OCR Error:', e);
    return [];
  } finally {
    await worker.terminate();
  }
}

async function translateText(text, targetCode) {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetCode}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    
    if (json && json[0]) {
      return json[0].map(item => item[0]).join('');
    }
    return text;
  } catch (err) {
    console.error('Translation failed:', err.message);
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

    // رسم مربع أبيض لإخفاء النص الأصلي بالكامل
    rects.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="white" stroke="#ccc" stroke-width="1" />`);

    const fsiz = Math.max(14, Math.min(Math.round(h * 0.55), 40));
    const textX = rtl ? x + w - 5 : x + 5;
    const anchor = rtl ? 'end' : 'start';
    const textY = y + h / 2 + fsiz / 3;

    texts.push(
      `<text x="${textX}" y="${textY}" font-size="${fsiz}" fill="black" ` +
      `text-anchor="${anchor}" font-family="Arial, Cairo, sans-serif" ` +
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
    
    // استقبال اللغة مع القيمة الافتراضية للغة العربية
    const targetLangName = req.body.targetLang || req.body.lang || 'Arabic';
    const targetCode = LANG_CODES[targetLangName] || 'ar';
    const rtl = RTL_CODES.has(targetCode);

    console.log(`Processing image. Target Lang: ${targetLangName} (${targetCode})`);

    const meta = await sharp(req.file.buffer).metadata();
    const width = meta.width;
    const height = meta.height;

    // 1. التعرف على النص
    const lines = await runOCR(req.file.buffer);
    console.log(`Detected lines count: ${lines.length}`);

    if (lines.length === 0) {
      const outputBuffer = await sharp(req.file.buffer).png().toBuffer();
      res.set('Content-Type', 'image/png');
      return res.send(outputBuffer);
    }

    // 2. ترجمة النصوص المستخرجة
    for (const line of lines) {
      line.translated = await translateText(line.text, targetCode);
      console.log(`Original: "${line.text}" -> Translated: "${line.translated}"`);
    }

    // 3. طباعة النص المترجم فوق الصورة
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
  console.log(`Server running on port ${PORT}`);
});
