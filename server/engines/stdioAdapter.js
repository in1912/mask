'use strict';
// stdio 适配器：外部 CLI 引擎（godlp / sensitive-word 包装）。
// 约定：文本全文走 stdin；stdout 出 JSON（{"entities":[…]} 或裸数组）；诊断日志走 stderr。
// 输出宽容解析——只认 term 必填的实体，坐标对不上由上层 locateEntities 按 term 重定位。
// 命令经 shell 执行（Windows 下 'java -jar x.jar' 这类带参数命令必须走 shell），
// 命令值来自管理员在设置页填写的配置，等价于本机手动执行——本模块不做任何联网。
const { spawn } = require('child_process');

const MAX_STDOUT = 10 * 1024 * 1024; // 10MB 上限，防引擎失控刷爆内存

function parseEntities(stdout) {
  const s = String(stdout || '').trim();
  if (!s) throw new Error('引擎 stdout 为空');
  const i = s.search(/[[{]/);
  if (i < 0) throw new Error('stdout 里找不到 JSON（约定 stdout 只输出实体 JSON，日志走 stderr）');
  let data;
  try { data = JSON.parse(s.slice(i)); } catch { throw new Error('stdout JSON 解析失败'); }
  const arr = Array.isArray(data) ? data : data.entities;
  if (!Array.isArray(arr)) throw new Error('JSON 里没有实体数组（应为 {"entities":[…]} 或裸数组）');
  return arr.filter((it) => it && typeof it.term === 'string' && it.term);
}

function runStdioEngine(command, text, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!command || typeof command !== 'string' || !command.trim()) {
      return reject(new Error('未配置命令'));
    }
    let child;
    try {
      child = spawn(command, { shell: true, windowsHide: true });
    } catch (e) {
      return reject(new Error(`命令启动失败：${e.message}`));
    }
    let out = Buffer.alloc(0), err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* 已退出 */ }
      reject(new Error(`引擎 ${timeoutMs}ms 超时`));
    }, timeoutMs || 10000);

    child.stdout.on('data', (d) => {
      if (out.length < MAX_STDOUT) out = Buffer.concat([out, d]);
      else { done = true; try { child.kill(); } catch {} reject(new Error('引擎 stdout 超 10MB')); clearTimeout(timer); }
    });
    child.stderr.on('data', (d) => { if (err.length < 8000) err += d.toString(); });
    child.on('error', (e) => {
      if (done) return; done = true; clearTimeout(timer);
      reject(new Error(`命令无法执行（${e.message}）——检查命令拼写与 PATH`));
    });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`引擎退出码 ${code}${err ? '：' + err.split('\n').slice(-3).join(' ').slice(0, 300) : ''}`));
      }
      try { resolve({ entities: parseEntities(out) }); } catch (e) { reject(e); }
    });
    child.stdin.on('error', () => { /* 引擎提前退出，close 里会给真因 */ });
    child.stdin.write(text);
    child.stdin.end();
  });
}

module.exports = { runStdioEngine, parseEntities };
