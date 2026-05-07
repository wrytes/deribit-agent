import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../core/database/prisma.service';
import { AgentRunStatus, AgentRunType } from '@prisma/client';

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
  reason?: string;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Agent runs
  // ---------------------------------------------------------------------------

  async createRun(dto: CreateRunDto) {
    if (dto.runType === AgentRunType.LIVE && !dto.deribitAccountId) {
      throw new BadRequestException('deribitAccountId is required for LIVE runs');
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
      this.executeRun(dto.userId, run.id).catch((err: Error) => {
        this.logger.error(`Backtest auto-dispatch failed for run ${run.id}: ${err.message}`);
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

  async logActionBatch(runId: string, actions: Omit<LogActionDto, 'runId'>[]) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Agent run not found');
    if (!actions.length) return { logged: 0 };

    await this.prisma.agentAction.createMany({
      data: actions.map((a) => ({
        runId,
        actionType:    a.actionType,
        ...(a.timestamp ? { timestamp: a.timestamp } : {}),
        instrument:    a.instrument,
        quantity:      a.quantity,
        price:         a.price,
        orderId:       a.orderId,
        btcPrice:      a.btcPrice,
        delta:         a.delta,
        ivRank:        a.ivRank,
        executedPrice: a.executedPrice,
        pnlBtc:        a.pnlBtc,
        reason:        a.reason,
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
    if (!run) throw new NotFoundException('Agent run not found');

    const action = await this.prisma.agentAction.create({
      data: {
        runId:         dto.runId,
        actionType:    dto.actionType,
        ...(dto.timestamp ? { timestamp: dto.timestamp } : {}),
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

  // ---------------------------------------------------------------------------
  // Execute
  // ---------------------------------------------------------------------------

  /** Trigger the Python sidecar to run the model linked to this agent run. */
  async executeRun(
    userId: string,
    id: string,
    dataFrom?: string,
    dataTo?: string,
    envOverrides?: Record<string, any>,
  ) {
    const run = await this.prisma.agentRun.findFirst({
      where: { id, userId },
    });
    if (!run) throw new NotFoundException('Agent run not found');
    if (run.status !== AgentRunStatus.ACTIVE) {
      throw new BadRequestException(`Run is not active (status: ${run.status})`);
    }
    if (!run.sessionId) {
      throw new BadRequestException('Run has no linked training session — set sessionId when creating the run');
    }

    await this.prisma.$transaction([
      this.prisma.agentAction.deleteMany({ where: { runId: id } }),
      this.prisma.agentRun.update({
        where: { id },
        data:  { currentCapitalBtc: run.initialCapitalBtc },
      }),
    ]);

    const trainerUrl = this.config.get<string>('TRAINER_URL') ?? 'http://localhost:8000';

    const response = await fetch(`${trainerUrl}/run`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        run_id:     id,
        session_id: run.sessionId,
        ...(dataFrom      ? { data_from:      dataFrom      } : {}),
        ...(dataTo        ? { data_to:        dataTo        } : {}),
        ...(envOverrides  ? { env_overrides:  envOverrides  } : {}),
      }),
      signal: AbortSignal.timeout(3_600_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'no body');
      throw new BadRequestException(`Trainer responded ${response.status}: ${text}`);
    }

    return response.json();
  }
}
