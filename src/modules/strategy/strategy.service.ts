import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';
import { StrategyStatus, StrategyType } from '@prisma/client';

export interface CreateStrategyDto {
  name: string;
  type: StrategyType;
  description?: string;
  allocationBtc: number;
  params?: Record<string, any>;
}

@Injectable()
export class StrategyService {
  private readonly logger = new Logger(StrategyService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateStrategyDto) {
    return this.prisma.strategy.create({
      data: {
        userId,
        name: dto.name,
        type: dto.type,
        description: dto.description,
        allocationBtc: dto.allocationBtc,
        params: dto.params ?? {},
        status: StrategyStatus.DRAFT,
      },
    });
  }

  async list(userId: string, status?: StrategyStatus) {
    return this.prisma.strategy.findMany({
      where: {
        userId,
        ...(status ? { status } : { status: { not: StrategyStatus.CLOSED } }),
      },
      include: {
        legs: { where: { isOpen: true } },
        snapshots: { orderBy: { timestamp: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(userId: string, strategyId: string) {
    const strategy = await this.prisma.strategy.findFirst({
      where: { id: strategyId, userId },
      include: {
        legs: true,
        snapshots: { orderBy: { timestamp: 'desc' }, take: 24 },
      },
    });
    if (!strategy) throw new NotFoundException('Strategy not found');
    return strategy;
  }

  async activate(userId: string, strategyId: string) {
    await this.requireOwned(userId, strategyId);
    return this.prisma.strategy.update({
      where: { id: strategyId },
      data: { status: StrategyStatus.ACTIVE },
    });
  }

  async pause(userId: string, strategyId: string) {
    await this.requireOwned(userId, strategyId);
    return this.prisma.strategy.update({
      where: { id: strategyId },
      data: { status: StrategyStatus.PAUSED },
    });
  }

  async close(userId: string, strategyId: string) {
    await this.requireOwned(userId, strategyId);
    return this.prisma.strategy.update({
      where: { id: strategyId },
      data: { status: StrategyStatus.CLOSED, closedAt: new Date() },
    });
  }

  async addLeg(
    strategyId: string,
    leg: {
      instrumentName: string;
      direction: 'buy' | 'sell';
      quantity: number;
      openPrice: number;
      orderId?: string;
    },
  ) {
    return this.prisma.strategyLeg.create({
      data: {
        strategyId,
        instrumentName: leg.instrumentName,
        direction: leg.direction,
        quantity: leg.quantity,
        openPrice: leg.openPrice,
        orderId: leg.orderId,
      },
    });
  }

  async closeLeg(legId: string, closePrice: number) {
    return this.prisma.strategyLeg.update({
      where: { id: legId },
      data: { isOpen: false, closePrice, closeTimestamp: new Date() },
    });
  }

  /** Compute unrealized PnL in BTC across all open legs using current mark prices. */
  async computeUnrealizedPnl(
    strategyId: string,
    markPrices: Record<string, number>, // instrumentName → current price
  ): Promise<number> {
    const legs = await this.prisma.strategyLeg.findMany({
      where: { strategyId, isOpen: true },
    });

    let pnl = 0;
    for (const leg of legs) {
      const markPrice = markPrices[leg.instrumentName];
      if (markPrice === undefined) continue;
      const sign = leg.direction === 'buy' ? 1 : -1;
      pnl += sign * Number(leg.quantity) * (markPrice - Number(leg.openPrice));
    }
    return pnl;
  }

  private async requireOwned(userId: string, strategyId: string) {
    const strategy = await this.prisma.strategy.findFirst({
      where: { id: strategyId, userId },
    });
    if (!strategy) throw new NotFoundException('Strategy not found');
    return strategy;
  }
}
