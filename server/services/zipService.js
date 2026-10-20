// 零依赖 zip 编解码（只用 node:zlib）——服务端解升级包 + 打包脚本 + 自检里做纯函数断言，三处共用一套。
// ⚠️ 本文件绝不引入任何会打开数据库的模块（例如同目录的 db 模块）：check（mask 自检）要直接
//    require 本文件跑断言，而这个项目的规矩是自检绝不许碰到真实 data/ 库。
const zlib = require('zlib');

// ---------- CRC32（zip 用的 IEEE 802.3 反射多项式 0xEDB88320） ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0; // 已知向量：crc32(Buffer.from('123456789')) === 0xCBF43926
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

// 名字解码：bit 11 置位 = UTF-8；否则按历史 zip 规范是 CP437。
// 这里**故意不做完整的 CP437 码表**（128 项对照表是纯噪声，且本项目产出的包内路径全 ASCII）：
// 没打标志位时用 latin1 逐字节映射——名字不够准确但一定可读，
// 而它的唯一用途就是让「包内有非法条目」的 400 报错能说清是哪个条目。
function decodeName(bytes, flags) {
  return (flags & 0x0800) ? bytes.toString('utf8') : bytes.toString('latin1');
}

// ---------- 从尾部倒着找 EOCD（末尾可能有最长 65535 字节的注释，不能只看最后 22 字节） ----------
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

const MAX_ENTRIES = 2000;                  // 条目数上限（本项目的包只有几十条）
const MAX_TOTAL_UNCOMP = 200 * 1024 * 1024; // 解开后的总量上限（防 zip 炸弹）

// 解包：只信中央目录（local header 在有 data descriptor 时字段是 0，不可信），
// 但数据起始位置必须从 local header 现读——它的 extra 长度经常与中央目录不一致。
function extractZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 zip 文件（长度不足 22 字节）');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('找不到 zip 结尾记录（EOCD）——文件被截断，或根本不是 zip');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error('不支持 zip64 格式：请用普通 zip 打包（条目 < 65535 且单文件 < 4GB）');
  }
  if (total > MAX_ENTRIES) throw new Error(`包内条目数 ${total} 超过上限 ${MAX_ENTRIES}`);
  if (cdOff + cdSize > buf.length) throw new Error('中央目录越界（zip 损坏或被截断）');

  const out = [];
  const seen = new Set();
  let totalUncomp = 0;
  let p = cdOff;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error(`中央目录第 ${i + 1} 条记录签名不对（zip 损坏）`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const locOff = buf.readUInt32LE(p + 42);
    const name = decodeName(buf.subarray(p + 46, p + 46 + nameLen), flags);
    p += 46 + nameLen + extraLen + cmtLen;

    if (name.endsWith('/')) continue;                       // 目录条目：目录由落盘时的前缀隐式创建
    if (flags & 0x0001) throw new Error(`包内 ${name} 是加密条目，不支持`);
    if (method !== 0 && method !== 8) throw new Error(`包内 ${name} 的压缩方式 ${method} 不支持（只认 store/deflate）`);
    if (seen.has(name)) throw new Error(`包内有重复条目 ${name}`);
    seen.add(name);

    if (locOff + 30 > buf.length || buf.readUInt32LE(locOff) !== SIG_LOCAL) {
      throw new Error(`包内 ${name} 的 local header 签名不对（zip 损坏）`);
    }
    const dataOff = locOff + 30 + buf.readUInt16LE(locOff + 26) + buf.readUInt16LE(locOff + 28);
    if (dataOff + compSize > buf.length) throw new Error(`包内 ${name} 的数据越界（包被截断）`);
    const raw = buf.subarray(dataOff, dataOff + compSize);

    let data;
    if (method === 0) {
      data = Buffer.from(raw);
    } else {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(uncompSize, 1) });
      } catch (e) {
        throw new Error(`包内 ${name} 解压失败：${e.message}`);
      }
    }
    if (data.length !== uncompSize) throw new Error(`包内 ${name} 解压后大小不符（${data.length} ≠ 声明 ${uncompSize}）`);
    if (crc32(data) !== crc) throw new Error(`包内 ${name} CRC32 校验失败（内容损坏）`);
    totalUncomp += data.length;
    if (totalUncomp > MAX_TOTAL_UNCOMP) throw new Error('解压总量超过 200MB 上限（疑似 zip 炸弹）');
    out.push({ name, data });
  }
  return out;
}

// ---------- 打包 ----------
function dosDateTime(d) {
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | (Math.floor(d.getSeconds() / 2) & 31),
    date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

// entries: [{name, data:Buffer}]；name 用 '/' 分隔、不接受目录条目。
// 固定 mtime，让「同样的内容打两次包 → 字节完全一样」（自检与复现都靠它）。
function buildZip(entries, { mtime = new Date('2026-01-01T00:00:00Z') } = {}) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('buildZip：没有任何条目');
  const { time, date } = dosDateTime(mtime);
  const chunks = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    if (!name || /\/$/.test(name)) throw new Error('buildZip 不接受空名或目录条目：' + name);
    if (!Buffer.isBuffer(data)) throw new Error('buildZip 的 data 必须是 Buffer：' + name);
    const nameBuf = Buffer.from(name, 'utf8');
    const utf8Flag = /[^\x00-\x7F]/.test(name) ? 0x0800 : 0; // 含中文名时自动打 UTF-8 标志位
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const store = deflated.length >= data.length;           // 压不小就直接存原文
    const method = store ? 0 : 8;
    const body = store ? data : deflated;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOCAL, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(utf8Flag, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(SIG_CENTRAL, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(utf8Flag, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); // 普通文件 0644（与 zip-utf8.py 同口径）；>>>0 必需：1<<16 之后是负数
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += 30 + nameBuf.length + body.length; // 下一个条目的 local header 偏移
  }
  const cd = Buffer.concat(centrals);
  const eo = Buffer.alloc(22);
  eo.writeUInt32LE(SIG_EOCD, 0);
  eo.writeUInt16LE(entries.length, 8);
  eo.writeUInt16LE(entries.length, 10);
  eo.writeUInt32LE(cd.length, 12);
  eo.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eo]);
}

module.exports = { extractZip, buildZip, crc32, decodeName };
