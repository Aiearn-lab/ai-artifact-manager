'use strict';

/**
 * 生成 Pro 激活码。用法：
 *   node scripts/make-pro-code.js 1
 *   node scripts/make-pro-code.js 1-20     # 一次生成 1 到 20 号
 *
 * 密钥必须和 main.js 里的 PRO_SECRET 一致，改一边就得改另一边。
 */

const crypto = require('crypto');

const PRO_SECRET = 'zhiwei-studio-pro-2026';

function codeFor(seq) {
  const h = crypto.createHmac('sha256', PRO_SECRET).update(String(seq)).digest('hex').toUpperCase();
  return `ZW-${h.slice(0, 4)}-${h.slice(4, 8)}-${seq}`;
}

const arg = process.argv[2] || '1';
let list = [];
if (arg.includes('-')) {
  const [a, b] = arg.split('-').map(Number);
  for (let i = a; i <= b; i += 1) list.push(i);
} else {
  list = [Number(arg)];
}

for (const n of list) {
  if (!Number.isFinite(n) || n < 1) {
    console.error('序号要是正整数');
    process.exit(1);
  }
  console.log(codeFor(n));
}
