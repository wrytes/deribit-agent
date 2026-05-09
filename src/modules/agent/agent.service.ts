import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../core/database/prisma.service';
import { AgentRunStatus, AgentRunType } from '@prisma/client';

export const AGENT_RUN_QUEUE = 'agent-run';

export interface CreateRunDto {
  userId: string;
  sessionId?: string;
  name: string;
  currency: string;
  runType?: AgentRunType;
  deribitAccountId?: string;
  initialCapitalBtc: number;
  notes?: string;
}

export interface LogActionDto {
  runId: string;
  actionType: string;
  timestamp?: Date;
  instrument?: string;
  quantity?: number;
  price?: number;
  orderId?: string;
  btcPrice?: number;
  delta?: number;
  ivRank?: number;
  executedPrice?: number;
  pnlBtc?: number;
  marginBalanceBtc?: number;
  reason?: string;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(AGENT_RUN_QUEUE) private readonly agentRunQueue: Queue,
  ) {}

  // ---------------------------------------------------------------------------
  // Agent runs
  // ---------------------------------------------------------------------------

  async createRun(dto: CreateRunDto) {
    if (dto.runType === AgentRunType.LIVE && !dto.deribitAccountId) {
      throw new BadRequestException('deribitAccountId is required for LIVE agents');
    }

    const run = await this.prisma.agentRun.create({
      data: {
        userId:            dto.userId,
        sessionId:         dto.sessionId,
        name:              dto.name,
        currency:          dto.currency,
        runType:           dto.runType ?? AgentRunType.PAPER,
        deribitAccountId:  dto.deribitAccountId,
        initialCapitalBtc: dto.initialCapitalBtc,
        currentCapitalBtc: dto.initialCapitalBtc,
        notes:             dto.notes,
        status:            AgentRunStatus.ACTIVE,
      },
    });

    if (run.runType === AgentRunType.BACKTEST && run.sessionId) {
      await this.agentRunQueue.add('execute', { runId: run.id }, {
        attempts: 2,
        backoff: { type: 'fixed', delay: 5_000 },
        removeOnComplete: false,
        removeOnFail:     false,
      });
    }

    return run;
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
    if (!run) throw new NotFoundException('Agent not found');
    return run;
  }

  async updateRun(userId: string, id: string, data: { name?: string; notes?: string }) {
    const run = await this.prisma.agentRun.findFirst({ where: { id, userId } });
    if (!run) throw new NotFoundException('Agent not found');
    return this.prisma.agentRun.update({ where: { id }, data });
  }

  async deleteRun(userId: string, id: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id, userId } });
    if (!run) throw new NotFoundException('Agent not found');
    await this.prisma.$transaction([
      this.prisma.agentAction.deleteMany({ where: { runId: id } }),
      this.prisma.agentRun.delete({ where: { id } }),
    ]);
    return { deleted: true, id };
  }

  async stopRun(userId: string, id: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id, userId } });
    if (!run) throw new NotFoundException('Agent not found');
    if (run.status !== AgentRunStatus.ACTIVE && run.status !== AgentRunStatus.PAUSED) {
      throw new BadRequestException(`Cannot stop an agent with status ${run.status}`);
    }

    return this.prisma.agentRun.update({
      where: { id },
      data:  { status: AgentRunStatus.STOPPED, stoppedAt: new Date() },
    });
  }

  async pauseRun(userId: string, id: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id, userId } });
    if (!run) throw new NotFoundException('Agent not found');
    if (run.status !== AgentRunStatus.ACTIVE) {
      throw new BadRequestException('Can only pause an ACTIVE agent');
    }
    return this.prisma.agentRun.update({
      where: { id },
      data:  { status: AgentRunStatus.PAUSED },
    });
  }

  async resumeRun(userId: string, id: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id, userId } });
    if (!run) throw new NotFoundException('Agent not found');
    if (run.status !== AgentRunStatus.PAUSED) {
      throw new BadRequestException('Can only resume a PAUSED agent');
    }
    return this.prisma.agentRun.update({
      where: { id },
      data:  { status: AgentRunStatus.ACTIVE },
    });
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async logActionBatch(runId: string, actions: Omit<LogActionDto, 'runId'>[]) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Agent not found');
    if (!actions.length) return { logged: 0 };

    await this.prisma.agentAction.createMany({
      data: actions.map((a) => ({
        runId,
        actionType:      a.actionType,
        ...(a.timestamp ? { timestamp: a.timestamp } : {}),
        instrument:      a.instrument,
        quantity:        a.quantity,
        price:           a.price,
        orderId:         a.orderId,
        btcPrice:        a.btcPrice,
        delta:           a.delta,
        ivRank:          a.ivRank,
        executedPrice:   a.executedPrice,
        pnlBtc:           a.pnlBtc,
        marginBalanceBtc: a.marginBalanceBtc,
        reason:           a.reason,
      })),
    });

    const totalPnl = actions.reduce((s, a) => s + (Number(a.pnlBtc) || 0), 0);
    await this.prisma.agentRun.update({
      where: { id: runId },
      data: {
        totalActions:    { increment: actions.length },
        realizedPnlBtc:  { increment: totalPnl },
      },
    });

    return { logged: actions.length };
  }

  async logAction(dto: LogActionDto) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: dto.runId } });
    if (!run) throw new NotFoundException('Agent not found');

    const action = await this.prisma.agentAction.create({
      data: {
        runId:           dto.runId,
        actionType:      dto.actionType,
        ...(dto.timestamp ? { timestamp: dto.timestamp } : {}),
        instrument:      dto.instrument,
        quantity:        dto.quantity,
        price:           dto.price,
        orderId:         dto.orderId,
        btcPrice:        dto.btcPrice,
        delta:           dto.delta,
        ivRank:          dto.ivRank,
        executedPrice:   dto.executedPrice,
        pnlBtc:           dto.pnlBtc,
        marginBalanceBtc: dto.marginBalanceBtc,
        reason:           dto.reason,
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
    if (!run) throw new NotFoundException('Agent not found');

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

  // ---------------------------------------------------------------------------
  // Execute
  // ---------------------------------------------------------------------------

  /** Queue the model execution for an agent — returns immediately. */
  async executeRun(
    userId: string,
    id: string,
    dataFrom?: string,
    dataTo?: string,
    envOverrides?: Record<string, any>,
  ) {
    const run = await this.prisma.agentRun.findFirst({ where: { id, userId } });
    if (!run) throw new NotFoundException('Agent not found');

    // BACKTEST agents can always be re-executed (processor resets state)
    const canRerun = run.runType === AgentRunType.BACKTEST;
    if (!canRerun && run.status !== AgentRunStatus.ACTIVE) {
      throw new BadRequestException(`Agent is not active (status: ${run.status})`);
    }
    if (!run.sessionId) {
      throw new BadRequestException('Agent has no linked training session — set sessionId when creating the agent');
    }

    const job = await this.agentRunQueue.add(
      'execute',
      { runId: id, dataFrom, dataTo, envOverrides },
      { attempts: 2, backoff: { type: 'fixed', delay: 5_000 }, removeOnComplete: false, removeOnFail: false },
    );

    return { queued: true, runId: id, jobId: String(job.id) };
  }
}
