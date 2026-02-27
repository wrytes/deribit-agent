import { Module } from '@nestjs/common';
import { TradingService } from './trading.service';
import { TradingController } from './trading.controller';
import { DeribitModule } from '../../integrations/deribit/deribit.module';

@Module({
  imports: [DeribitModule],
  providers: [TradingService],
  controllers: [TradingController],
})
export class TradingModule {}
