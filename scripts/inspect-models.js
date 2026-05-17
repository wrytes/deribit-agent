#!/usr/bin/env node
// node scripts/inspect-models.js

const { fmt, age, section, row, run } = require('./lib');

run(async (prisma) => {
  const models = await prisma.trainedModel.findMany({
    include: {
      session: {
        select: { name: true, algorithm: true, currency: true, totalTimesteps: true, status: true, dataFrom: true, dataTo: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  section(`TRAINED MODELS  (${models.length})`);

  if (!models.length) { console.log('  (none)'); return; }

  for (const m of models) {
    const s    = m.session;
    const meta = m.metadata ?? {};
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
    row('Max DD',      m.maxDrawdown ? `${(Number(m.maxDrawdown) * 100).toFixed(1)}%` : '—');
    row('Win rate',    m.winRate     ? `${(Number(m.winRate) * 100).toFixed(1)}%`     : '—');
    row('Size',        m.sizeBytes   ? `${(m.sizeBytes / 1_048_576).toFixed(1)} MB`   : '—');
    row('Path',        m.storagePath ?? '—');
    row('Created',     `${new Date(m.createdAt).toISOString().slice(0,19)}  (${age(m.createdAt)})`);
    if (meta.obs_version) row('Obs version',  meta.obs_version);
    if (meta.obs_dims)    row('Obs dims',     String(meta.obs_dims));
    if (meta.action_dims) row('Action dims',  String(meta.action_dims));
  }

  console.log('\n' + '═'.repeat(72) + '\n');
});
