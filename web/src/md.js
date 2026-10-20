// 面具 mask — 小工具：markdown 渲染（先整体转义，防注入）+ 复制文本（HTTP 环境降级 execCommand）
export function mdToHtml(src) {
  const blocks = [];
  let t = String(src || '').replace(/\r\n/g, '\n')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // 围栏代码块先抽出，避免被行内规则改写
  t = t.replace(/```([\s\S]*?)```/g, (_, code) => {
    blocks.push('<pre>' + code.replace(/^\n/, '') + '</pre>');
    return '\u0001B' + (blocks.length - 1) + '\u0001';
  });
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  t = t.replace(/^#### (.*)$/gm, '<h4>$1</h4>').replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h3>$1</h3>').replace(/^# (.*)$/gm, '<h2>$1</h2>');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/\*([^*\n]+)\*/g, '<i>$1</i>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // 列表（- / * / 1. / 1、）
  t = t.replace(/^(?:[-*]|\d+[.、]) (.+)$/gm, '<li>$1</li>');
  const lines = t.split('\n');
  const out = [];
  let inList = false;
  for (const ln of lines) {
    const isLi = /^<li>/.test(ln);
    if (isLi && !inList) { out.push('<ul>'); inList = true; }
    if (!isLi && inList) { out.push('</ul>'); inList = false; }
    out.push(ln);
  }
  if (inList) out.push('</ul>');
  t = out.join('\n');
  t = t.replace(/\u0001B(\d+)\u0001/g, (_, i) => blocks[Number(i)]);
  // 段落：空行分段，段内换行转 <br>
  return t.split(/\n{2,}/).map((p) => {
    const s = p.trim();
    if (!s) return '';
    return /^<(h\d|ul|pre|blockquote)/.test(s) ? s : '<p>' + s.replace(/\n/g, '<br>') + '</p>';
  }).join('\n');
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 降级 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}
