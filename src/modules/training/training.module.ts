import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TrainingService, TRAINING_QUEUE } from './training.service';
import { TrainingController } from './training.controller';
import { TrainingProcessor } from './training.processor';
import { DatabaseModule } from '../../core/database/database.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    BullModule.registerQueue({ name: TRAINING_QUEUE }),
  ],
  providers: [TrainingService, TrainingProcessor],
  controllers: [TrainingController],
  exports: [TrainingService],
})
export class TrainingModule {}
