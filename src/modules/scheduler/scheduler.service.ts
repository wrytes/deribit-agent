import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../core/database/prisma.service';
import { DeribitClientService } from '../../integrations/deribit/deribit.client.service';
import { MarketDataService } from '../market-data/market-data.service';
import { TelegramService } from '../../integrations/telegram/telegram.service';
import { DataIngestionService } from '../data-ingestion/data-ingestion.service';
import { StrategyStatus } from '@prisma/client';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deribitClientService: DeribitClientService,
    private readonly marketDataService: MarketDataService,
    private readonly telegramService: TelegramService,
    private readonly dataIngestionService: DataIngestionService,
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

    // 3. Strategy greeks snapshots
    const activeStrategies = await this.prisma.strategy.findMany({
      where: { status: StrategyStatus.ACTIVE },
      include: { user: true, legs: { where: { isOpen: true } } },
    });

    for (const strategy of activeStrategies) {
      try {
        await this.takeStrategySnapshot(strategy);
      } catch (err) {
        this.logger.warn(`Strategy snapshot failed for ${strategy.id}: ${err.message}`);
      }
    }

    this.logger.log(`Hourly run done — ${activeStrategies.length} strategy snapshot(s)`);
  }

  // ---------------------------------------------------------------------------
  // Every 6 hours: options chain snapshot (IV surface)
  // ---------------------------------------------------------------------------

  @Cron('0 */6 * * *')
  async snapshotOptionChains() {
    this.logger.log('Options chain snapshot started');

    for (const currency of ['BTC', 'ETH'] as const) {
      try {
        const result = await this.dataIngestionService.snapshotOptionChain(currency);
        this.logger.log(`Options snapshot [${currency}]: ${result.captured} rows`);
      } catch (err) {
        this.logger.error(`Options snapshot failed [${currency}]: ${err.message}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: strategy greeks snapshot
  // ---------------------------------------------------------------------------

  private async takeStrategySnapshot(strategy: {
    id: string;
    userId: string;
    legs: { instrumentName: string }[];
  }) {
    const btcPrice = await this.marketDataService.getIndexPrice('BTC').catch(() => 0);

    if (strategy.legs.length === 0) {
      await this.prisma.strategySnapshot.create({
        data: { strategyId: strategy.id, btcIndexPrice: btcPrice },
      });
      return;
    }

    let delta = 0, gamma = 0, theta = 0, vega = 0, unrealizedPnlBtc = 0;
    let hasPositionData = false;

    try {
      const client = await this.deribitClientService.getClient(strategy.userId);
      const posResults = await Promise.allSettled(
        strategy.legs.map((leg) =>
          client.account.getPosition({ instrument_name: leg.instrumentName }),
        ),
      );
      for (const res of posResults) {
        if (res.status !== 'fulfilled') continue;
        const pos = res.value;
        if (!('result' in pos)) continue;
        const p = pos.result as any;
        delta            += p.delta ?? 0;
        gamma            += p.gamma ?? 0;
        theta            += p.theta ?? 0;
        vega             += p.vega  ?? 0;
        unrealizedPnlBtc += p.floating_profit_loss ?? 0;
        hasPositionData = true;
      }
    } catch (err) {
      this.logger.warn(`Could not fetch greeks for strategy ${strategy.id}: ${err.message}`);
    }

    await this.prisma.strategySnapshot.create({
      data: {
        strategyId: strategy.id,
        btcIndexPrice: btcPrice,
        delta:            hasPositionData ? delta            : undefined,
        gamma:            hasPositionData ? gamma            : undefined,
        theta:            hasPositionData ? theta            : undefined,
        vega:             hasPositionData ? vega             : undefined,
        unrealizedPnlBtc: hasPositionData ? unrealizedPnlBtc : undefined,
      },
    });
  }
}
