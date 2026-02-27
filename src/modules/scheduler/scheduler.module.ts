import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { DatabaseModule } from '../../core/database/database.module';
import { DeribitModule } from '../../integrations/deribit/deribit.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { TelegramModule } from '../../integrations/telegram/telegram.module';

@Module({
  imports: [DatabaseModule, DeribitModule, MarketDataModule, TelegramModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
