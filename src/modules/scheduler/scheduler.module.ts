import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SchedulerService } from './scheduler.service';
import { DatabaseModule } from '../../core/database/database.module';
import { DeribitModule } from '../../integrations/deribit/deribit.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { TelegramModule } from '../../integrations/telegram/telegram.module';
import { DataIngestionModule } from '../data-ingestion/data-ingestion.module';
import { AGENT_RUN_QUEUE } from '../agent/agent.service';

@Module({
  imports: [
    DatabaseModule,
    DeribitModule,
    MarketDataModule,
    TelegramModule,
    DataIngestionModule,
    BullModule.registerQueue({ name: AGENT_RUN_QUEUE }),
  ],
  providers: [SchedulerService],
})
export class SchedulerModule {}
