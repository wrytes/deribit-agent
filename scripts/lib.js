/** Shared helpers for inspect-*.js scripts. */

const { PrismaClient } = require('@prisma/client');

function fmt(n, decimals = 4) {
  if (n == null) return '—';
  return Number(n).toFixed(decimals);
}

function age(date) {
  if (!date) return '—';
  const s = Math.floor((Date.now() - new Date(date)) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function bar(value, max, width = 20) {
  if (max === 0) return '─'.repeat(width);
  const filled = Math.round((value / max) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function section(title) {
  const line = '═'.repeat(72);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

function row(label, value, indent = 2) {
  const pad = ' '.repeat(indent);
  console.log(`${pad}${label.padEnd(22)} ${value}`);
}

function run(fn) {
  const prisma = new PrismaClient({ log: [] });
  fn(prisma)
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
}

module.exports = { fmt, age, bar, section, row, run };
