import { Module } from '@nestjs/common';
import { StrategyService } from './strategy.service';
import { DatabaseModule } from '../../core/database/database.module';

@Module({
  imports: [DatabaseModule],
  providers: [StrategyService],
  exports: [StrategyService],
})
export class StrategyModule {}
