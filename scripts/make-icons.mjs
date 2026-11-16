// Генерация иконок приложения: чёрный календарь на белом фоне.
//
// Без ImageMagick/rsvg: рисуем пиксели вручную (с суперсэмплингом ×4 для
// сглаживания) и кодируем PNG через zlib. Так иконки детерминированы и
// собираются на любой машине, где есть node.
//
//   node scripts/make-icons.mjs
//
// Пишет в public/: icon-512.png, icon-192.png, icon-maskable-512.png,
// apple-touch-icon.png (180, непрозрачный — этого требует iOS), favicon.png (64).
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const BG = [255, 255, 255];
const INK = [17, 17, 17];

// ── Геометрия значка в системе координат 512×512 ──────────────────────────
const STROKE = 26;            // толщина линий
const RECT = { x0: 64, y0: 112, x1: 448, y1: 440, r: 44 };
const HEADER_Y = 196;         // линия «шапки» календаря
const RINGS = [{ x: 180, y0: 72, y1: 150 }, { x: 332, y0: 72, y1: 150 }];
const CELLS = [                 // «даты» — квадратики в теле календаря
  [128, 246], [236, 246], [344, 246],
  [128, 334], [236, 334], [344, 334],
];
const CELL = 44;

const inRoundedRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

const inRoundedRectRing = (x, y, rect, stroke) => {
  const outer = inRoundedRect(x, y, rect.x0, rect.y0, rect.x1, rect.y1, rect.r);
  if (!outer) return false;
  const inner = inRoundedRect(
    x, y,
    rect.x0 + stroke, rect.y0 + stroke, rect.x1 - stroke, rect.y1 - stroke,
    Math.max(0, rect.r - stroke),
  );
  return !inner;
};

const inStrokeSegment = (x, y, x0, y0, x1, y1, w) => {
  // расстояние от точки до отрезка
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((x - x0) * dx + (y - y0) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = x0 + t * dx;
  const py = y0 + t * dy;
  return Math.hypot(x - px, y - py) <= w / 2;
};

// ink(x, y) в координатах 512×512: true — чёрный.
function ink(x, y) {
  if (inRoundedRectRing(x, y, RECT, STROKE)) return true;
  if (inStrokeSegment(x, y, RECT.x0, HEADER_Y, RECT.x1, HEADER_Y, STROKE)) return true;
  for (const r of RINGS) {
    if (inStrokeSegment(x, y, r.x, r.y0, r.x, r.y1, STROKE + 6)) return true;
  }
  for (const [cx, cy] of CELLS) {
    if (inRoundedRect(x, y, cx, cy, cx + CELL, cy + CELL, 10)) return true;
  }
  return false;
}

// ── Растеризация ─────────────────────────────────────────────────────────
const SS = 4; // суперсэмплинг

function render(size, { scale = 1, offset = 0 } = {}) {
  const px = new Uint8Array(size * size * 4);
  const step = 512 / (size * SS);          // шаг в координатах 512
  // масштаб/смещение: maskable-вариант ужимаем в безопасную зону
  const map = (v) => (v - 256) / scale + 256 + offset;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const gx = map((x * SS + sx + 0.5) * step);
          const gy = map((y * SS + sy + 0.5) * step);
          if (ink(gx, gy)) hits++;
        }
      }
      const a = hits / (SS * SS);           // доля чёрного в пикселе
      const i = (y * size + x) * 4;
      px[i] = Math.round(BG[0] * (1 - a) + INK[0] * a);
      px[i + 1] = Math.round(BG[1] * (1 - a) + INK[1] * a);
      px[i + 2] = Math.round(BG[2] * (1 - a) + INK[2] * a);
      px[i + 3] = 255;                      // непрозрачный фон: iOS этого ждёт
    }
  }
  return px;
}

// ── PNG ──────────────────────────────────────────────────────────────────
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;                       // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const targets = [
  { file: 'icon-512.png', size: 512 },
  { file: 'icon-192.png', size: 192 },
  // maskable: Android обрезает иконку в круг — значок должен сидеть в центре,
  // занимая ~70 % кадра, иначе углы и «дужки» срезаются.
  { file: 'icon-maskable-512.png', size: 512, scale: 1.42 },
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'favicon.png', size: 64 },
];

for (const t of targets) {
  const png = encodePng(t.size, render(t.size, { scale: t.scale ?? 1 }));
  writeFileSync(join(OUT, t.file), png);
  console.log(`${t.file}  ${t.size}×${t.size}  ${png.length} bytes`);
}
