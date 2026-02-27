import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../core/database/prisma.service';
import { DeribitClientService } from '../../integrations/deribit/deribit.client.service';
import { MarketDataService } from '../market-data/market-data.service';
import { TelegramService } from '../../integrations/telegram/telegram.service';
import { StrategyStatus } from '@prisma/client';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deribitClientService: DeribitClientService,
    private readonly marketDataService: MarketDataService,
    private readonly telegramService: TelegramService,
  ) {}

  // ---------------------------------------------------------------------------
  // Hourly: market snapshot + strategy snapshots
  // ---------------------------------------------------------------------------

  @Cron(CronExpression.EVERY_HOUR)
  async takeHourlySnapshots() {
    this.logger.log('Hourly snapshot run started');

    // Market snapshots
    try {
      const conditions = await this.marketDataService.getAllConditions();
      for (const c of conditions) {
        if (c.indexPrice > 0) {
          await this.marketDataService.saveSnapshot(c);
        }
      }
    } catch (err) {
      this.logger.error(`Market snapshot failed: ${err.message}`);
    }

    // Strategy snapshots
    const activeStrategies = await this.prisma.strategy.findMany({
      where: { status: StrategyStatus.ACTIVE },
      include: {
        legs: { where: { isOpen: true } },
        user: true,
      },
    });

    for (const strategy of activeStrategies) {
      await this.takeStrategySnapshot(strategy);
    }

    this.logger.log(`Hourly snapshot complete — ${activeStrategies.length} strategies processed`);
  }

  // ---------------------------------------------------------------------------
  // Every 15 min: check rebalance triggers
  // ---------------------------------------------------------------------------

  @Cron('*/15 * * * *')
  async checkRebalanceTriggers() {
    const activeStrategies = await this.prisma.strategy.findMany({
      where: { status: StrategyStatus.ACTIVE },
      include: { user: true },
    });

    for (const strategy of activeStrategies) {
      const params = strategy.params as Record<string, any>;
      const trigger = params?.rebalanceTriggerUsd;
      if (!trigger || trigger <= 0) continue;

      try {
        const btcPrice = await this.marketDataService.getIndexPrice('BTC');
        const lastPrice: number = params.lastRebalanceBtcPrice ?? btcPrice;
        const drift = Math.abs(btcPrice - lastPrice);

        if (drift >= trigger) {
          const direction = btcPrice > lastPrice ? '📈' : '📉';
          const msg =
            `⚖️ *Rebalance Triggered* — ${strategy.name}\n\n` +
            `${direction} BTC moved \`$${drift.toFixed(0)}\` ` +
            `(trigger: \`$${trigger}\`)\n` +
            `Last price: \`$${lastPrice.toLocaleString()}\`\n` +
            `Current:    \`$${btcPrice.toLocaleString()}\`\n\n` +
            `Time to check your delta hedge.`;

          const chatId = Number(strategy.user.telegramId);
          await this.sendSafeMarkdown(chatId, msg);

          // Record new baseline price so we don't re-alert until next drift
          await this.prisma.strategy.update({
            where: { id: strategy.id },
            data: {
              params: {
                ...(strategy.params as object),
                lastRebalanceBtcPrice: btcPrice,
              },
            },
          });

          this.logger.log(
            `Rebalance alert sent for strategy ${strategy.id} — drift $${drift.toFixed(0)}`,
          );
        }
      } catch (err) {
        this.logger.warn(`Rebalance check failed for ${strategy.id}: ${err.message}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async takeStrategySnapshot(strategy: {
    id: string;
    userId: string;
    legs: { instrumentName: string; direction: string; quantity: any; openPrice: any }[];
    user: { telegramId: bigint };
  }) {
    const btcPrice = await this.marketDataService.getIndexPrice('BTC').catch(() => 0);

    // Strategies with no open legs — store a price-only snapshot
    if (strategy.legs.length === 0) {
      await this.prisma.strategySnapshot.create({
        data: { strategyId: strategy.id, btcIndexPrice: btcPrice },
      });
      return;
    }

    // Fetch live position greeks from Deribit
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
        const p = pos.result;

        delta += p.delta ?? 0;
        gamma += p.gamma ?? 0;
        theta += p.theta ?? 0;
        vega  += p.vega  ?? 0;
        unrealizedPnlBtc += p.floating_profit_loss ?? 0;
        hasPositionData = true;
      }
    } catch (err) {
      this.logger.warn(`Could not fetch positions for strategy ${strategy.id}: ${err.message}`);
    }

    await this.prisma.strategySnapshot.create({
      data: {
        strategyId: strategy.id,
        btcIndexPrice: btcPrice,
        delta: hasPositionData ? delta : undefined,
        gamma: hasPositionData ? gamma : undefined,
        theta: hasPositionData ? theta : undefined,
        vega:  hasPositionData ? vega  : undefined,
        unrealizedPnlBtc: hasPositionData ? unrealizedPnlBtc : undefined,
      },
    });
  }

  private async sendSafeMarkdown(chatId: number, text: string) {
    try {
      await this.telegramService.sendMarkdownMessage(chatId, text);
    } catch (err) {
      if (err?.message?.includes('Bad Request') || err?.message?.includes("can't parse entities")) {
        await this.telegramService.sendMessage(chatId, text);
      } else {
        this.logger.warn(`Alert delivery failed to ${chatId}: ${err.message}`);
      }
    }
  }
}
