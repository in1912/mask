'use strict';
// 面具 mask — 附件文本提取（零依赖；承工作台 fileTextService 思路，天然剥离文档元数据）
// P0 支持：文本类 + docx（只取正文 w:t，作者/修订/批注一概不进入文本）
// P1 计划：pdf（ToUnicode CMap）/ xlsx；图片无法脱敏，明确拒收
const fs = require('fs');
const zlib = require('zlib');

const TEXT_EXT = new Set(['txt', 'md', 'csv', 'log', 'json', 'xml', 'html', 'htm', 'js', 'css', 'ini', 'yml', 'yaml', 'py', 'java', 'sql', 'sh', 'bat', 'ts', 'go', 'conf']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'avif']);
const MAX_CHARS = 50000;

// ---- 最小 zip 读取（Central Directory 定位 + inflateRaw）----
function zipReadEntries(buf) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 结构损坏');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    out.push({ name, method, compSize, lho });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}
function zipReadFile(buf, entry) {
  const lh = entry.lho;
  if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('zip 本地头损坏');
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const start = lh + 30 + nameLen + extraLen;
  const data = buf.slice(start, start + entry.compSize);
  return entry.method === 8 ? zlib.inflateRawSync(data) : data;
}

function docxText(buf) {
  const entries = zipReadEntries(buf);
  const doc = entries.find((e) => e.name === 'word/document.xml');
  if (!doc) throw new Error('不是有效的 docx（缺 word/document.xml）');
  const xml = zipReadFile(buf, doc).toString('utf8');
  // 只取正文 <w:t>；按 </w:p> 断行。作者/公司/修订/批注在别的部件里，天然不进入文本。
  let s = xml.replace(/<\/w:p>/g, '\n');
  s = s.replace(/<w:t[^>]*>/g, '').replace(/<\/w:t>/g, '');
  s = s.replace(/<[^>]+>/g, '');
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function extractText(filename, buf, mimetype) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  try {
    if (TEXT_EXT.has(ext) || (mimetype || '').startsWith('text/') || ext === 'json') {
      const s = buf.toString('utf8').replace(/^﻿/, '');
      return { text: s.slice(0, MAX_CHARS), engine: 'plain' };
    }
    if (ext === 'docx') {
      const s = docxText(buf);
      if (!s.trim()) return { error: 'docx 里没有可提取的正文文本（可能是扫描件）' };
      return { text: s.slice(0, MAX_CHARS), engine: 'docx' };
    }
    if (ext === 'pdf' || ext === 'xlsx' || ext === 'xls' || ext === 'doc') {
      return { error: `${ext} 提取将在 P1 版本支持，请先另存为 txt/docx` };
    }
    if (IMAGE_EXT.has(ext) || (mimetype || '').startsWith('image/')) {
      return { error: '图片附件无法脱敏（内容本身送出去就是明文），P1 起提供 EXIF 剥离' };
    }
    return { error: `暂不支持 .${ext} 格式` };
  } catch (e) {
    return { error: `提取失败：${e.message}` };
  }
}

module.exports = { extractText, MAX_CHARS };
