import { Module } from '@nestjs/common';
import { AccountService } from './account.service';
import { AccountController } from './account.controller';
import { DeribitModule } from '../../integrations/deribit/deribit.module';

@Module({
  imports: [DeribitModule],
  providers: [AccountService],
  controllers: [AccountController],
})
export class AccountModule {}
