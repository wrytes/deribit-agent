import { Module } from '@nestjs/common';
import { DeribitAccountService } from './deribit-account.service';
import { DeribitAccountController } from './deribit-account.controller';
import { DeribitModule } from '../../integrations/deribit/deribit.module';

@Module({
  imports: [DeribitModule],
  providers: [DeribitAccountService],
  controllers: [DeribitAccountController],
})
export class DeribitAccountModule {}
