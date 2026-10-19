import { crc32, deflateSync } from "node:zlib";

// A real solid-red PNG for native image and live vision checks; no image library needed.
export function redPng() {
  const width = 256, height = 256, raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw[y * (width * 3 + 1) + x * 3 + 1] = 255;
  const chunk = (name: string, data: Buffer) => {
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4), body = Buffer.concat([Buffer.from(name), data]);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
