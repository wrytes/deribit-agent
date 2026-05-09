import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

@Processor(AGENT_RUN_QUEUE)
export class AgentRunProcessor extends WorkerHost {
  private readonly logger = new Logger(AgentRunProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<AgentRunJobData>): Promise<void> {
    const { runId, dataFrom, dataTo, envOverrides } = job.data;
    this.logger.log(`Executing agent run ${runId} (job ${job.id})`);

    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) {
      this.logger.warn(`Agent ${runId} not found — skipping`);
      return;
    }
    if (!run.sessionId) {
      this.logger.warn(`Agent ${runId} has no sessionId — skipping`);
      return;
    }

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
      const response = await fetch(`${trainerUrl}/run`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          run_id:     runId,
          session_id: run.sessionId,
          ...(dataFrom     ? { data_from:     dataFrom     } : {}),
          ...(dataTo       ? { data_to:       dataTo       } : {}),
          ...(envOverrides ? { env_overrides: envOverrides } : {}),
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

      this.logger.log(`Agent ${runId} completed`);
    } catch (err) {
      this.logger.error(`Agent ${runId} failed: ${(err as Error).message}`);
      await this.prisma.agentRun.update({
        where: { id: runId },
        data:  { status: AgentRunStatus.ERROR, stoppedAt: new Date() },
      }).catch(() => null);
      throw err;
    }
  }
}
