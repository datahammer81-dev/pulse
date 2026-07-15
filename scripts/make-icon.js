// Generates dist/pulse.ico — a red heart with an EKG line, sizes 16/32/48.
// Pure Node, no dependencies: hand-built ICO (PNG-free, 32bpp BMP entries).
const fs = require('fs');
const path = require('path');

const RED = [0x3b, 0x3b, 0xd0, 0xff];   // BGRA of #d03b3b
const DARK = [0x30, 0x30, 0xa8, 0xff];  // shaded bottom
const WHITE = [0xff, 0xff, 0xff, 0xff];

// Inside test for the classic heart curve (u²+v²-1)³ − u²v³ ≤ 0
function insideHeart(u, v) {
  const a = u * u + v * v - 1;
  return a * a * a - u * u * v * v * v <= 0;
}

function renderPixels(size) {
  const px = Array.from({ length: size }, () => Array(size).fill(null));
  const cx = (size - 1) / 2;
  const cy = size * 0.44;
  const s = size / 2.75;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x - cx) / s;
      const v = (cy - y) / s + 0.1;
      if (insideHeart(u, v)) px[y][x] = y > size * 0.62 ? DARK : RED;
    }
  }
  // EKG trace across the middle: continuous flat – spike – dip – flat polyline
  const mid = size * 0.52;
  const pts = [[0, 0], [0.38, 0], [0.48, -0.22], [0.58, 0.14], [0.66, 0], [1, 0]];
  const yAt = t => {
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i][0]) {
        const [t0, o0] = pts[i - 1], [t1, o1] = pts[i];
        return mid + (o0 + (o1 - o0) * ((t - t0) / (t1 - t0))) * size;
      }
    }
    return mid;
  };
  const put = (x, y) => {
    y = Math.round(y);
    if (y >= 0 && y < size && px[y][x]) px[y][x] = WHITE;
  };
  let prevY = yAt(0);
  const thick = size >= 32 ? 2 : 1;
  for (let x = 0; x < size; x++) {
    const y = yAt(x / (size - 1));
    const [lo, hi] = [Math.min(prevY, y), Math.max(prevY, y)];
    for (let yy = lo; yy <= hi + 0.01; yy++) for (let t = 0; t < thick; t++) put(x, yy + t);
    prevY = y;
  }
  return px;
}

function icoImage(size) {
  const px = renderPixels(size);
  const maskRow = Math.ceil(size / 8 / 4) * 4;
  const data = Buffer.alloc(40 + size * size * 4 + maskRow * size);
  data.writeUInt32LE(40, 0);            // BITMAPINFOHEADER size
  data.writeInt32LE(size, 4);           // width
  data.writeInt32LE(size * 2, 8);       // height ×2 (XOR + AND masks)
  data.writeUInt16LE(1, 12);            // planes
  data.writeUInt16LE(32, 14);           // bpp
  let o = 40;
  for (let y = size - 1; y >= 0; y--) { // bottom-up
    for (let x = 0; x < size; x++) {
      const p = px[y][x] || [0, 0, 0, 0];
      data[o++] = p[0]; data[o++] = p[1]; data[o++] = p[2]; data[o++] = p[3];
    }
  }
  return data;                          // AND mask stays all-zero (alpha rules)
}

const sizes = [16, 32, 48, 256];
const images = sizes.map(icoImage);
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);             // type: icon
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => {
  const e = 6 + i * 16;
  header[e] = size === 256 ? 0 : size;
  header[e + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(images[i].length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});

const out = path.join(__dirname, '..', 'dist', 'pulse.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([header, ...images]));
console.log('wrote', out);

// ASCII preview of the 32px frame so a human can sanity-check the shape
const p = renderPixels(32);
console.log(p.map(row => row.map(c => (c === WHITE ? '=' : c ? '#' : '.')).join('')).join('\n'));
