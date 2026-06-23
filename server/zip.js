// Minimal, dependency-free streaming ZIP writer.
//
// Why hand-rolled: this app deliberately ships with only pure-JS deps and must
// run on Node 16 / CentOS 7, fully offline. We stream a folder to the client as
// a .zip without buffering whole files, using Node's built-in zlib for deflate.
//
// Format notes:
//  - Each file uses a data descriptor (general-purpose flag bit 3) so we can
//    write the local header before knowing the CRC / compressed size, then
//    stream the deflated bytes, then emit the descriptor. Bit 11 marks UTF-8
//    file names.
//  - ZIP64 is emitted per-entry when a file's size or its local-header offset
//    could exceed the 32-bit limit, and at the archive level when the entry
//    count or central-directory size/offset overflow — so folders over 4GB or
//    65535 files still produce a valid archive.
//  - Symlinks are skipped (avoids loops and prevents escaping the share).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { PassThrough } from 'node:stream';

// Decide ZIP64 with a margin below 4GB so deflate overhead on a nearly-4GB
// incompressible file can't push the compressed size past the 32-bit limit
// after we've already committed to a non-ZIP64 local header.
// (ZIP64_TEST_THRESHOLD is a test-only hook to force the ZIP64 path with small
// files; unset in production it stays at the real ~4GB-64MB limit.)
const ZIP64_THRESHOLD = (() => {
  const t = Number(process.env.ZIP64_TEST_THRESHOLD);
  return Number.isFinite(t) && t > 0 ? t : 0xffffffff - 0x4000000;
})();

// ---- CRC-32 (IEEE) ----
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32Update(crc, buf) {
  let c = crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

function writeUInt64LE(buf, value, offset) {
  buf.writeBigUInt64LE(BigInt(value), offset);
}

// Convert an mtime (ms) to DOS date/time. Clamp anything before 1980-01-01.
function dosDateTime(ms) {
  const d = new Date(ms);
  const year = d.getFullYear();
  if (!Number.isFinite(year) || year < 1980) return { time: 0, date: 0x21 };
  const date = (((year - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { time: time & 0xffff, date: date & 0xffff };
}

class ZipAborted extends Error {}

class ZipBuilder {
  constructor(out) {
    this.out = out;
    this.offset = 0; // total bytes written so far (== next local header offset)
    this.entries = []; // central-directory records
  }

  async _write(buf) {
    if (this.out.destroyed) throw new ZipAborted();
    this.offset += buf.length;
    if (!this.out.write(buf)) {
      // Wait for drain, but also wake on close (client abort). Attach both
      // listeners to one promise and remove both on settle — racing two
      // separate once() promises would leak the losing listener on every
      // backpressured write (thousands over a large download).
      const out = this.out;
      await new Promise((resolve) => {
        const cleanup = () => {
          out.removeListener('drain', onDrain);
          out.removeListener('close', onClose);
        };
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onClose = () => {
          cleanup();
          resolve();
        };
        out.once('drain', onDrain);
        out.once('close', onClose);
      });
      if (this.out.destroyed) throw new ZipAborted();
    }
  }

  async addFile(name, absPath) {
    let st;
    try {
      st = await fsp.stat(absPath);
    } catch {
      return; // file vanished between walk and read — skip it
    }
    if (!st.isFile()) return;
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosDateTime(st.mtimeMs);
    const offset = this.offset;
    const zip64 = st.size >= ZIP64_THRESHOLD || offset >= ZIP64_THRESHOLD;

    await this._write(localHeader(nameBuf, time, date, zip64));

    // Stream the file through raw deflate. CRC + uncompressed size come from the
    // source bytes; compressed size from the deflate output.
    let crc = 0xffffffff;
    let comp = 0;
    let uncomp = 0;
    const source = fs.createReadStream(absPath);
    const deflate = zlib.createDeflateRaw();
    source.on('data', (c) => {
      crc = crc32Update(crc, c);
      uncomp += c.length;
    });

    await new Promise((resolve, reject) => {
      const onAbort = () => {
        source.destroy();
        deflate.destroy();
        reject(new ZipAborted());
      };
      if (this.out.destroyed) return onAbort();
      this.out.once('close', onAbort);
      const done = (err) => {
        this.out.removeListener('close', onAbort);
        if (err) reject(err);
        else resolve();
      };
      deflate.on('data', (c) => {
        comp += c.length;
      });
      deflate.on('end', () => done());
      deflate.on('error', done);
      source.on('error', done);
      source.pipe(deflate);
      deflate.pipe(this.out, { end: false }); // pipe handles backpressure
    });

    this.offset += comp; // file body bytes went straight to out via pipe
    crc = (crc ^ 0xffffffff) >>> 0;
    await this._write(dataDescriptor(crc, comp, uncomp, zip64));
    this.entries.push({ nameBuf, crc, comp, uncomp, offset, time, date, zip64, isDir: false });
  }

  // An empty directory needs its own stored, zero-length entry (name ends "/")
  // so the folder structure survives even when a sub-folder has no files.
  async addEmptyDir(name) {
    const nameBuf = Buffer.from(name, 'utf8');
    const offset = this.offset;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6); // UTF-8, no data descriptor
    h.writeUInt16LE(0, 8); // stored
    h.writeUInt16LE(0, 10); // time
    h.writeUInt16LE(0x21, 12); // date (1980-01-01)
    h.writeUInt32LE(0, 14); // crc
    h.writeUInt32LE(0, 18); // comp size
    h.writeUInt32LE(0, 22); // uncomp size
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28);
    await this._write(Buffer.concat([h, nameBuf]));
    this.entries.push({ nameBuf, crc: 0, comp: 0, uncomp: 0, offset, time: 0, date: 0x21, zip64: false, isDir: true });
  }

  async finish() {
    const cdStart = this.offset;
    for (const e of this.entries) await this._write(centralHeader(e));
    const cdSize = this.offset - cdStart;
    const total = this.entries.length;

    const need64 = total > 0xffff || cdSize > 0xffffffff || cdStart > 0xffffffff;
    if (need64) {
      const z = Buffer.alloc(56);
      z.writeUInt32LE(0x06064b50, 0);
      writeUInt64LE(z, 44, 4); // size of remainder of this record
      z.writeUInt16LE(45, 12); // version made by
      z.writeUInt16LE(45, 14); // version needed
      z.writeUInt32LE(0, 16); // this disk
      z.writeUInt32LE(0, 20); // disk with cd start
      writeUInt64LE(z, total, 24);
      writeUInt64LE(z, total, 32);
      writeUInt64LE(z, cdSize, 40);
      writeUInt64LE(z, cdStart, 48);
      const eocd64Offset = this.offset;
      await this._write(z);

      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeUInt32LE(0, 4); // disk with zip64 EOCD
      writeUInt64LE(loc, eocd64Offset, 8);
      loc.writeUInt32LE(1, 16); // total disks
      await this._write(loc);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(total > 0xffff ? 0xffff : total, 8);
    eocd.writeUInt16LE(total > 0xffff ? 0xffff : total, 10);
    eocd.writeUInt32LE(cdSize > 0xffffffff ? 0xffffffff : cdSize, 12);
    eocd.writeUInt32LE(cdStart > 0xffffffff ? 0xffffffff : cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    await this._write(eocd);
  }
}

function localHeader(nameBuf, time, date, zip64) {
  const extra = zip64 ? zip64LocalExtra() : Buffer.alloc(0);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(zip64 ? 45 : 20, 4); // version needed
  h.writeUInt16LE(0x0808, 6); // flags: bit3 data descriptor + bit11 UTF-8
  h.writeUInt16LE(8, 8); // deflate
  h.writeUInt16LE(time, 10);
  h.writeUInt16LE(date, 12);
  h.writeUInt32LE(0, 14); // crc -> data descriptor
  h.writeUInt32LE(zip64 ? 0xffffffff : 0, 18); // comp size -> data descriptor
  h.writeUInt32LE(zip64 ? 0xffffffff : 0, 22); // uncomp size -> data descriptor
  h.writeUInt16LE(nameBuf.length, 26);
  h.writeUInt16LE(extra.length, 28);
  return Buffer.concat([h, nameBuf, extra]);
}

function zip64LocalExtra() {
  // Sizes are carried by the data descriptor, so the placeholders here are 0.
  const e = Buffer.alloc(20);
  e.writeUInt16LE(0x0001, 0);
  e.writeUInt16LE(16, 2);
  return e; // 8-byte uncomp = 0, 8-byte comp = 0
}

function dataDescriptor(crc, comp, uncomp, zip64) {
  if (zip64) {
    const d = Buffer.alloc(24);
    d.writeUInt32LE(0x08074b50, 0);
    d.writeUInt32LE(crc >>> 0, 4);
    writeUInt64LE(d, comp, 8);
    writeUInt64LE(d, uncomp, 16);
    return d;
  }
  const d = Buffer.alloc(16);
  d.writeUInt32LE(0x08074b50, 0);
  d.writeUInt32LE(crc >>> 0, 4);
  d.writeUInt32LE(comp >>> 0, 8);
  d.writeUInt32LE(uncomp >>> 0, 12);
  return d;
}

function centralHeader(e) {
  const zip64 = e.zip64;
  const extra = zip64 ? zip64CentralExtra(e) : Buffer.alloc(0);
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(45, 4); // version made by
  h.writeUInt16LE(zip64 ? 45 : 20, 6); // version needed
  h.writeUInt16LE(e.isDir ? 0x0800 : 0x0808, 8); // dir entries carry no descriptor
  h.writeUInt16LE(e.isDir ? 0 : 8, 10); // method
  h.writeUInt16LE(e.time, 12);
  h.writeUInt16LE(e.date, 14);
  h.writeUInt32LE(e.crc >>> 0, 16);
  h.writeUInt32LE(zip64 ? 0xffffffff : e.comp >>> 0, 20);
  h.writeUInt32LE(zip64 ? 0xffffffff : e.uncomp >>> 0, 24);
  h.writeUInt16LE(e.nameBuf.length, 28);
  h.writeUInt16LE(extra.length, 30);
  h.writeUInt16LE(0, 32); // comment length
  h.writeUInt16LE(0, 34); // disk start
  h.writeUInt16LE(0, 36); // internal attrs
  h.writeUInt32LE(e.isDir ? 0x10 : 0, 38); // external attrs (DOS directory bit)
  h.writeUInt32LE(zip64 ? 0xffffffff : e.offset >>> 0, 42);
  return Buffer.concat([h, e.nameBuf, extra]);
}

function zip64CentralExtra(e) {
  // Fixed fields are all 0xFFFFFFFF for a zip64 entry, so carry uncomp, comp and
  // the local-header offset (8 bytes each) here, in that order.
  const e2 = Buffer.alloc(28);
  e2.writeUInt16LE(0x0001, 0);
  e2.writeUInt16LE(24, 2);
  writeUInt64LE(e2, e.uncomp, 4);
  writeUInt64LE(e2, e.comp, 12);
  writeUInt64LE(e2, e.offset, 20);
  return e2;
}

// Stream a folder (recursively) as a ZIP. Returns a Readable (PassThrough).
// Entry names are rooted at `rootName` (typically the folder's own name), e.g.
// "Sales/report.xlsx". Skips symlinks. Destroy the returned stream to abort.
export function zipFolder(dirAbs, rootName) {
  const out = new PassThrough();
  const zip = new ZipBuilder(out);

  (async () => {
    await walk(dirAbs, rootName);
    await zip.finish();
    out.end();
  })().catch((err) => {
    if (err instanceof ZipAborted || out.destroyed) return; // client went away
    out.destroy(err);
  });

  return out;

  async function walk(absDir, relDir) {
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    let hadChild = false;
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const childAbs = path.join(absDir, ent.name);
      const childRel = relDir + '/' + ent.name;
      if (ent.isDirectory()) {
        hadChild = true;
        await walk(childAbs, childRel);
      } else if (ent.isFile()) {
        hadChild = true;
        await zip.addFile(childRel, childAbs);
      }
    }
    if (!hadChild) await zip.addEmptyDir(relDir + '/');
  }
}
