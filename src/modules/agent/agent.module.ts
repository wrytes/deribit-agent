import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AgentService, AGENT_RUN_QUEUE } from './agent.service';
import { AgentController } from './agent.controller';
import { AgentRunProcessor } from './agent.processor';
import { LiveExecutionService } from './live-execution.service';
import { DatabaseModule } from '../../core/database/database.module';
import { AuthModule } from '../auth/auth.module';
import { DeribitModule } from '../../integrations/deribit/deribit.module';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    DeribitModule,
    BullModule.registerQueue({ name: AGENT_RUN_QUEUE }),
  ],
  providers: [AgentService, AgentRunProcessor, LiveExecutionService],
  controllers: [AgentController],
  exports: [AgentService, LiveExecutionService],
})
export class AgentModule {}
