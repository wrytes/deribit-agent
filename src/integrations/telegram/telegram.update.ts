import { Injectable, Logger } from '@nestjs/common';
import { Update, Start, Command, On, Ctx, InjectBot } from 'nestjs-telegraf';
import { Context, Telegraf } from 'telegraf';
import { AuthService } from '../../modules/auth/auth.service';
import { PrismaService } from '../../core/database/prisma.service';
import { DeribitClientService } from '../deribit/deribit.client.service';
import { AiService } from '../ai/ai.service';
import type { TelegramContext } from './session.types';
import { ApiKeyScope } from '@prisma/client';
import { Currency } from '@wrytlabs/deribit-api-client';

function s(ctx: Context): TelegramContext {
  return ctx as unknown as TelegramContext;
}

const CURRENCIES: Currency[] = [Currency.BTC, Currency.ETH, Currency.USDC];

@Update()
@Injectable()
export class TelegramUpdate {
  private readonly logger = new Logger(TelegramUpdate.name);

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    private readonly authService: AuthService,
    private readonly prisma: PrismaService,
    private readonly deribitClientService: DeribitClientService,
    private readonly aiService: AiService,
  ) {}

  // ---------------------------------------------------------------------------
  // Core commands
  // ---------------------------------------------------------------------------

  @Start()
  async onStart(@Ctx() ctx: Context) {
    const from = s(ctx).from;
    if (!from) return;

    const { isNew } = await this.authService.getOrCreateUser(
      BigInt(from.id),
      from.username,
    );

    const text = isNew
      ? 'Welcome to Deribit Bot! 🚀\n\n'
      : 'Welcome back! 👋\n\n';

    await ctx.reply(
      text +
        '/connect — link Deribit credentials\n' +
        '/portfolio — AI portfolio summary\n' +
        '/balance — quick balance overview\n' +
        '/positions — open positions\n' +
        '/orders — open orders\n' +
        '/ask <question> — AI trading assistant\n' +
        '/api_create — generate API key\n' +
        '/status — bot status',
    );
  }

  @Command('status')
  async onStatus(@Ctx() ctx: Context) {
    await ctx.reply('✅ Deribit Bot is running');
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
      `🔑 Your magic link token:\n\n\`${token}\`\n\n` +
        `Visit: /auth/verify?token=${token}\n\n` +
        `Expires: ${expiresAt.toISOString()} (15 min)`,
      { parse_mode: 'Markdown' },
    );
  }

  // ---------------------------------------------------------------------------
  // Deribit credential setup
  // ---------------------------------------------------------------------------

  @Command('connect')
  async onConnect(@Ctx() ctx: Context) {
    s(ctx).session.pendingAction = { type: 'connect_deribit', step: 'client_id' };
    await ctx.reply('Please send your Deribit Client ID:');
  }

  // ---------------------------------------------------------------------------
  // Portfolio & account commands
  // ---------------------------------------------------------------------------

  @Command('portfolio')
  async onPortfolio(@Ctx() ctx: Context) {
    const from = s(ctx).from;
    if (!from) return;

    const userId = await this.resolveUserId(BigInt(from.id), from.username);
    if (!userId) { await ctx.reply('Use /connect first to link your Deribit account.'); return; }

    await ctx.reply('📊 Fetching your portfolio...');

    try {
      const client = await this.deribitClientService.getClient(userId);

      // Fetch summaries for each currency in parallel
      const summaries = await Promise.allSettled(
        CURRENCIES.map((c) => client.account.getAccountSummary({ currency: c })),
      );

      const accountData = summaries
        .filter((r) => r.status === 'fulfilled' && 'result' in r.value)
        .map((r) => {
          const result = (r as PromiseFulfilledResult<any>).value.result;
          return {
            currency: result.currency,
            equity: result.equity,
            balance: result.balance,
            margin_balance: result.margin_balance,
            available_funds: result.available_funds,
            initial_margin: result.initial_margin,
            maintenance_margin: result.maintenance_margin,
            delta_total: result.delta_total,
          };
        })
        .filter((d) => d.equity > 0 || d.balance > 0);

      // Count open orders
      const ordersRes = await client.trading.getOpenOrdersByCurrency({ currency: 'BTC' });
      const openOrdersCount = 'result' in ordersRes ? ordersRes.result.length : 0;

      const summary = await this.aiService.summarizePortfolio({
        summaries: accountData,
        openOrdersCount,
      });

      await ctx.reply(summary);
    } catch (err) {
      this.logger.error(`Portfolio error: ${err.message}`);
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  }

  @Command('balance')
  async onBalance(@Ctx() ctx: Context) {
    const from = s(ctx).from;
    if (!from) return;

    const userId = await this.resolveUserId(BigInt(from.id), from.username);
    if (!userId) { await ctx.reply('Use /connect first to link your Deribit account.'); return; }

    try {
      const client = await this.deribitClientService.getClient(userId);

      const results = await Promise.allSettled(
        CURRENCIES.map((c) => client.account.getAccountSummary({ currency: c })),
      );

      const lines: string[] = ['💰 *Balances*\n'];
      for (const res of results) {
        if (res.status === 'fulfilled' && 'result' in res.value) {
          const r = res.value.result;
          if (r.equity > 0 || r.balance > 0) {
            lines.push(
              `*${r.currency}*\n` +
              `  Equity: \`${r.equity}\`\n` +
              `  Available: \`${r.available_funds}\`\n` +
              `  Margin used: \`${r.initial_margin}\``,
            );
          }
        }
      }

      if (lines.length === 1) lines.push('No balances found.');
      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  }

  @Command('positions')
  async onPositions(@Ctx() ctx: Context) {
    const from = s(ctx).from;
    if (!from) return;

    const userId = await this.resolveUserId(BigInt(from.id), from.username);
    if (!userId) { await ctx.reply('Use /connect first to link your Deribit account.'); return; }

    try {
      const client = await this.deribitClientService.getClient(userId);

      // get_position requires instrument_name; fetch account summaries to find active currencies
      // instead use getAccountSummaries to know which currencies have equity
      const summariesRes = await client.account.getAccountSummaries({});
      if (!('result' in summariesRes)) { await ctx.reply('Unable to fetch positions.'); return; }

      const activeCurrencies = summariesRes.result.summaries
        .filter((s: any) => s.delta_total !== 0 || s.initial_margin > 0)
        .map((s: any) => s.currency as string);

      if (activeCurrencies.length === 0) {
        await ctx.reply('📭 No open positions.');
        return;
      }

      const lines: string[] = ['📈 *Open Positions*\n'];
      for (const currency of activeCurrencies) {
        const s = summariesRes.result.summaries.find((x: any) => x.currency === currency);
        if (s) {
          lines.push(
            `*${currency}*\n` +
            `  Delta: \`${s.delta_total ?? 0}\`\n` +
            `  Init margin: \`${s.initial_margin}\`\n` +
            `  Maint margin: \`${s.maintenance_margin}\``,
          );
        }
      }

      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  }

  @Command('orders')
  async onOrders(@Ctx() ctx: Context) {
    const from = s(ctx).from;
    if (!from) return;

    const userId = await this.resolveUserId(BigInt(from.id), from.username);
    if (!userId) { await ctx.reply('Use /connect first to link your Deribit account.'); return; }

    try {
      const client = await this.deribitClientService.getClient(userId);

      const results = await Promise.allSettled(
        CURRENCIES.map((c) =>
          client.trading.getOpenOrdersByCurrency({ currency: c }),
        ),
      );

      const allOrders: any[] = [];
      for (const res of results) {
        if (res.status === 'fulfilled' && 'result' in res.value) {
          allOrders.push(...res.value.result);
        }
      }

      if (allOrders.length === 0) {
        await ctx.reply('📭 No open orders.');
        return;
      }

      const lines: string[] = [`📋 *Open Orders* (${allOrders.length})\n`];
      for (const o of allOrders.slice(0, 10)) {
        lines.push(
          `*${o.direction.toUpperCase()}* ${o.instrument_name}\n` +
          `  Amount: \`${o.amount}\` | Price: \`${o.price}\`\n` +
          `  ID: \`${o.order_id}\` | State: ${o.order_state}`,
        );
      }
      if (allOrders.length > 10) lines.push(`_...and ${allOrders.length - 10} more_`);

      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // AI assistant
  // ---------------------------------------------------------------------------

  @Command('ask')
  async onAsk(@Ctx() ctx: Context) {
    const tc = s(ctx);
    const message = tc.message;
    if (!message || !('text' in message)) return;

    // Strip the /ask command prefix
    const question = (message as any).text.replace(/^\/ask\s*/i, '').trim();
    if (!question) {
      await ctx.reply('Usage: /ask <your question>\nExample: /ask What is delta in options?');
      return;
    }

    if (!tc.session.askHistory) tc.session.askHistory = [];
    tc.session.askHistory.push({ role: 'user', content: question });
    if (tc.session.askHistory.length > 20) {
      tc.session.askHistory = tc.session.askHistory.slice(-20);
    }

    await ctx.reply('🤔 Thinking...');
    const response = await this.aiService.ask(tc.session.askHistory);
    tc.session.askHistory.push({ role: 'assistant', content: response });

    await ctx.reply(response);
  }

  // ---------------------------------------------------------------------------
  // Text handler — /connect wizard + NL passthrough
  // ---------------------------------------------------------------------------

  @On('text')
  async onText(@Ctx() ctx: Context) {
    const tc = s(ctx);
    const from = tc.from;
    const message = tc.message;
    if (!from || !message || !('text' in message)) return;

    const text = (message as any).text.trim() as string;

    // Don't process bot commands here (they're handled by @Command decorators)
    if (text.startsWith('/')) return;

    // Handle /connect wizard steps
    const session = tc.session;
    if (session?.pendingAction?.type === 'connect_deribit') {
      await this.handleConnectWizard(ctx, tc, from, text);
      return;
    }

    // Natural language passthrough — only if user has a Deribit account
    const userId = await this.resolveUserId(BigInt(from.id), from.username);
    if (!userId) return;

    const account = await this.prisma.deribitAccount.findUnique({ where: { userId } });
    if (!account) return;

    // Parse intent with AI and dispatch
    const parsed = await this.aiService.parseTradingCommand(text);
    await this.dispatchNlCommand(ctx, userId, parsed);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async handleConnectWizard(
    ctx: Context,
    tc: TelegramContext,
    from: NonNullable<typeof tc.from>,
    text: string,
  ) {
    const step = tc.session.pendingAction?.step;

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
      const clientId = tc.session.pendingAction?.data?.clientId as string;
      const { id: userId } = await this.authService.getOrCreateUser(
        BigInt(from.id),
        from.username,
      );

      await this.prisma.deribitAccount.upsert({
        where: { userId },
        create: { userId, clientId, clientSecret: text },
        update: { clientId, clientSecret: text },
      });

      this.deribitClientService.evictClient(userId);
      tc.session.pendingAction = undefined;
      await ctx.reply('✅ Connected! Your Deribit credentials are saved.\n\nTry /portfolio or /balance.');
      this.logger.log(`User ${userId} saved Deribit credentials via Telegram`);
    }
  }

  private async dispatchNlCommand(
    ctx: Context,
    userId: string,
    parsed: { action: string; params: Record<string, any> },
  ) {
    switch (parsed.action) {
      case 'portfolio_summary':
        await this.onPortfolio(ctx);
        break;
      case 'open_positions':
        await this.onPositions(ctx);
        break;
      case 'open_orders':
        await this.onOrders(ctx);
        break;
      case 'place_order':
        await ctx.reply(
          `To place orders please use the REST API.\n` +
            `POST /trading/${parsed.params.side} with instrument_name, amount, and type.`,
        );
        break;
      case 'cancel_order':
        await ctx.reply(
          `To cancel an order: DELETE /trading/orders/${parsed.params.order_id ?? '<orderId>'}`,
        );
        break;
      case 'ask_question': {
        const tc = s(ctx);
        if (!tc.session.askHistory) tc.session.askHistory = [];
        const q = parsed.params.question as string;
        tc.session.askHistory.push({ role: 'user', content: q });
        await ctx.reply('🤔 Thinking...');
        const answer = await this.aiService.ask(tc.session.askHistory);
        tc.session.askHistory.push({ role: 'assistant', content: answer });
        await ctx.reply(answer);
        break;
      }
      default:
        await ctx.reply(
          'I didn\'t understand that. Try:\n' +
            '/portfolio — portfolio summary\n' +
            '/balance — quick balances\n' +
            '/positions — open positions\n' +
            '/orders — open orders\n' +
            '/ask <question> — AI assistant',
        );
    }
  }

  private async resolveUserId(
    telegramId: bigint,
    username?: string,
  ): Promise<string | null> {
    const user = await this.authService.findUserByTelegramId(telegramId);
    if (user) return user.id;
    // Create user on first interaction
    const { id } = await this.authService.getOrCreateUser(telegramId, username);
    return id;
  }
}
