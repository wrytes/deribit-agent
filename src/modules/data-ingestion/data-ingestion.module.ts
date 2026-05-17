import { Module } from '@nestjs/common';
import { DataIngestionService } from './data-ingestion.service';
import { DataIngestionController } from './data-ingestion.controller';
import { DatabaseModule } from '../../core/database/database.module';

@Module({
  imports: [DatabaseModule],
  providers: [DataIngestionService],
  controllers: [DataIngestionController],
  exports: [DataIngestionService],
})
export class DataIngestionModule {}
