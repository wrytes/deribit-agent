#!/usr/bin/env node
// node scripts/inspect-users.js

const { age, section, row, run } = require('./lib');

run(async (prisma) => {
  const users = await prisma.user.findMany({
    include: {
      deribitAccounts: {
        select: { id: true, label: true, clientId: true, isDefault: true, isTestnet: true, createdAt: true },
      },
      _count: { select: { agentRuns: true } },
    },
    orderBy: { id: 'asc' },
  });

  section(`USERS  (${users.length})`);

  if (!users.length) { console.log('  (none)'); return; }

  for (const u of users) {
    console.log();
    row('ID',           u.id);
    row('Telegram',     u.telegramHandle ?? '—');
    row('Telegram ID',  u.telegramId != null ? String(u.telegramId) : '—');
    row('Notify',       [u.notifyTraining && 'training', u.notifyAgent && 'agent', u.notifyErrors && 'errors'].filter(Boolean).join(', ') || 'none');
    row('Agent runs',   String(u._count.agentRuns));
    if (u.deribitAccounts.length) {
      row('Deribit accts', String(u.deribitAccounts.length));
      for (const a of u.deribitAccounts) {
        const tag = [a.isDefault && 'default', a.isTestnet && 'testnet'].filter(Boolean).join(', ');
        console.log(`    └─   ${a.label.padEnd(12)} ${a.clientId}  ${tag ? `[${tag}]` : ''}  (${age(a.createdAt)})`);
      }
    } else {
      row('Deribit accts', '—');
    }
  }

  console.log('\n' + '═'.repeat(72) + '\n');
});
