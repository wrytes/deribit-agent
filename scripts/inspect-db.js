#!/usr/bin/env node
// node scripts/inspect-db.js  — runs all three inspect scripts in sequence

const { section, run } = require('./lib');
const { PrismaClient } = require('@prisma/client');

// Import the query logic inline so we share one DB connection
const { age, fmt, bar, row } = require('./lib');

run(async (prisma) => {
  // ── Users ──────────────────────────────────────────────────────────────────
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
  if (!users.length) {
    console.log('  (none)');
  } else {
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
  }

  // ── Models ─────────────────────────────────────────────────────────────────
  const models = await prisma.trainedModel.findMany({
    include: {
      session: {
        select: { name: true, algorithm: true, currency: true, totalTimesteps: true, status: true, dataFrom: true, dataTo: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  section(`TRAINED MODELS  (${models.length})`);
  if (!models.length) {
    console.log('  (none)');
  } else {
    for (const m of models) {
      const s = m.session; const meta = m.metadata ?? {};
      console.log();
      row('ID',          m.id);
      row('Name',        m.name);
      row('Session',     s ? `${s.name}  [${s.status}]` : '—');
      row('Algorithm',   s?.algorithm ?? '—');
      row('Currency',    s?.currency ?? '—');
      row('Timesteps',   s?.totalTimesteps?.toLocaleString() ?? '—');
      row('Data range',  s ? `${s.dataFrom?.toISOString().slice(0,10)} → ${s.dataTo?.toISOString().slice(0,10)}` : '—');
      row('Mean reward', fmt(m.meanReward, 4));
      row('Std reward',  fmt(m.stdReward, 4));
      row('Sharpe',      fmt(m.sharpeRatio, 3));
      row('Max DD',      m.maxDrawdown ? `${(Number(m.maxDrawdown)*100).toFixed(1)}%` : '—');
      row('Win rate',    m.winRate     ? `${(Number(m.winRate)*100).toFixed(1)}%`     : '—');
      row('Size',        m.sizeBytes   ? `${(m.sizeBytes / 1_048_576).toFixed(1)} MB` : '—');
      row('Path',        m.storagePath ?? '—');
      row('Created',     `${new Date(m.createdAt).toISOString().slice(0,19)}  (${age(m.createdAt)})`);
      if (meta.obs_version) row('Obs version',  meta.obs_version);
      if (meta.obs_dims)    row('Obs dims',     String(meta.obs_dims));
      if (meta.action_dims) row('Action dims',  String(meta.action_dims));
    }
  }

  // ── Agent runs ─────────────────────────────────────────────────────────────
  const runs = await prisma.agentRun.findMany({
    include: {
      session: { select: { name: true, algorithm: true } },
      _count:  { select: { actions: true } },
    },
    orderBy: { startedAt: 'desc' },
  });

  section(`AGENT RUNS  (${runs.length})`);
  if (!runs.length) {
    console.log('  (none)');
  } else {
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
        row('Last tick', r.liveState.lastTickDate ?? '—');
        row('Open pos',  String((r.liveState.openPositions ?? []).length));
        row('Pending',   r.liveState.pendingAction ? r.liveState.pendingAction.action_type : 'none');
      }
    }
  }

  console.log('\n' + '═'.repeat(72) + '\n');
});
