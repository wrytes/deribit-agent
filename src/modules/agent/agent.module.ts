import { Module } from '@nestjs/common';
import { AgentService } from './agent.service';
import { AgentController } from './agent.controller';
import { DatabaseModule } from '../../core/database/database.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [DatabaseModule, AuthModule],
  providers: [AgentService],
  controllers: [AgentController],
  exports: [AgentService],
})
export class AgentModule {}
