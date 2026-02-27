import { Module } from '@nestjs/common';
import { NotificationListener } from '../listeners/notification.listener';
import { TelegramModule } from '../../integrations/telegram/telegram.module';

@Module({
  imports: [TelegramModule],
  providers: [NotificationListener],
})
export class EventsModule {}
