import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { AgentRunStatus, AgentRunType } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { AGENT_RUN_QUEUE } from './agent.service';
import { LiveExecutionService, LivePosition, LiveState } from './live-execution.service';

export interface AgentRunJobData {
  runId: string;
  jobType?: 'execute' | 'paper-tick' | 'live-tick';
  dataFrom?: string;
  dataTo?: string;
  envOverrides?: Record<string, unknown>;
}

@Processor(AGENT_RUN_QUEUE)
export class AgentRunProcessor extends WorkerHost {
  private readonly logger = new Logger(AgentRunProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly liveExecution: LiveExecutionService,
  ) {
    super();
  }

  async process(job: Job<AgentRunJobData>): Promise<void> {
    const { runId, jobType, dataFrom, dataTo, envOverrides } = job.data;

    if (jobType === 'paper-tick') return this.processPaperTick(runId);
    if (jobType === 'live-tick')  return this.processLiveTick(runId);
    return this.processBacktest(runId, dataFrom, dataTo, envOverrides);
  }

  private async processBacktest(
    runId: string,
    dataFrom?: string,
    dataTo?: string,
    envOverrides?: Record<string, unknown>,
  ): Promise<void> {
    this.logger.log(`Backtest run ${runId}`);

    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) { this.logger.warn(`Agent ${runId} not found — skipping`); return; }
    if (!run.sessionId) { this.logger.warn(`Agent ${runId} has no sessionId — skipping`); return; }

    await this.prisma.$transaction([
      this.prisma.agentAction.deleteMany({ where: { runId } }),
      this.prisma.agentRun.update({
        where: { id: runId },
        data:  {
          currentCapitalBtc: run.initialCapitalBtc,
          realizedPnlBtc:    0,
          totalActions:      0,
          status:            AgentRunStatus.ACTIVE,
        },
      }),
    ]);

    const trainerUrl = this.config.get<string>('TRAINER_URL') ?? 'http://localhost:8000';

    try {
      const mergedEnvOverrides = {
        initial_margin_btc: Number(run.initialCapitalBtc),
        ...(envOverrides ?? {}),
      };

      const response = await fetch(`${trainerUrl}/run`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          run_id:        runId,
          session_id:    run.sessionId,
          ...(dataFrom       ? { data_from:     dataFrom          } : {}),
          ...(dataTo         ? { data_to:       dataTo            } : {}),
          env_overrides: mergedEnvOverrides,
        }),
        signal: AbortSignal.timeout(3_600_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => 'no body');
        throw new Error(`Trainer responded ${response.status}: ${text}`);
      }

      await this.prisma.agentRun.update({
        where: { id: runId },
        data:  { status: AgentRunStatus.COMPLETED, stoppedAt: new Date() },
      });

      this.logger.log(`Backtest ${runId} completed`);
    } catch (err) {
      this.logger.error(`Backtest ${runId} failed: ${(err as Error).message}`);
      await this.prisma.agentRun.update({
        where: { id: runId },
        data:  { status: AgentRunStatus.ERROR, stoppedAt: new Date() },
      }).catch(() => null);
      throw err;
    }
  }

  private async processPaperTick(runId: string): Promise<void> {
    this.logger.log(`Paper tick ${runId}`);

    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) { this.logger.warn(`Agent ${runId} not found — skipping`); return; }
    if (run.status !== AgentRunStatus.ACTIVE) {
      this.logger.warn(`Agent ${runId} is not ACTIVE (${run.status}) — skipping paper tick`);
      return;
    }

    const paperState = run.paperState as Record<string, unknown> | null;
    const today = new Date().toISOString().split('T')[0];
    if (paperState?.lastTickDate === today) {
      this.logger.log(`Paper run ${runId} already ticked today — skipping`);
      return;
    }

    const trainerUrl = this.config.get<string>('TRAINER_URL') ?? 'http://localhost:8000';

    try {
      const response = await fetch(`${trainerUrl}/paper/tick`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ run_id: runId }),
        signal:  AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => 'no body');
        throw new Error(`Trainer responded ${response.status}: ${text}`);
      }

      const result = await response.json() as { terminated?: boolean };
      this.logger.log(`Paper tick ${runId} done — terminated=${result.terminated}`);

      if (result.terminated) {
        await this.prisma.agentRun.update({
          where: { id: runId },
          data:  { status: AgentRunStatus.STOPPED, stoppedAt: new Date() },
        });
      }
    } catch (err) {
      this.logger.error(`Paper tick ${runId} failed: ${(err as Error).message}`);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Live tick — prediction + real order execution
  // ---------------------------------------------------------------------------

  private async processLiveTick(runId: string): Promise<void> {
    this.logger.log(`Live tick ${runId}`);

    const run = await this.prisma.agentRun.findUnique({
      where:   { id: runId },
      include: { deribitAccount: true },
    });
    if (!run) { this.logger.warn(`Agent ${runId} not found`); return; }
    if (run.status !== AgentRunStatus.ACTIVE) {
      this.logger.warn(`Agent ${runId} not ACTIVE (${run.status}) — skipping`);
      return;
    }
    if (!run.deribitAccount) {
      this.logger.warn(`Agent ${runId} has no deribitAccount — skipping live tick`);
      return;
    }

    const liveState  = (run.liveState as LiveState | null) ?? null;
    const today      = new Date().toISOString().split('T')[0];
    if (liveState?.lastTickDate === today) {
      this.logger.log(`Live run ${runId} already ticked today — skipping`);
      return;
    }

    const trainerUrl     = this.config.get<string>('TRAINER_URL') ?? 'http://localhost:8000';
    const userId         = run.deribitAccount.userId;
    const currency       = run.currency as 'BTC' | 'ETH';
    const openPositions  = [...(liveState?.openPositions ?? [])];
    let   marginBalance  = Number(run.currentCapitalBtc ?? run.initialCapitalBtc);
    const currentDate    = new Date();
    const entries:       Record<string, unknown>[] = [];
    let   ms             = 0;
    const ts = () => new Date(currentDate.getTime() + ms++).toISOString().replace(/(\.\d{3})Z$/, '$1Z');

    // 1. Get model prediction
    const predResp = await fetch(`${trainerUrl}/live/predict`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ run_id: runId }),
      signal:  AbortSignal.timeout(120_000),
    });
    if (!predResp.ok) {
      const text = await predResp.text().catch(() => 'no body');
      throw new Error(`/live/predict failed: ${predResp.status} ${text}`);
    }
    const pred = await predResp.json() as {
      action_id:   number;
      action_type: string;
      legs:        { side: string; option_type: 'call' | 'put'; strike: number; dte: number; size: number }[];
      close_legs:  string[];
      terminated:  boolean;
    };

    this.logger.log(`Live tick ${runId}: action=${pred.action_type} legs=${pred.legs.length}`);

    // 2. First tick — emit settlement_init
    if (!liveState) {
      entries.push({
        actionType:       'settlement_init',
        timestamp:        ts(),
        marginBalanceBtc: marginBalance,
        equityBtc:        marginBalance,
        reason:           'initial balance',
      });
    }

    // 3. Execute trade decision
    if (pred.action_type === 'open' && pred.legs.length > 0) {
      for (const leg of pred.legs) {
        const snap = await this.liveExecution.snapInstrument(currency, leg.option_type, leg.strike, leg.dte);
        if (!snap) {
          this.logger.warn(`Could not snap instrument for ${leg.option_type} strike≈${leg.strike} dte=${leg.dte}`);
          continue;
        }

        const fill = await this.liveExecution.placeAndAwaitFill(userId, 'sell', snap.instrumentName, leg.size);
        if (!fill.filled) continue;

        const cashflow = fill.fillPriceBtc * leg.size;
        marginBalance += cashflow - fill.feeBtc;

        const newPos: LivePosition = {
          label:        snap.instrumentName,
          optionType:   leg.option_type,
          strike:       snap.strike,
          expiryDate:   snap.expiryDate,
          size:         leg.size,
          entryPremBtc: fill.fillPriceBtc,
          openFeeBtc:   fill.feeBtc,
          openOrderId:  fill.orderId,
          lastMktPrem:  fill.fillPriceBtc,
          openedAt:     today,
        };
        openPositions.push(newPos);

        const liability = openPositions.reduce((s, p) => s + p.size * p.lastMktPrem, 0);
        entries.push({
          actionType:       'open',
          timestamp:        ts(),
          instrument:       snap.instrumentName,
          quantity:         leg.size,
          price:            fill.fillPriceBtc,
          executedPrice:    fill.fillPriceBtc,
          orderId:          fill.orderId,
          feeBtc:           fill.feeBtc,
          cashflowBtc:      cashflow,
          marginBalanceBtc: marginBalance,
          equityBtc:        marginBalance - liability,
          reason:           `action_id=${pred.action_id}`,
        });
      }

    } else if (['close', 'close_call', 'close_put'].includes(pred.action_type)) {
      for (const legType of pred.close_legs) {
        const posIdx = openPositions.findIndex((p) => p.optionType === legType);
        if (posIdx === -1) continue;
        const pos = openPositions[posIdx];

        const fill = await this.liveExecution.placeAndAwaitFill(userId, 'buy', pos.label, pos.size);
        if (!fill.filled) continue;

        const cashflow       = -(fill.fillPriceBtc * pos.size);
        marginBalance       += cashflow - fill.feeBtc;
        const openFeePerUnit = pos.openFeeBtc / Math.max(pos.size, 1e-8);
        const pnl            = (pos.entryPremBtc - fill.fillPriceBtc - openFeePerUnit - fill.feeBtc / Math.max(pos.size, 1e-8)) * pos.size;

        openPositions.splice(posIdx, 1);
        const liability = openPositions.reduce((s, p) => s + p.size * p.lastMktPrem, 0);
        entries.push({
          actionType:       'close',
          timestamp:        ts(),
          instrument:       pos.label,
          quantity:         pos.size,
          price:            fill.fillPriceBtc,
          executedPrice:    pos.entryPremBtc,
          orderId:          fill.orderId,
          pnlBtc:           pnl,
          feeBtc:           fill.feeBtc,
          cashflowBtc:      cashflow,
          marginBalanceBtc: marginBalance,
          equityBtc:        marginBalance - liability,
        });
      }
    }

    // 4. Hold entry if no trades were placed
    const hasTrade = entries.some((e) => e['actionType'] === 'open' || e['actionType'] === 'close');
    if (!hasTrade) {
      const liability = openPositions.reduce((s, p) => s + p.size * p.lastMktPrem, 0);
      entries.push({
        actionType:       'hold',
        timestamp:        ts(),
        marginBalanceBtc: marginBalance,
        equityBtc:        marginBalance - liability,
      });
    }

    // 5. Sync equity with real Deribit account balance
    const realEquity = await this.liveExecution.getAccountEquity(userId, currency).catch(() => null);
    if (realEquity !== null) marginBalance = realEquity;

    // 6. Build updated liveState
    const equity         = marginBalance - openPositions.reduce((s, p) => s + p.size * p.lastMktPrem, 0);
    const equityHistory  = [...(liveState?.equityHistory ?? []), equity].slice(-31);
    const newLiveState: LiveState = {
      lastTickDate:    today,
      stepCount:       (liveState?.stepCount ?? 0) + 1,
      initialBtcPrice: liveState?.initialBtcPrice ?? marginBalance,
      prevEquity:      equity,
      equityHistory,
      openPositions,
    };

    // 7. Flush to DB
    await this._flushLiveActions(runId, entries, marginBalance, newLiveState);

    if (pred.terminated) {
      await this.prisma.agentRun.update({
        where: { id: runId },
        data:  { status: AgentRunStatus.STOPPED, stoppedAt: new Date() },
      });
    }
    this.logger.log(`Live tick ${runId} done — ${entries.length} entries, equity=${equity.toFixed(4)} BTC`);
  }

  private async _flushLiveActions(
    runId:         string,
    entries:       Record<string, unknown>[],
    capitalBtc:    number,
    liveState:     LiveState,
  ): Promise<void> {
    if (entries.length) {
      await this.prisma.agentAction.createMany({
        data: entries.map((e) => ({
          runId,
          actionType:      e['actionType']       as string,
          timestamp:       e['timestamp']        ? new Date(e['timestamp'] as string) : undefined,
          instrument:      e['instrument']       as string | undefined,
          quantity:        e['quantity']         as number | undefined,
          price:           e['price']            as number | undefined,
          orderId:         e['orderId']          as string | undefined,
          btcPrice:        e['btcPrice']         as number | undefined,
          delta:           e['delta']            as number | undefined,
          executedPrice:   e['executedPrice']    as number | undefined,
          pnlBtc:          e['pnlBtc']           as number | undefined,
          feeBtc:          e['feeBtc']           as number | undefined,
          cashflowBtc:     e['cashflowBtc']      as number | undefined,
          equityBtc:       e['equityBtc']        as number | undefined,
          marginBalanceBtc:e['marginBalanceBtc'] as number | undefined,
          reason:          e['reason']           as string | undefined,
        })),
      });
    }

    const totalPnl = entries.reduce((s, e) => s + (Number(e['pnlBtc']) || 0), 0);
    await this.prisma.agentRun.update({
      where: { id: runId },
      data: {
        ...(entries.length ? { totalActions: { increment: entries.length } } : {}),
        ...(totalPnl       ? { realizedPnlBtc: { increment: totalPnl } }    : {}),
        currentCapitalBtc: capitalBtc,
        liveState:         liveState as any,
      },
    });
  }
}
