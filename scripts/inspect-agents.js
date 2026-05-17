#!/usr/bin/env node
// node scripts/inspect-agents.js

const { fmt, age, bar, section, row, run } = require('./lib');

run(async (prisma) => {
  const runs = await prisma.agentRun.findMany({
    include: {
      session: { select: { name: true, algorithm: true } },
      _count:  { select: { actions: true } },
    },
    orderBy: { startedAt: 'desc' },
  });

  section(`AGENT RUNS  (${runs.length})`);

  if (!runs.length) { console.log('  (none)'); return; }

  const maxActions = Math.max(...runs.map(r => r._count.actions), 1);

  for (const r of runs) {
    const pnl  = Number(r.realizedPnlBtc ?? 0);
    const cap  = Number(r.currentCapitalBtc ?? r.initialCapitalBtc ?? 0);
    const init = Number(r.initialCapitalBtc ?? 0);
    const ret  = init > 0 ? ((cap - init) / init * 100) : 0;

    console.log();
    row('ID',       r.id);
    row('Name',     r.name);
    row('User',     r.userId);
    row('Type',     `${r.runType}  →  ${r.status}`);
    row('Session',  r.session ? `${r.session.name} (${r.session.algorithm})` : '— (no model)');
    row('Currency', r.currency);
    row('Capital',  `${fmt(r.initialCapitalBtc, 4)} BTC  →  ${fmt(r.currentCapitalBtc, 4)} BTC  (${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%)`);
    row('PnL',      `${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} BTC`);
    row('Actions',  `${r._count.actions.toLocaleString().padStart(6)}  ${bar(r._count.actions, maxActions)}`);
    row('Started',  `${new Date(r.startedAt).toISOString().slice(0,19)}  (${age(r.startedAt)})`);
    if (r.stoppedAt) row('Stopped', `${new Date(r.stoppedAt).toISOString().slice(0,19)}  (${age(r.stoppedAt)})`);
    if (r.runType === 'PAPER' && r.paperState) {
      row('Last tick',  r.paperState.lastTickDate ?? '—');
      row('Step count', String(r.paperState.stepCount ?? '—'));
    }
    if (r.runType === 'LIVE' && r.liveState) {
      row('Last tick',  r.liveState.lastTickDate ?? '—');
      row('Open pos',   String((r.liveState.openPositions ?? []).length));
      row('Pending',    r.liveState.pendingAction ? r.liveState.pendingAction.action_type : 'none');
    }
  }

  console.log('\n' + '═'.repeat(72) + '\n');
});
