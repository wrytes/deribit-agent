import { Module } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { DeribitModule } from '../../integrations/deribit/deribit.module';

@Module({
  imports: [DeribitModule],
  providers: [WalletService],
  controllers: [WalletController],
})
export class WalletModule {}
