import { Module } from '@nestjs/common';
import { DataIngestionService } from './data-ingestion.service';
import { DataIngestionController } from './data-ingestion.controller';
import { DatabaseModule } from '../../core/database/database.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [DatabaseModule, AuthModule],
  providers: [DataIngestionService],
  controllers: [DataIngestionController],
  exports: [DataIngestionService],
})
export class DataIngestionModule {}
