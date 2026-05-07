import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';
import { AgentRunStatus } from '@prisma/client';

export interface CreateRunDto {
  userId: string;
  sessionId?: string;
  name: string;
  currency: string;
  isLive?: boolean;
  initialCapitalBtc: number;
  notes?: string;
}

export interface LogActionDto {
  runId: string;
  actionType: string;
  instrument?: string;
  quantity?: number;
  price?: number;
  orderId?: string;
  btcPrice?: number;
  delta?: number;
  ivRank?: number;
  executedPrice?: number;
  pnlBtc?: number;
  reason?: string;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Agent runs
  // ---------------------------------------------------------------------------

  async createRun(dto: CreateRunDto) {
    return this.prisma.agentRun.create({
      data: {
        userId:            dto.userId,
        sessionId:         dto.sessionId,
        name:              dto.name,
        currency:          dto.currency,
        isLive:            dto.isLive ?? false,
        initialCapitalBtc: dto.initialCapitalBtc,
        currentCapitalBtc: dto.initialCapitalBtc,
        notes:             dto.notes,
        status:            AgentRunStatus.ACTIVE,
      },
    });
  }

  async listRuns(userId: string, status?: AgentRunStatus) {
    return this.prisma.agentRun.findMany({
      where: {
        userId,
        ...(status ? { status } : {}),
      },
      include: {
        session: { select: { name: true, algorithm: true } },
        _count: { select: { actions: true } },
      },
      orderBy: { startedAt: 'desc' },
    });
  }

  async getRun(userId: string, id: string) {
    const run = await this.prisma.agentRun.findFirst({
      where: { id, userId },
      include: {
        session: { select: { name: true, algorithm: true, currency: true } },
        actions: { orderBy: { timestamp: 'desc' }, take: 100 },
      },
    });
    if (!run) throw new NotFoundException('Agent run not found');
    return run;
  }

  async stopRun(userId: string, id: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id, userId } });
    if (!run) throw new NotFoundException('Agent run not found');
    if (run.status !== AgentRunStatus.ACTIVE && run.status !== AgentRunStatus.PAUSED) {
      throw new BadRequestException(`Cannot stop a run with status ${run.status}`);
    }

    return this.prisma.agentRun.update({
      where: { id },
      data:  { status: AgentRunStatus.STOPPED, stoppedAt: new Date() },
    });
  }

  async pauseRun(userId: string, id: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id, userId } });
    if (!run) throw new NotFoundException('Agent run not found');
    if (run.status !== AgentRunStatus.ACTIVE) {
      throw new BadRequestException('Can only pause an ACTIVE run');
    }
    return this.prisma.agentRun.update({
      where: { id },
      data:  { status: AgentRunStatus.PAUSED },
    });
  }

  async resumeRun(userId: string, id: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id, userId } });
    if (!run) throw new NotFoundException('Agent run not found');
    if (run.status !== AgentRunStatus.PAUSED) {
      throw new BadRequestException('Can only resume a PAUSED run');
    }
    return this.prisma.agentRun.update({
      where: { id },
      data:  { status: AgentRunStatus.ACTIVE },
    });
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async logAction(dto: LogActionDto) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: dto.runId } });
    if (!run) throw new NotFoundException('Agent run not found');

    const action = await this.prisma.agentAction.create({
      data: {
        runId:         dto.runId,
        actionType:    dto.actionType,
        instrument:    dto.instrument,
        quantity:      dto.quantity,
        price:         dto.price,
        orderId:       dto.orderId,
        btcPrice:      dto.btcPrice,
        delta:         dto.delta,
        ivRank:        dto.ivRank,
        executedPrice: dto.executedPrice,
        pnlBtc:        dto.pnlBtc,
        reason:        dto.reason,
      },
    });

    // Update run counters
    const updates: Record<string, any> = {
      totalActions: { increment: 1 },
    };
    if (dto.pnlBtc !== undefined) {
      updates.realizedPnlBtc = { increment: dto.pnlBtc };
    }

    await this.prisma.agentRun.update({
      where: { id: dto.runId },
      data:  updates,
    });

    return action;
  }

  async getRunActions(userId: string, runId: string, limit?: number) {
    const run = await this.prisma.agentRun.findFirst({ where: { id: runId, userId } });
    if (!run) throw new NotFoundException('Agent run not found');

    return this.prisma.agentAction.findMany({
      where: { runId },
      orderBy: { timestamp: 'desc' },
      take: limit ?? 200,
    });
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  async getRunSummary(userId: string, runId: string) {
    const run = await this.getRun(userId, runId);

    const actionBreakdown = await this.prisma.$queryRaw<
      { action_type: string; count: bigint; total_pnl: number }[]
    >`
      SELECT "actionType" AS action_type,
             COUNT(*)     AS count,
             COALESCE(SUM("pnlBtc"), 0) AS total_pnl
      FROM "AgentAction"
      WHERE "runId" = ${runId}
      GROUP BY "actionType"
      ORDER BY count DESC
    `;

    return {
      run,
      actionBreakdown: actionBreakdown.map((r) => ({
        actionType: r.action_type,
        count:      Number(r.count),
        totalPnlBtc: Number(r.total_pnl),
      })),
    };
  }
}
