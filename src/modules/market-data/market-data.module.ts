import { Module } from '@nestjs/common';
import { MarketDataService } from './market-data.service';
import { DatabaseModule } from '../../core/database/database.module';

@Module({
  imports: [DatabaseModule],
  providers: [MarketDataService],
  exports: [MarketDataService],
})
export class MarketDataModule {}
