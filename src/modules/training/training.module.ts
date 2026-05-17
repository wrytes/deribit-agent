import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TrainingService, TRAINING_QUEUE } from './training.service';
import { TrainingController } from './training.controller';
import { TrainingProcessor } from './training.processor';
import { DatabaseModule } from '../../core/database/database.module';
import { AGENT_RUN_QUEUE } from '../agent/agent.service';

@Module({
  imports: [
    DatabaseModule,
    BullModule.registerQueue({ name: TRAINING_QUEUE }),
    BullModule.registerQueue({ name: AGENT_RUN_QUEUE }),
  ],
  providers: [TrainingService, TrainingProcessor],
  controllers: [TrainingController],
  exports: [TrainingService],
})
export class TrainingModule {}
