// SABHAN AI - Image Translation & Text Replacement Server
// -----------------------------------------------------------------
// - Accepts an uploaded image + target language
// - Uses OpenAI (vision-capable model) to detect text regions and
//   translate the text found inside each region
// - Draws the translated text back onto the image at (roughly) the
//   same location, supporting RTL languages like Arabic
// - Returns the final image for download
// -----------------------------------------------------------------

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const sharp = require('sharp');
const OpenAI = require('openai');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY environment variable is missing.');
  console.error('Set it in Railway -> Variables (do NOT put it in the code).');
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// Languages that should render right-to-left
const RTL_LANGS = new Set(['ar', 'arabic', 'fa', 'farsi', 'he', 'hebrew', 'ur', 'urdu']);

function isRTL(lang) {
  return RTL_LANGS.has(String(lang).toLowerCase());
}

function escapeXML(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Ask the model to find text boxes in the image and translate them.
async function detectAndTranslate(base64Image, mimeType, targetLang) {
  const prompt = `You are an OCR + translation engine.
Look at the attached image and find every distinct block of visible text.
For each block, return its bounding box (in pixel coordinates relative to
the image's actual width/height) and its translation into "${targetLang}".

Respond ONLY with strict JSON (no markdown, no commentary) in this exact shape:
{
  "image_width": <number>,
  "image_height": <number>,
  "blocks": [
    { "x": <number>, "y": <number>, "w": <number>, "h": <number>, "translated_text": "<string>" }
  ]
}
If there is no readable text, return "blocks": [].`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 2000,
  });

  const raw = response.choices[0].message.content.trim();
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error('Failed to parse model JSON:', raw);
    throw new Error('Could not parse translation result from AI model.');
  }
  return parsed;
}

// Build an SVG overlay with white boxes + translated text at each block.
function buildOverlaySVG(width, height, blocks, targetLang) {
  const rtl = isRTL(targetLang);
  const rects = [];
  const texts = [];

  for (const block of blocks) {
    const x = Math.max(0, block.x || 0);
    const y = Math.max(0, block.y || 0);
    const w = Math.max(1, block.w || 10);
    const h = Math.max(1, block.h || 10);
    const text = escapeXML(block.translated_text || '');

    // Cover the original text with a white rectangle
    rects.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="white" />`);

    // Font size: fit within the box height, clamped between 10 and 72px
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
    const targetLang = req.body.targetLang || 'English';

    const meta = await sharp(req.file.buffer).metadata();
    const width = meta.width;
    const height = meta.height;
    const mimeType = req.file.mimetype || 'image/png';
    const base64Image = req.file.buffer.toString('base64');

    const result = await detectAndTranslate(base64Image, mimeType, targetLang);
    const blocks = Array.isArray(result.blocks) ? result.blocks : [];

    // Scale boxes if the model used a different reference size than the real image
    const refW = result.image_width || width;
    const refH = result.image_height || height;
    const scaleX = width / refW;
    const scaleY = height / refH;

    const scaledBlocks = blocks.map((b) => ({
      x: (b.x || 0) * scaleX,
      y: (b.y || 0) * scaleY,
      w: (b.w || 0) * scaleX,
      h: (b.h || 0) * scaleY,
      translated_text: b.translated_text,
    }));

    const overlaySVG = buildOverlaySVG(width, height, scaledBlocks, targetLang);

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
  console.log(`SABHAN AI server running on port ${PORT}`);
});
