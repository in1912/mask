'use strict';
// 面具 mask — 附件/文件文本提取（零依赖；承工作台 fileTextService 思路，天然剥离文档元数据）
// 支持：文本类 + docx + pdf（ToUnicode CMap）+ xlsx；图片无法脱敏，明确拒收
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

const decodeXmlEnt = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

function docxText(buf) {
  const entries = zipReadEntries(buf);
  const doc = entries.find((e) => e.name === 'word/document.xml');
  if (!doc) throw new Error('不是有效的 docx（缺 word/document.xml）');
  const xml = zipReadFile(buf, doc).toString('utf8');
  // 只取正文 <w:t>；按 </w:p> 断行。作者/公司/修订/批注在别的部件里，天然不进入文本。
  const paras = xml.split(/<\/w:p>/).map((p) =>
    [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => decodeXmlEnt(m[1])).join(''));
  return paras.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---- xlsx：共享字符串表 + sheet 单元格（tab 分列、换行分行，便于规则引擎扫文本）----
function xlsxText(buf) {
  const entries = zipReadEntries(buf);
  const get = (name) => {
    const e = entries.find((x) => x.name === name);
    return e ? zipReadFile(buf, e).toString('utf8') : null;
  };
  const sst = [];
  const sstXml = get('xl/sharedStrings.xml');
  if (sstXml) {
    for (const m of sstXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      sst.push([...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decodeXmlEnt(t[1])).join(''));
    }
  }
  const sheets = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).map((e) => e.name).sort();
  const out = [];
  for (const s of sheets) {
    const xml = get(s) || '';
    const rows = [];
    for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cm of rm[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const vm = cm[2].match(/<v>([\s\S]*?)<\/v>/);
        const tm = cm[2].match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/);
        let val = tm ? decodeXmlEnt(tm[1]) : (vm ? vm[1] : '');
        if (/t="s"/.test(cm[1]) && vm) val = sst[Number(vm[1])] ?? '';
        cells.push(val);
      }
      if (cells.some((c) => c !== '')) rows.push(cells.join('\t'));
    }
    if (rows.length) out.push(rows.join('\n'));
  }
  const s = out.join('\n\n').trim();
  if (!s) throw new Error('xlsx 里没有可提取的单元格文本');
  return s;
}

// ---- PDF：对象级解析 + 按字体的 ToUnicode CMap（承工作台，支持中文 CID 1/2 字节）----
// 要点：① 每个字体资源（/TT2 8 0 R 等）有独立 ToUnicode 映射——按字体分组，不能全局合并
//          （合并会在字体子集间 CID 冲突时张冠李戴，产生错字）
//      ② codespacerange 有 1 字节（<00><FF>）和 2 字节（<0000><FFFF>）两种——按字体判断步长
//      ③ 内容流里跟踪 /TT2 12 Tf 字体切换，hex 字符串用当前字体的映射解码
//      ④ 只解析页面 /Contents 引用的内容流（跳过图片 XObject，避免无效解压卡死）
function pdfText(buf) {
  const text = buf.toString('latin1');
  const objRanges = [];
  for (const m of text.matchAll(/(\d+)\s+0\s+obj/g)) objRanges.push({ id: m[1], start: m.index });
  objRanges.sort((a, b) => a.start - b.start);
  for (let i = 0; i < objRanges.length; i++) {
    objRanges[i].end = i + 1 < objRanges.length ? objRanges[i + 1].start : text.length;
  }
  const objAt = (id) => objRanges.find((o) => o.id === id);

  function streamRangeIn(start, end) {
    const head = text.slice(start, Math.min(start + 3000, end));
    const sm = /stream\r?\n?/.exec(head);
    if (!sm) return null;
    const s = start + sm.index + sm[0].length;
    const e = text.indexOf('endstream', s);
    if (e < 0 || e > end) return null;
    return [s, e];
  }
  function inflateAt(s, e) {
    const raw = buf.subarray(s, e);
    try { return zlib.inflateSync(raw); } catch { /* 试 raw */ }
    try { return zlib.inflateRawSync(raw); } catch { /* 试原样 */ }
    // 未压缩（stored）流两种解压都失败——原样返回；非文本流会在可读性过滤里被拦下
    return raw;
  }
  // 解析一个 CMap → { step: 2|4, map: Map<cidHex, char> }
  // 注意：bfchar（<src> <dst> 两段）与 bfrange（<lo> <hi> <dst> 三段）必须在各自块内解析——
  // 全文盲目匹配三段时，相邻 bfchar 的 </dst> <src> 会被错配成一个 bfrange，映射全乱。
  function parseCmap(cs) {
    // codespacerange 决定 CID 字节数：<00><FF> → 1字节(step2) / <0000><FFFF> → 2字节(step4)
    let step = 4;
    const csm = /begincodespacerange\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/.exec(cs);
    if (csm && csm[1].length <= 2) step = 2;
    const map = new Map();
    for (const blk of cs.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const m of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
        if (m[1].length !== step || hi < lo || hi - lo > 65535) continue;
        const dst = parseInt(m[3].padStart(4, '0'), 16);
        for (let c = lo; c <= hi; c++) {
          const k = c.toString(16).padStart(step, '0').toUpperCase();
          if (!map.has(k)) map.set(k, String.fromCharCode(dst + (c - lo)));
        }
      }
    }
    for (const blk of cs.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const m of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const src = m[1].toUpperCase();
        if (src.length !== step || map.has(src)) continue;
        const dst = m[2];
        let ch = '';
        for (let i = 0; i < dst.length; i += 4) ch += String.fromCharCode(parseInt(dst.slice(i, i + 4).padStart(4, '0'), 16));
        map.set(src, ch);
      }
    }
    return { step, map };
  }

  // ① 字体名 → { step, map }（页面字体字典 /TT2 8 0 R + 字体对象 /ToUnicode N 0 R）
  const fontMaps = new Map();
  const fontNameToObj = new Map();
  for (const m of text.matchAll(/\/(TT\d+|F\d+|C2_\d+|C\d+\.\d+)\s+(\d+)\s+0\s+R/g)) {
    if (!fontNameToObj.has(m[1])) fontNameToObj.set(m[1], m[2]);
  }
  for (const [name, objId] of fontNameToObj) {
    const o = objAt(objId);
    if (!o) continue;
    const dict = text.slice(o.start, Math.min(o.start + 3000, o.end));
    const tu = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(dict);
    if (!tu) continue;
    const to = objAt(tu[1]);
    if (!to) continue;
    const r = streamRangeIn(to.start, to.end);
    if (!r) continue;
    const parsed = parseCmap(inflateAt(r[0], r[1]).toString('latin1'));
    if (parsed.map.size) fontMaps.set(name, parsed);
  }

  // ②/③ 内容流提取（跟踪 Tf 字体切换；CID 字体下括号字面量字节同样按 CID 解码）
  function extractCs(cs) {
    let out = '';
    let cur = null;
    const re = /\/(TT\d+|F\d+|C2_\d+|C\d+\.\d+)\s+[\d.]+\s+Tf|(<[0-9A-Fa-f\s]+>|\((?:\\.|[^\\()])*\))\s*Tj|(\[(?:[^\]]|\\.)*\])\s*TJ/g;
    let m;
    const dec = (s) => {
      if (s[0] === '<') {
        if (!cur) return '';
        const hex = s.slice(1, -1).replace(/\s+/g, '');
        let r = '';
        for (let i = 0; i + cur.step <= hex.length; i += cur.step) {
          r += cur.map.get(hex.slice(i, i + cur.step).toUpperCase()) || '';
        }
        return r;
      }
      // 括号字面量：当前字体有 CID 映射时按字节查（PPT/WPS 导出的 PDF 常见形态），
      // 查不出内容（非 CID 字体）才当普通字面量
      const inner = s.slice(1, -1);
      if (cur) {
        let bytes = '';
        for (const ch of inner) bytes += ch.charCodeAt(0).toString(16).padStart(2, '0');
        let r = '';
        for (let i = 0; i + cur.step <= bytes.length; i += cur.step) {
          r += cur.map.get(bytes.slice(i, i + cur.step).toUpperCase()) || '';
        }
        if (r) return r;
      }
      return inner.replace(/\\([0-7]{1,3})/g, ' ').replace(/\\([nrtbf])/g, ' ').replace(/\\(.)/g, '$1');
    };
    while ((m = re.exec(cs))) {
      if (m[1]) { cur = fontMaps.get(m[1]) || null; continue; }
      if (m[2]) out += dec(m[2]);
      else if (m[3]) for (const pm of m[3].matchAll(/(<[0-9A-Fa-f\s]+>|\((?:\\.|[^\\()])*\))/g)) out += dec(pm[1]);
    }
    return out;
  }

  const contentRefs = [];
  for (const m of text.matchAll(/\/Contents\s+(\d+)\s+0\s+R/g)) contentRefs.push(m[1]);
  let total = '';
  for (const id of contentRefs) {
    const o = objAt(id);
    if (!o) continue;
    const r = streamRangeIn(o.start, o.end);
    if (!r) continue;
    const cs = inflateAt(r[0], r[1]).toString('latin1');
    if (!/(Tj|TJ)/.test(cs)) continue;
    total += extractCs(cs) + '\n';
  }
  if (!total.trim()) throw new Error('PDF 里没有提取到文本（可能是扫描件/纯图片 PDF）');
  // 可读性过滤：解出来几乎全是乱码时如实报错
  const readable = total.replace(/[^\x20-\x7e一-鿿＀-￯　-〿\n]/g, '');
  if (readable.length / total.length < 0.5) throw new Error('PDF 文本解码失败（内嵌字体映射不受支持）');
  return total.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
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
    if (ext === 'xlsx') {
      return { text: xlsxText(buf).slice(0, MAX_CHARS), engine: 'xlsx' };
    }
    if (ext === 'pdf') {
      return { text: pdfText(buf).slice(0, MAX_CHARS), engine: 'pdf' };
    }
    if (ext === 'xls' || ext === 'doc') {
      return { error: `老格式 .${ext} 不受支持，请先另存为 ${ext === 'xls' ? 'xlsx' : 'docx'}` };
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
