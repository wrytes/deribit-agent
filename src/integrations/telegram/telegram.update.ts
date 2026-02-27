import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
export class TelegramUpdate implements OnModuleInit {
  private readonly logger = new Logger(TelegramUpdate.name);

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    private readonly authService: AuthService,
    private readonly prisma: PrismaService,
    private readonly deribitClientService: DeribitClientService,
    private readonly aiService: AiService,
  ) {}

  async onModuleInit() {
    try {
      await this.bot.telegram.setMyCommands([
        { command: 'start',      description: 'Show help and available commands' },
        { command: 'status',     description: 'Your account info and Deribit connection' },
        { command: 'portfolio',  description: 'AI-powered portfolio summary' },
        { command: 'balance',    description: 'Quick balance overview' },
        { command: 'positions',  description: 'Open positions' },
        { command: 'orders',     description: 'Open orders' },
        { command: 'ask',        description: 'Ask the AI assistant a question' },
        { command: 'connect',    description: 'Link your Deribit credentials' },
        { command: 'api_create', description: 'Generate a REST API key' },
        { command: 'api_list',   description: 'List your active API keys' },
        { command: 'api_revoke', description: 'Revoke an API key — /api_revoke <keyId>' },
      ]);
      this.logger.log('Telegram command menu registered');
    } catch (err) {
      this.logger.warn(`Failed to register command menu: ${err.message}`);
    }
  }

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

    const text = isNew ? 'Welcome to Deribit Bot! 🚀\n\n' : 'Welcome back! 👋\n\n';

    await ctx.reply(
      text +
        '/status — your account & Deribit connection\n' +
        '/connect — link Deribit credentials\n' +
        '/portfolio — AI portfolio summary\n' +
        '/balance — quick balance overview\n' +
        '/positions — open positions\n' +
        '/orders — open orders\n' +
        '/ask <question> — AI trading assistant\n' +
        '/api_create — generate API key\n' +
        '/api_list — list API keys\n' +
        '/api_revoke <keyId> — revoke an API key',
    );
  }

  @Command('status')
  async onStatus(@Ctx() ctx: Context) {
    const from = s(ctx).from;
    if (!from) return;

    const { id: userId } = await this.authService.getOrCreateUser(
      BigInt(from.id),
      from.username,
    );

    const [deribitAccount, apiKeys] = await Promise.all([
      this.prisma.deribitAccount.findUnique({ where: { userId } }),
      this.prisma.apiKey.findMany({
        where: { userId, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const lines: string[] = ['👤 *Account Status*\n'];

    // User info
    lines.push(
      `Telegram: @${from.username ?? from.first_name}\n` +
      `ID: \`${from.id}\``,
    );

    // Deribit connection
    lines.push('\n🔌 *Deribit Connection*');
    if (deribitAccount) {
      lines.push(
        `Status: ✅ Connected\n` +
        `Client ID: \`${deribitAccount.clientId}\`\n` +
        `Network: ${deribitAccount.isTestnet ? '🧪 Testnet' : '🌐 Mainnet'}\n` +
        `URL: \`${deribitAccount.baseUrl}\``,
      );
    } else {
      lines.push('Status: ❌ Not connected\nUse /connect to link your Deribit account.');
    }

    // API keys
    const activeKeys = apiKeys.filter(
      (k) => !k.expiresAt || k.expiresAt > new Date(),
    );
    lines.push(`\n🔑 *API Keys* (${activeKeys.length} active)`);
    if (activeKeys.length === 0) {
      lines.push('No active keys. Use /api\\_create to generate one.');
    } else {
      for (const key of activeKeys.slice(0, 5)) {
        const lastUsed = key.lastUsedAt
          ? `last used ${timeAgo(key.lastUsedAt)}`
          : 'never used';
        lines.push(`\`${key.keyId}\` — ${lastUsed}`);
      }
      if (activeKeys.length > 5) lines.push(`_...and ${activeKeys.length - 5} more_`);
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  }

  // ---------------------------------------------------------------------------
  // API key management
  // ---------------------------------------------------------------------------

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
      `🔑 *Magic Link Token*\n\n` +
        `\`${token}\`\n\n` +
        `Visit: \`/auth/verify?token=${token}\`\n\n` +
        `Expires in 15 minutes`,
      { parse_mode: 'Markdown' },
    );
  }

  @Command('api_list')
  async onApiList(@Ctx() ctx: Context) {
    const from = s(ctx).from;
    if (!from) return;

    const { id: userId } = await this.authService.getOrCreateUser(
      BigInt(from.id),
      from.username,
    );

    const keys = await this.authService.listApiKeys(userId);

    if (keys.length === 0) {
      await ctx.reply('No active API keys. Use /api\\_create to generate one.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    const lines: string[] = [`🔑 *API Keys* (${keys.length})\n`];
    for (const key of keys) {
      const expires = key.expiresAt ? `expires ${key.expiresAt.toLocaleDateString()}` : 'no expiry';
      const lastUsed = key.lastUsedAt ? `last used ${timeAgo(key.lastUsedAt)}` : 'never used';
      const scopes = key.scopes.map((s: string) => s.toLowerCase().replace('_', ':')).join(', ');
      lines.push(
        `\`${key.keyId}\`\n` +
        `  ${expires} · ${lastUsed}\n` +
        `  Scopes: ${scopes}`,
      );
    }
    lines.push('\nTo revoke: /api\\_revoke \\<keyId\\>');

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  }

  @Command('api_revoke')
  async onApiRevoke(@Ctx() ctx: Context) {
    const tc = s(ctx);
    const from = tc.from;
    const message = tc.message;
    if (!from || !message || !('text' in message)) return;

    const keyId = (message as any).text.replace(/^\/api_revoke\s*/i, '').trim();

    if (!keyId) {
      await ctx.reply('Usage: /api\\_revoke \\<keyId\\>\nExample: /api\\_revoke PheWT\\-agzJpDk8tZ', {
        parse_mode: 'Markdown',
      });
      return;
    }

    const { id: userId } = await this.authService.getOrCreateUser(
      BigInt(from.id),
      from.username,
    );

    try {
      await this.authService.revokeApiKey(userId, keyId);
      await ctx.reply(`✅ API key \`${keyId}\` revoked.`, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
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

      const ordersRes = await client.trading.getOpenOrdersByCurrency({ currency: 'BTC' });
      const openOrdersCount = 'result' in ordersRes ? ordersRes.result.length : 0;

      const summary = await this.aiService.summarizePortfolio({ summaries: accountData, openOrdersCount });
      await ctx.reply(summary, { parse_mode: 'Markdown' });
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
        const pos = summariesRes.result.summaries.find((x: any) => x.currency === currency);
        if (pos) {
          lines.push(
            `*${currency}*\n` +
            `  Delta: \`${pos.delta_total ?? 0}\`\n` +
            `  Init margin: \`${pos.initial_margin}\`\n` +
            `  Maint margin: \`${pos.maintenance_margin}\``,
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
        CURRENCIES.map((c) => client.trading.getOpenOrdersByCurrency({ currency: c })),
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

    await ctx.reply(response, { parse_mode: 'Markdown' });
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

    if (text.startsWith('/')) return;

    const session = tc.session;
    if (session?.pendingAction?.type === 'connect_deribit') {
      await this.handleConnectWizard(ctx, tc, from, text);
      return;
    }

    const userId = await this.resolveUserId(BigInt(from.id), from.username);
    if (!userId) return;

    const account = await this.prisma.deribitAccount.findUnique({ where: { userId } });
    if (!account) return;

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
          `To place orders use the REST API:\n` +
          `POST /trading/${parsed.params.side ?? 'buy'} with instrument_name, amount, type.`,
        );
        break;
      case 'cancel_order':
        await ctx.reply(
          `To cancel an order:\nDELETE /trading/orders/${parsed.params.order_id ?? '<orderId>'}`,
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
        await ctx.reply(answer, { parse_mode: 'Markdown' });
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

  private async resolveUserId(telegramId: bigint, username?: string): Promise<string | null> {
    const user = await this.authService.findUserByTelegramId(telegramId);
    if (user) return user.id;
    const { id } = await this.authService.getOrCreateUser(telegramId, username);
    return id;
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
