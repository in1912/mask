'use strict';
// 面具 mask — 数据库（node:sqlite 单库 mask.sqlite，用户数据 user_id 隔离）
// 已知硬规则（承工作台教训）：①SQL 字符串字面量必须单引号；②占位符数量必须精确
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { hashPassword } = require('./secret');

const DATA_DIR = process.env.MASK_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'mask.sqlite'));
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  locked_permanent INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS login_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT DEFAULT (datetime('now','localtime')),
  username TEXT,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'fail',
  ip TEXT,
  region TEXT,
  password_enc TEXT,
  client TEXT,
  ua TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_logs_at ON login_logs(at DESC);
CREATE TABLE IF NOT EXISTS ip_blacklist (
  ip TEXT PRIMARY KEY,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  created_by TEXT
);
CREATE TABLE IF NOT EXISTS rule_config (
  user_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  mask_numbers INTEGER NOT NULL DEFAULT 0,
  amount_on INTEGER NOT NULL DEFAULT 1,
  code_style TEXT NOT NULL DEFAULT 'A',
  types_json TEXT NOT NULL DEFAULT '{}',
  fixed_terms_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, id DESC);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  masked_content TEXT,
  mask_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, id);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  type TEXT,
  size INTEGER DEFAULT 0,
  raw_text TEXT,
  masked_text TEXT,
  match_count INTEGER DEFAULT 0,
  meta_report_json TEXT DEFAULT '[]',
  source TEXT DEFAULT 'upload',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id, id DESC);
CREATE TABLE IF NOT EXISTS mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_type TEXT NOT NULL,
  scope_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  rule_key TEXT,
  category TEXT,
  style TEXT DEFAULT 'A',
  term TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(scope_type, scope_id, term)
);
CREATE INDEX IF NOT EXISTS idx_mappings_scope ON mappings(scope_type, scope_id);
CREATE TABLE IF NOT EXISTS ai_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER,
  conv_id INTEGER,
  source TEXT DEFAULT 'internal',
  raw_return TEXT,
  restored_text TEXT,
  review_json TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL DEFAULT 'agent',
  doc_id INTEGER,
  pair_token TEXT,
  expires_at TEXT,
  bind_type TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  revoked INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS link_writes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  word_count INTEGER DEFAULT 0,
  ua TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_link_writes ON link_writes(link_id, id);
CREATE TABLE IF NOT EXISTS desens_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  scope TEXT NOT NULL,
  ref_id INTEGER,
  item_count INTEGER DEFAULT 0,
  mapping_json TEXT DEFAULT '[]',
  masked_preview TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_history_user ON desens_history(user_id, id DESC);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  history_id INTEGER,
  verdict TEXT,
  detail_json TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  by_user TEXT
);
CREATE TABLE IF NOT EXISTS upgrade_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT DEFAULT (datetime('now','localtime')),
  version TEXT,
  action TEXT,
  detail TEXT,
  ok INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS batch_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'text',
  status TEXT NOT NULL DEFAULT 'ready',
  options_json TEXT DEFAULT '{}',
  total INTEGER DEFAULT 0,
  ok_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  error TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_batch_jobs_user ON batch_jobs(user_id, id DESC);
CREATE TABLE IF NOT EXISTS batch_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  ext TEXT,
  size INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT DEFAULT '',
  chars INTEGER DEFAULT 0,
  match_count INTEGER DEFAULT 0,
  preview_raw TEXT DEFAULT '',
  preview_masked TEXT DEFAULT '',
  out_name TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_batch_files_batch ON batch_files(batch_id, id);
`);

// ---- 轻量迁移：老库补列（幂等；表名与列名都是常量，不拼用户输入）----
function ensureColumn(table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}
ensureColumn('users', 'locked_until', 'TEXT');      // v1.01：连续输错 3 次锁 30 分钟
ensureColumn('links', 'remark', 'TEXT');            // v1.01：Agent 链接备注名
ensureColumn('documents', 'mask_engine', 'TEXT');   // v1.01：文件脱敏可单独选引擎（NULL=跟随全局）

// settings 读写（值 JSON 序列化，承工作台语义）
function getSetting(key, def = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row || row.value == null) return def;
  try { return JSON.parse(row.value); } catch { return def; }
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// 初始管理员：仅空库首启生效（默认 aiadmin/admin123，env 可覆盖）
function seedAdmin() {
  const n = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (n > 0) return;
  const name = process.env.MASK_ADMIN || 'aiadmin';
  const pass = process.env.MASK_ADMIN_PASSWORD || 'admin123';
  db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)')
    .run(name, hashPassword(pass), 'admin', '系统管理员');
}
seedAdmin();

// 文件名乱码修复：早期上传时 busboy 按 latin1 解码 multipart 文件名，中文名被存成「æµ‹è¯•.docx」。
// 只在「按 UTF-8 无损还原且含中文」时改，避免误伤本来就是 latin1 的文件名。幂等：修好后不再匹配。
function repairUploadNames() {
  const fix = (s) => {
    if (!s || !/[\u0080-ÿ]/.test(s)) return s;
    const utf8 = Buffer.from(s, 'latin1').toString('utf8');
    if (utf8.includes('�')) return s;          // 不是合法 UTF-8，保持原样
    return /[㐀-鿿]/.test(utf8) ? utf8 : s; // 还原出中文才采用
  };
  try {
    for (const row of db.prepare('SELECT id, filename FROM documents').all()) {
      const fixed = fix(row.filename);
      if (fixed !== row.filename) db.prepare('UPDATE documents SET filename = ? WHERE id = ?').run(fixed, row.id);
    }
  } catch { /* 老库结构不全时忽略，不影响启动 */ }
}
repairUploadNames();

module.exports = { db, DATA_DIR, getSetting, setSetting, repairUploadNames };
