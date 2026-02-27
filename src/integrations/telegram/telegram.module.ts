import { Module } from '@nestjs/common';
import { TelegrafModule } from 'nestjs-telegraf';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegramService } from './telegram.service';
import { TelegramUpdate } from './telegram.update';
import { TelegramController } from './telegram.controller';
import { AuthModule } from '../../modules/auth/auth.module';
import { session } from 'telegraf';
import { Redis } from 'ioredis';

function createIoRedisStore<T>(client: Redis, ttlSeconds: number) {
  return {
    async get(key: string): Promise<T | undefined> {
      const data = await client.get(key);
      return data ? (JSON.parse(data) as T) : undefined;
    },
    async set(key: string, value: T): Promise<void> {
      await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    },
    async delete(key: string): Promise<void> {
      await client.del(key);
    },
  };
}

@Module({
  imports: [
    TelegrafModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const botToken = configService.get<string>('telegram.botToken');
        const webhookDomain = configService.get<string>('telegram.webhookDomain');

        if (!botToken) {
          return { token: 'disabled', launchOptions: false };
        }

        const redisHost = configService.get<string>('redis.host') || 'localhost';
        const redisPort = configService.get<number>('redis.port') || 6379;
        const redisPassword = configService.get<string>('redis.password');

        const redisClient = new Redis({
          host: redisHost,
          port: redisPort,
          password: redisPassword || undefined,
        });

        redisClient.on('error', (err) => {
          console.warn('Telegram session Redis error:', err.message);
        });

        const store = createIoRedisStore(redisClient, 15 * 60);
        const sessionMiddleware = session({ store, defaultSession: () => ({}) });

        const config: any = {
          token: botToken,
          middlewares: [sessionMiddleware],
        };

        if (webhookDomain && configService.get('app.isProduction')) {
          config.launchOptions = false;
        } else {
          config.launchOptions = { dropPendingUpdates: true };
        }

        return config;
      },
      inject: [ConfigService],
    }),
    AuthModule,
  ],
  controllers: [TelegramController],
  providers: [TelegramService, TelegramUpdate],
  exports: [TelegramService],
})
export class TelegramModule {}
