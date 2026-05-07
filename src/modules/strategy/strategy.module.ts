import { Module } from '@nestjs/common';
import { StrategyService } from './strategy.service';
import { StrategyExecutionService } from './strategy-execution.service';
import { DatabaseModule } from '../../core/database/database.module';
import { DeribitModule } from '../../integrations/deribit/deribit.module';
import { MarketDataModule } from '../market-data/market-data.module';

@Module({
  imports: [DatabaseModule, DeribitModule, MarketDataModule],
  providers: [StrategyService, StrategyExecutionService],
  exports: [StrategyService, StrategyExecutionService],
})
export class StrategyModule {}
