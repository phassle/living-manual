// A minimal PNG reader (for lm-compare and the kit's tests): 8-bit RGB or RGBA, not interlaced (what Playwright's
// screenshots are). Returns { width, height, rgb (Buffer, 3 bytes a pixel), pixel(x, y) -> [r, g, b] }.
import { deflateSync, inflateSync } from 'node:zlib';

export function readPng(buf) {
	let pos = 8, width, height, depth, type, idat = [];
	while (pos < buf.length) {
		const len = buf.readUInt32BE(pos), kind = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
		if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; if (data[12]) throw new Error('interlaced PNG'); }
		if (kind === 'IDAT') idat.push(data);
		pos += 12 + len;
	}
	if (depth !== 8 || (type !== 2 && type !== 6)) throw new Error(`unsupported PNG: depth ${depth}, colour type ${type}`);
	const bpp = type === 6 ? 4 : 3, stride = width * bpp, raw = inflateSync(Buffer.concat(idat)), out = Buffer.alloc(height * stride);
	for (let y = 0; y < height; y++) {
		const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		for (let x = 0; x < stride; x++) {
			const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
			const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
			const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
			out[y * stride + x] = (line[x] + pred) & 255;
		}
	}
	const rgb = Buffer.alloc(width * height * 3);
	for (let i = 0; i < width * height; i++) out.copy(rgb, i * 3, i * bpp, i * bpp + 3);
	return { width, height, rgb, pixel: (x, y) => [...out.subarray(y * stride + x * bpp, y * stride + x * bpp + 3)] };
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(kind, data) {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(kind, 4, 'ascii');
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

/** Encodes { width, height, rgb } as an 8-bit RGB PNG (no filtering): the same pixels give the same bytes. */
export function writePng({ width, height, rgb }) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
	const raw = Buffer.alloc(height * (width * 3 + 1));
	for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Draws a rounded frame (`thickness` px, corner `radius`, colour '#rrggbb') round box { x, y, width, height }
 * straight into the PNG's pixels, `pad` px outside the box, and returns the new PNG. Pixels are set or
 * left, never blended, so the result depends only on the inputs.
 */
export function drawFrame(png, box, colour, { pad = 6, thickness = 4, radius = 8 } = {}) {
	const img = readPng(png);
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16));
	const x0 = Math.round(box.x - pad), y0 = Math.round(box.y - pad);
	const x1 = Math.round(box.x + box.width + pad), y1 = Math.round(box.y + box.height + pad); // exclusive
	// Inside a rounded rectangle [ax, bx) × [ay, by) with corner radius rad, measured at the pixel's centre.
	const inside = (x, y, ax, ay, bx, by, rad) => {
		if (x < ax || x >= bx || y < ay || y >= by) return false;
		const px = x + 0.5, py = y + 0.5;
		const cx = px < ax + rad ? ax + rad : px > bx - rad ? bx - rad : px;
		const cy = py < ay + rad ? ay + rad : py > by - rad ? by - rad : py;
		return (px - cx) ** 2 + (py - cy) ** 2 <= rad * rad;
	};
	const t = thickness, inner = Math.max(0, radius - t);
	for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
		for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) {
			if (!inside(x, y, x0, y0, x1, y1, radius) || inside(x, y, x0 + t, y0 + t, x1 - t, y1 - t, inner)) continue;
			const i = (y * img.width + x) * 3;
			img.rgb[i] = r; img.rgb[i + 1] = g; img.rgb[i + 2] = b;
		}
	}
	return writePng(img);
}
