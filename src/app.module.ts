import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';

// Config
import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import redisConfig from './config/redis.config';
import telegramConfig from './config/telegram.config';
import deribitConfig from './config/deribit.config';
import { validationSchema } from './config/validation.schema';

// Core modules
import { DatabaseModule } from './core/database/database.module';
import { HealthModule } from './core/health/health.module';

// Integration modules
import { TelegramModule } from './integrations/telegram/telegram.module';
import { DeribitModule } from './integrations/deribit/deribit.module';

// Feature modules
import { AuthModule } from './modules/auth/auth.module';
import { DeribitAccountModule } from './modules/deribit-account/deribit-account.module';
import { AccountModule } from './modules/account/account.module';
import { TradingModule } from './modules/trading/trading.module';
import { MarketDataModule } from './modules/market-data/market-data.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import { DataIngestionModule } from './modules/data-ingestion/data-ingestion.module';
import { TrainingModule } from './modules/training/training.module';
import { AgentModule } from './modules/agent/agent.module';

// Common modules
import { EventsModule } from './common/events/events.module';

// App
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, redisConfig, telegramConfig, deribitConfig],
      validationSchema,
      validationOptions: {
        allowUnknown: true,
        abortEarly: false,
      },
    }),

    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV === 'development'
            ? {
                target: 'pino-pretty',
                options: {
                  colorize: true,
                  translateTime: 'SYS:standard',
                  ignore: 'pid,hostname',
                },
              }
            : undefined,
        level: process.env.LOG_LEVEL || 'info',
      },
    }),

    ThrottlerModule.forRoot([
      {
        ttl: parseInt(process.env.THROTTLE_TTL || '60', 10) * 1000,
        limit: parseInt(process.env.THROTTLE_LIMIT || '100', 10),
      },
    ]),

    ScheduleModule.forRoot(),

    EventEmitterModule.forRoot({
      wildcard: false,
      delimiter: '.',
      maxListeners: 10,
      verboseMemoryLeak: true,
    }),

    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('redis.host') || 'localhost',
          port: configService.get<number>('redis.port') || 6379,
          password: configService.get<string>('redis.password') || undefined,
        },
      }),
      inject: [ConfigService],
    }),

    DatabaseModule,
    HealthModule,
    TelegramModule,
    DeribitModule,
    AuthModule,
    DeribitAccountModule,
    AccountModule,
    TradingModule,
    MarketDataModule,
    SchedulerModule,
    DataIngestionModule,
    TrainingModule,
    AgentModule,
    EventsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
