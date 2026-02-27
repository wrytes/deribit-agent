import { Module } from '@nestjs/common';
import { MarketService } from './market.service';
import { MarketController } from './market.controller';
import { DeribitModule } from '../../integrations/deribit/deribit.module';

@Module({
  imports: [DeribitModule],
  providers: [MarketService],
  controllers: [MarketController],
})
export class MarketModule {}
