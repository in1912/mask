'use strict';
// 面具 mask — 密钥与加密（AES-256-GCM，方案承教材 Textbook/secret.js）
// 用途：①登录日志「尝试的密码」加密落库 ②AI apikey 加密存储
// 密钥：data/secret.key（hex，首启自动生成）或 env MASK_SECRET（sha256 派生）
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function loadSecretKey(dataDir) {
  if (process.env.MASK_SECRET) {
    return crypto.createHash('sha256').update(process.env.MASK_SECRET).digest();
  }
  const p = path.join(dataDir, 'secret.key');
  if (!fs.existsSync(p)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(p, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'hex');
}

// 加密：v1.<iv b64>.<tag b64>.<data b64>
function enc(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

function dec(key, blob) {
  try {
    const parts = String(blob).split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const data = Buffer.from(parts[3], 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    return null; // 密钥更换/密文损坏 → 返回 null，调用方如实显示「无法解密」
  }
}

// 用户口令哈希（scrypt，承工作台 auth.js 语义：salt:hash 十六进制）
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64);
  return salt.toString('hex') + ':' + h.toString('hex');
}

function verifyPassword(pw, stored) {
  try {
    const [s, h] = String(stored).split(':');
    const calc = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 64);
    return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
  } catch {
    return false;
  }
}

module.exports = { loadSecretKey, enc, dec, hashPassword, verifyPassword };
