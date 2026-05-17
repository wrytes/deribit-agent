import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { AgentRunStatus } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { AGENT_RUN_QUEUE } from './agent.service';

export interface AgentRunJobData {
  runId: string;
  dataFrom?: string;
  dataTo?: string;
  envOverrides?: Record<string, unknown>;
}

/**
 * BullMQ worker — resets a BACKTEST run's state so the trainer polling loop
 * finds it (ACTIVE, totalActions=0) and re-runs it from scratch.
 * The trainer writes actions and sets status COMPLETED/ERROR directly in the DB.
 */
@Processor(AGENT_RUN_QUEUE)
export class AgentRunProcessor extends WorkerHost {
  private readonly logger = new Logger(AgentRunProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<AgentRunJobData>): Promise<void> {
    const { runId } = job.data;
    this.logger.log(`Resetting backtest run ${runId} for trainer pickup`);

    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) { this.logger.warn(`Agent ${runId} not found — skipping`); return; }
    if (!run.sessionId) { this.logger.warn(`Agent ${runId} has no sessionId — skipping`); return; }

    await this.prisma.$transaction([
      this.prisma.agentAction.deleteMany({ where: { runId } }),
      this.prisma.agentRun.update({
        where: { id: runId },
        data: {
          currentCapitalBtc: run.initialCapitalBtc,
          realizedPnlBtc:    0,
          totalActions:      0,
          status:            AgentRunStatus.ACTIVE,
        },
      }),
    ]);

    this.logger.log(`Backtest ${runId} reset — trainer will pick it up`);
  }
}
