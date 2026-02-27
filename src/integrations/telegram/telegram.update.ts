import { Injectable, Logger } from '@nestjs/common';
import { Update, Start, Command, On, Ctx, InjectBot } from 'nestjs-telegraf';
import { Context, Telegraf } from 'telegraf';
import { AuthService } from '../../modules/auth/auth.service';
import { PrismaService } from '../../core/database/prisma.service';
import type { TelegramContext } from './session.types';
import { ApiKeyScope } from '@prisma/client';

function s(ctx: Context): TelegramContext {
  return ctx as unknown as TelegramContext;
}

@Update()
@Injectable()
export class TelegramUpdate {
  private readonly logger = new Logger(TelegramUpdate.name);

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    private readonly authService: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Start()
  async onStart(@Ctx() ctx: Context) {
    const from = s(ctx).from;
    if (!from) return;

    const { isNew } = await this.authService.getOrCreateUser(
      BigInt(from.id),
      from.username,
    );

    if (isNew) {
      await ctx.reply(
        'Welcome to Deribit Bot! 🚀\n\n' +
          'Use /api_create to generate an API key.\n' +
          'Use /connect to link your Deribit credentials.\n' +
          'Use /status to check bot status.',
      );
    } else {
      await ctx.reply(
        'Welcome back! 👋\n\n' +
          'Use /api_create to generate an API key.\n' +
          'Use /connect to update your Deribit credentials.\n' +
          'Use /status to check bot status.',
      );
    }
  }

  @Command('api_create')
  async onApiCreate(@Ctx() ctx: Context) {
    const from = s(ctx).from;
    if (!from) return;

    const { id: userId } = await this.authService.getOrCreateUser(
      BigInt(from.id),
      from.username,
    );

    const { token, expiresAt } = await this.authService.createMagicLink(userId, [
      ApiKeyScope.ACCOUNT_READ,
      ApiKeyScope.MARKET_READ,
      ApiKeyScope.TRADING_READ,
      ApiKeyScope.TRADING_WRITE,
    ]);

    await ctx.reply(
      `🔑 Your magic link token:\n\n` +
        `\`${token}\`\n\n` +
        `Visit: /auth/verify?token=${token}\n\n` +
        `Expires: ${expiresAt.toISOString()} (15 minutes)`,
      { parse_mode: 'Markdown' },
    );
  }

  @Command('status')
  async onStatus(@Ctx() ctx: Context) {
    await ctx.reply('✅ Deribit Bot is running');
  }

  @Command('connect')
  async onConnect(@Ctx() ctx: Context) {
    s(ctx).session.pendingAction = {
      type: 'connect_deribit',
      step: 'client_id',
    };
    await ctx.reply('Please send your Deribit Client ID:');
  }

  @On('text')
  async onText(@Ctx() ctx: Context) {
    const tc = s(ctx);
    const from = tc.from;
    const message = tc.message;
    if (!from || !message || !('text' in message)) return;

    const session = tc.session;
    if (!session?.pendingAction) return;

    const { type, step } = session.pendingAction;
    if (type !== 'connect_deribit') return;

    const text = (message as any).text.trim();

    if (step === 'client_id') {
      tc.session.pendingAction = {
        type: 'connect_deribit',
        step: 'client_secret',
        data: { clientId: text },
      };
      await ctx.reply('Please send your Deribit Client Secret:');
      return;
    }

    if (step === 'client_secret') {
      const clientId = session.pendingAction.data?.clientId as string;

      const { id: userId } = await this.authService.getOrCreateUser(
        BigInt(from.id),
        from.username,
      );

      await this.prisma.deribitAccount.upsert({
        where: { userId },
        create: { userId, clientId, clientSecret: text },
        update: { clientId, clientSecret: text },
      });

      tc.session.pendingAction = undefined;
      await ctx.reply('✅ Connected! Your Deribit credentials are saved.');
      this.logger.log(`User ${userId} connected Deribit account via Telegram`);
    }
  }
}
