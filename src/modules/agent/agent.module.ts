import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AgentService, AGENT_RUN_QUEUE } from './agent.service';
import { AgentController } from './agent.controller';
import { AgentRunProcessor } from './agent.processor';
import { DatabaseModule } from '../../core/database/database.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    BullModule.registerQueue({ name: AGENT_RUN_QUEUE }),
  ],
  providers: [AgentService, AgentRunProcessor],
  controllers: [AgentController],
  exports: [AgentService],
})
export class AgentModule {}
