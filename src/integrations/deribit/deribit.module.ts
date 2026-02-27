import { Module } from '@nestjs/common';
import { DeribitClientService } from './deribit.client.service';

@Module({
  providers: [DeribitClientService],
  exports: [DeribitClientService],
})
export class DeribitModule {}
