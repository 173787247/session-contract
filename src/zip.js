import { deflateRawSync, inflateRawSync } from "node:zlib";

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;
const DESCRIPTOR = 0x08074b50;

/**
 * Read ZIP via the central directory (EOCD → central entries → local payload).
 * Streaming producers (fflate) leave local csize/usize at 0 and set bit 3;
 * sizes live in the central directory. Data descriptors are ignored.
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>}
 */
export function unzip(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOff = buf.readUInt32LE(eocd + 16);
  if (centralOff + centralSize > buf.length) throw new Error("zip central directory truncated");
  if (count === 0xffff || centralOff === 0xffffffff) {
    throw new Error("zip64 is not supported");
  }

  /** @type {Map<string, Buffer>} */
  const files = new Map();
  let i = centralOff;
  for (let n = 0; n < count; n++) {
    if (i + 46 > buf.length || buf.readUInt32LE(i) !== CENTRAL) {
      throw new Error(`zip central entry ${n} is corrupt`);
    }
    const method = buf.readUInt16LE(i + 10);
    const compSize = buf.readUInt32LE(i + 20);
    const nameLen = buf.readUInt16LE(i + 28);
    const extraLen = buf.readUInt16LE(i + 30);
    const commentLen = buf.readUInt16LE(i + 32);
    const localOff = buf.readUInt32LE(i + 42);
    const name = buf.toString("utf8", i + 46, i + 46 + nameLen);
    i += 46 + nameLen + extraLen + commentLen;
    files.set(name.replace(/\\/g, "/"), readLocalPayload(buf, localOff, method, compSize, name));
  }
  return files;
}

/**
 * @param {Buffer} buf
 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) !== EOCD) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLen === buf.length) return i;
  }
  throw new Error("zip EOCD not found");
}

/**
 * @param {Buffer} buf
 * @param {number} localOff
 * @param {number} method
 * @param {number} compSize
 * @param {string} name
 */
function readLocalPayload(buf, localOff, method, compSize, name) {
  if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOCAL) {
    throw new Error(`zip local header missing for ${name}`);
  }
  const nameLen = buf.readUInt16LE(localOff + 26);
  const extraLen = buf.readUInt16LE(localOff + 28);
  const dataStart = localOff + 30 + nameLen + extraLen;
  if (dataStart + compSize > buf.length) throw new Error(`zip payload truncated for ${name}`);
  const comp = buf.subarray(dataStart, dataStart + compSize);
  if (method === 0) return Buffer.from(comp);
  if (method === 8) return inflateRawSync(comp);
  throw new Error(`unsupported zip method ${method} for ${name}`);
}

/**
 * STORE zip (tests). Local headers carry real sizes; no bit 3.
 * @param {Record<string, Buffer | string>} files
 */
export function zipStore(files) {
  return buildZip(files, { method: 0, bit3: false });
}

/**
 * DEFLATE + bit 3 (data descriptor). Matches dsh `/export` (fflate streaming).
 * Local csize/usize are 0; real sizes are in the central directory.
 * @param {Record<string, Buffer | string>} files
 */
export function zipDeflateBit3(files) {
  return buildZip(files, { method: 8, bit3: true });
}

/**
 * @param {Record<string, Buffer | string>} files
 * @param {{ method: 0 | 8, bit3: boolean }} opts
 */
function buildZip(files, opts) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    const payload = opts.method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, "utf8");
    const flags = opts.bit3 ? 0x0008 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(opts.method, 8);
    if (opts.bit3) {
      local.writeUInt32LE(0, 14);
      local.writeUInt32LE(0, 18);
      local.writeUInt32LE(0, 22);
    } else {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(payload.length, 18);
      local.writeUInt32LE(data.length, 22);
    }
    local.writeUInt16LE(nameBuf.length, 26);
    const pieces = [local, nameBuf, payload];
    let desc = Buffer.alloc(0);
    if (opts.bit3) {
      desc = Buffer.alloc(16);
      desc.writeUInt32LE(DESCRIPTOR, 0);
      desc.writeUInt32LE(crc, 4);
      desc.writeUInt32LE(payload.length, 8);
      desc.writeUInt32LE(data.length, 12);
      pieces.push(desc);
    }
    chunks.push(...pieces);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CENTRAL, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(opts.method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + payload.length + desc.length;
  }
  const centralStart = offset;
  const centralBufs = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  const n = Object.keys(files).length;
  eocd.writeUInt16LE(n, 8);
  eocd.writeUInt16LE(n, 10);
  eocd.writeUInt32LE(centralBufs.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...chunks, centralBufs, eocd]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** @param {Buffer} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
