import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../core/database/prisma.service';
import { DeribitClientService } from '../../integrations/deribit/deribit.client.service';
import { MarketDataService } from '../market-data/market-data.service';
import { TelegramService } from '../../integrations/telegram/telegram.service';
import { DataIngestionService } from '../data-ingestion/data-ingestion.service';
import { AgentRunStatus, AgentRunType } from '@prisma/client';
import { LiveExecutionService, LivePosition, LiveState } from '../agent/live-execution.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deribitClientService: DeribitClientService,
    private readonly marketDataService: MarketDataService,
    private readonly telegramService: TelegramService,
    private readonly dataIngestionService: DataIngestionService,
    private readonly liveExecution: LiveExecutionService,
  ) {}

  // ---------------------------------------------------------------------------
  // Every hour: candle pipeline + market snapshots + strategy greeks
  // ---------------------------------------------------------------------------

  @Cron(CronExpression.EVERY_HOUR)
  async runHourly() {
    this.logger.log('Hourly run started');

    // 1. Ingest latest candles for all tracked instruments
    try {
      const results = await this.dataIngestionService.ingestAllTracked();
      const total = results.reduce((s, r) => s + r.inserted, 0);
      this.logger.log(`Candle ingestion: ${total} new rows across ${results.length} series`);
    } catch (err) {
      this.logger.error(`Candle ingestion failed: ${err.message}`);
    }

    // 2. Save market snapshots (IV rank, DVOL, RV)
    try {
      const conditions = await this.marketDataService.getAllConditions();
      for (const c of conditions) {
        if (c.indexPrice > 0) await this.marketDataService.saveSnapshot(c);
      }
    } catch (err) {
      this.logger.error(`Market snapshot failed: ${err.message}`);
    }

    // 3. Option chain snapshot (bumped from 6h to hourly for paper trading accuracy)
    for (const currency of ['BTC', 'ETH'] as const) {
      try {
        const result = await this.dataIngestionService.snapshotOptionChain(currency);
        this.logger.log(`Options snapshot [${currency}]: ${result.captured} rows`);
      } catch (err: any) {
        this.logger.error(`Options snapshot failed [${currency}]: ${err?.message ?? String(err)}`);
      }
    }

    this.logger.log('Hourly run done');
  }

  // ---------------------------------------------------------------------------
  // 08:01 UTC: live mark-to-market
  // The trainer polling loop handles prediction; we execute once pendingAction appears.
  // ---------------------------------------------------------------------------

  @Cron('1 8 * * *')
  async runLiveTicks() {
    const activeRuns = await this.prisma.agentRun.findMany({
      where:   { runType: AgentRunType.LIVE, status: AgentRunStatus.ACTIVE },
      include: { deribitAccount: true },
    });
    if (!activeRuns.length) return;
    this.logger.log(`Live mark-to-market for ${activeRuns.length} active LIVE run(s)`);

    const today = new Date().toISOString().split('T')[0];

    for (const run of activeRuns) {
      if (!run.deribitAccount) continue;

      const liveState = (run.liveState as LiveState | null) ?? null;
      if (liveState?.lastTickDate === today) continue;

      const userId    = run.deribitAccount.userId;
      const positions = liveState?.openPositions ?? [];

      if (positions.length > 0) {
        try {
          const marginBalance = Number(run.currentCapitalBtc ?? run.initialCapitalBtc);
          const { entries, updatedPositions, settledPnlBtc } =
            await this.liveExecution.markOpenPositions(userId, positions, marginBalance, new Date());

          if (entries.length > 0) {
            await this.prisma.$transaction([
              this.prisma.agentAction.createMany({
                data: entries.map((e: any) => ({
                  runId:           run.id,
                  actionType:      e.actionType,
                  timestamp:       e.timestamp ? new Date(e.timestamp) : undefined,
                  instrument:      e.instrument,
                  quantity:        e.quantity,
                  price:           e.price,
                  executedPrice:   e.executedPrice,
                  delta:           e.delta,
                  pnlBtc:          e.pnlBtc,
                  feeBtc:          e.feeBtc,
                  cashflowBtc:     e.cashflowBtc,
                  equityBtc:       e.equityBtc,
                  marginBalanceBtc:e.marginBalanceBtc,
                  reason:          e.reason,
                })),
              }),
              this.prisma.agentRun.update({
                where: { id: run.id },
                data: {
                  totalActions:   { increment: entries.length },
                  ...(settledPnlBtc ? { realizedPnlBtc: { increment: settledPnlBtc } } : {}),
                  liveState: {
                    ...(liveState ?? {}),
                    openPositions: updatedPositions,
                  } as any,
                },
              }),
            ]);
          }
          this.logger.log(`Live mark-to-market ${run.id}: ${entries.length} entries`);
        } catch (err: any) {
          this.logger.error(`Live mark-to-market failed for ${run.id}: ${err?.message ?? String(err)}`);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Every minute: execute any pending live trade decisions written by the trainer
  // ---------------------------------------------------------------------------

  @Cron('* * * * *')
  async pollPendingActions() {
    const activeRuns = await this.prisma.agentRun.findMany({
      where:   { runType: AgentRunType.LIVE, status: AgentRunStatus.ACTIVE },
      include: { deribitAccount: true },
    });

    for (const run of activeRuns) {
      const liveState  = (run.liveState as (LiveState & { pendingAction?: any }) | null) ?? null;
      const pred       = liveState?.pendingAction;
      if (!pred) continue;
      if (!run.deribitAccount) continue;

      this.logger.log(`Executing pendingAction for live run ${run.id}: ${pred.action_type}`);
      try {
        await this._executePendingAction(run, liveState!, pred);
      } catch (err: any) {
        this.logger.error(`pendingAction execution failed for ${run.id}: ${err?.message ?? String(err)}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: execute a pending live trade decision
  // ---------------------------------------------------------------------------

  private async _executePendingAction(
    run: any,
    liveState: LiveState & { pendingAction?: any },
    pred: {
      action_id:   number;
      action_type: string;
      legs:        { side: string; option_type: 'call' | 'put'; strike: number; dte: number; size: number }[];
      close_legs:  string[];
      terminated:  boolean;
    },
  ): Promise<void> {
    const userId        = run.deribitAccount.userId;
    const currency      = run.currency as 'BTC' | 'ETH';
    const openPositions = [...(liveState?.openPositions ?? [])] as LivePosition[];
    let   marginBalance = Number(run.currentCapitalBtc ?? run.initialCapitalBtc);
    const today         = new Date().toISOString().split('T')[0];
    const currentDate   = new Date();
    const entries:      Record<string, unknown>[] = [];
    let   ms            = 0;
    const ts = () => new Date(currentDate.getTime() + ms++).toISOString().replace(/(\.\d{3})Z$/, '$1Z');

    // First tick: emit settlement_init
    if (!liveState?.lastTickDate) {
      entries.push({
        actionType:       'settlement_init',
        timestamp:        ts(),
        marginBalanceBtc: marginBalance,
        equityBtc:        marginBalance,
        reason:           'initial balance',
      });
    }

    // Execute trade decision
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

    // Hold entry if no trades were placed
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

    // Sync with real Deribit balance
    const realEquity = await this.liveExecution.getAccountEquity(userId, currency).catch(() => null);
    if (realEquity !== null) marginBalance = realEquity;

    // Build new liveState — clear pendingAction, set lastTickDate
    const equity        = marginBalance - openPositions.reduce((s, p) => s + p.size * p.lastMktPrem, 0);
    const equityHistory = [...(liveState?.equityHistory ?? []), equity].slice(-31);
    const newLiveState: LiveState = {
      lastTickDate:    today,
      stepCount:       (liveState?.stepCount ?? 0) + 1,
      initialBtcPrice: liveState?.initialBtcPrice ?? marginBalance,
      prevEquity:      equity,
      equityHistory,
      openPositions,
    };

    // Flush to DB
    if (entries.length) {
      await this.prisma.agentAction.createMany({
        data: entries.map((e) => ({
          runId:           run.id,
          actionType:      e['actionType']        as string,
          timestamp:       e['timestamp']         ? new Date(e['timestamp'] as string) : undefined,
          instrument:      e['instrument']        as string | undefined,
          quantity:        e['quantity']          as number | undefined,
          price:           e['price']             as number | undefined,
          orderId:         e['orderId']           as string | undefined,
          btcPrice:        e['btcPrice']          as number | undefined,
          delta:           e['delta']             as number | undefined,
          executedPrice:   e['executedPrice']     as number | undefined,
          pnlBtc:          e['pnlBtc']            as number | undefined,
          feeBtc:          e['feeBtc']            as number | undefined,
          cashflowBtc:     e['cashflowBtc']       as number | undefined,
          equityBtc:       e['equityBtc']         as number | undefined,
          marginBalanceBtc:e['marginBalanceBtc']  as number | undefined,
          reason:          e['reason']            as string | undefined,
        })),
      });
    }

    const totalPnl = entries.reduce((s, e) => s + (Number(e['pnlBtc']) || 0), 0);
    await this.prisma.agentRun.update({
      where: { id: run.id },
      data: {
        ...(entries.length ? { totalActions: { increment: entries.length } } : {}),
        ...(totalPnl       ? { realizedPnlBtc: { increment: totalPnl } }    : {}),
        currentCapitalBtc: marginBalance,
        liveState:         newLiveState as any,
      },
    });

    if (pred.terminated) {
      await this.prisma.agentRun.update({
        where: { id: run.id },
        data:  { status: AgentRunStatus.STOPPED, stoppedAt: new Date() },
      });
    }

    this.logger.log(
      `Live tick ${run.id} done — ${entries.length} entries, equity=${equity.toFixed(4)} BTC`,
    );
  }

}
