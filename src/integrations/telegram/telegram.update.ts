import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Update, Start, Command, On, Ctx, InjectBot } from 'nestjs-telegraf';
import { Context, Telegraf } from 'telegraf';
import { AuthService } from '../../modules/auth/auth.service';
import { PrismaService } from '../../core/database/prisma.service';
import { DeribitClientService } from '../deribit/deribit.client.service';
import { AiService } from '../ai/ai.service';
import { MarketDataService } from '../../modules/market-data/market-data.service';
import { StrategyService, CreateStrategyDto } from '../../modules/strategy/strategy.service';
import type { TelegramContext } from './session.types';
import { ApiKeyScope, StrategyStatus, StrategyType } from '@prisma/client';
import { Currency } from '@wrytlabs/deribit-api-client';

function s(ctx: Context): TelegramContext {
  return ctx as unknown as TelegramContext;
}

const CURRENCIES: Currency[] = [Currency.BTC, Currency.ETH, Currency.USDC, Currency.USDT];

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
    private readonly marketDataService: MarketDataService,
    private readonly strategyService: StrategyService,
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
        { command: 'market',          description: 'Current prices, DVOL, IV rank, RV' },
        { command: 'vol',             description: 'AI volatility deep-dive analysis' },
        { command: 'suggest',         description: 'AI: best strategy for current conditions' },
        { command: 'strategy_create', description: 'Create a new trading strategy' },
        { command: 'strategies',      description: 'List all your strategies' },
        { command: 'connect',         description: 'Link your Deribit credentials' },
        { command: 'api_create',      description: 'Generate a REST API key' },
        { command: 'api_list',        description: 'List your active API keys' },
        { command: 'api_revoke',      description: 'Revoke an API key — /api_revoke <keyId>' },
        { command: 'reset',           description: 'Clear conversation history' },
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
        '📊 *Market & Analysis*\n' +
        '/market — prices, DVOL, IV rank, RV\n' +
        '/vol — AI volatility analysis\n' +
        '/suggest — best strategy for current conditions\n\n' +
        '🗂 *Strategies*\n' +
        '/strategy\\_create — create a new strategy\n' +
        '/strategies — list all strategies\n\n' +
        '💼 *Portfolio*\n' +
        '/portfolio — AI portfolio summary\n' +
        '/balance — quick balances\n' +
        '/positions — open positions\n' +
        '/orders — open orders\n\n' +
        '🤖 *AI Assistant*\n' +
        '/ask <question> — trading Q&A\n\n' +
        '⚙️ *Account*\n' +
        '/status — account & connection info\n' +
        '/connect — link Deribit credentials\n' +
        '/api\\_create — generate API key\n' +
        '/api\\_list — list API keys\n' +
        '/api\\_revoke <keyId> — revoke a key',
      { parse_mode: 'Markdown' },
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
  // Market analysis commands
  // ---------------------------------------------------------------------------

  @Command('market')
  async onMarket(@Ctx() ctx: Context) {
    await ctx.reply('📡 Fetching market data...');
    try {
      const all = await this.marketDataService.getAllConditions();
      const lines: string[] = ['📊 *Market Overview*\n'];

      for (const c of all) {
        if (c.indexPrice === 0) continue;
        lines.push(
          `*${c.currency}*\n` +
          `  Price: \`$${c.indexPrice.toLocaleString()}\`\n` +
          `  DVOL: \`${c.dvolIndex?.toFixed(1) ?? 'n/a'}\`\n` +
          `  IV Rank: \`${c.ivRank?.toFixed(1) ?? 'n/a'}/100\`\n` +
          `  IV Percentile: \`${c.ivPercentile?.toFixed(1) ?? 'n/a'}%\`\n` +
          `  RV 30d: \`${c.rv30d ? (c.rv30d * 100).toFixed(1) + '%' : 'n/a'}\`\n` +
          `  IV/RV: \`${c.ivOverRv?.toFixed(2) ?? 'n/a'}\` ${ivOverRvLabel(c.ivOverRv)}`,
        );
      }

      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  }

  @Command('vol')
  async onVol(@Ctx() ctx: Context) {
    const tc = s(ctx);
    await ctx.reply('📡 Fetching volatility data...');
    try {
      const all = await this.marketDataService.getAllConditions();
      const analysis = await this.aiService.analyzeMarketConditions(all);
      await this.safeReply(ctx, `📈 *Volatility Analysis*\n\n${analysis}`);
      this.seedHistory(tc, 'Analyze current market volatility conditions.', analysis);
      await ctx.reply('_Ask me anything about this — e.g. "is now a good time to sell premium?"_', {
        parse_mode: 'Markdown',
      });
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  }

  @Command('suggest')
  async onSuggest(@Ctx() ctx: Context) {
    const tc = s(ctx);
    const from = tc.from;
    await ctx.reply('🤖 Analyzing market conditions for strategy fit...');
    try {
      const all = await this.marketDataService.getAllConditions();
      const suggestion = await this.aiService.suggestStrategies(all);
      await this.safeReply(ctx, `💡 *Strategy Suggestions*\n\n${suggestion}`);
      this.seedHistory(tc, 'Suggest the best trading strategies for current market conditions.', suggestion);
      await ctx.reply('_Ask me to go deeper on any strategy — e.g. "explain the iron condor setup"_', {
        parse_mode: 'Markdown',
      });
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Strategy management commands
  // ---------------------------------------------------------------------------

  @Command('strategies')
  async onStrategies(@Ctx() ctx: Context) {
    const from = s(ctx).from;
    if (!from) return;

    const { id: userId } = await this.authService.getOrCreateUser(BigInt(from.id), from.username);
    const strategies = await this.strategyService.list(userId);

    if (strategies.length === 0) {
      await ctx.reply(
        '📭 No strategies yet. Use /strategy\\_create to create one.',
        { parse_mode: 'Markdown' },
      );
      return;
    }

    const lines: string[] = [`🗂 *Strategies* (${strategies.length})\n`];
    for (const strat of strategies) {
      const latest = strat.snapshots[0];
      const pnlBtc = latest?.unrealizedPnlBtc ?? null;
      const pnlUsd =
        pnlBtc !== null && latest?.btcIndexPrice
          ? (Number(pnlBtc) * Number(latest.btcIndexPrice)).toFixed(2)
          : null;

      const statusEmoji = { DRAFT: '📝', ACTIVE: '✅', PAUSED: '⏸', CLOSED: '🔴' }[strat.status] ?? '';
      lines.push(
        `${statusEmoji} *${strat.name}* (${strat.type.toLowerCase().replace('_', ' ')})\n` +
        `  Allocation: \`${strat.allocationBtc} BTC\`\n` +
        `  Legs: ${strat.legs.length} open\n` +
        (pnlBtc !== null
          ? `  P&L: \`${Number(pnlBtc) >= 0 ? '+' : ''}${Number(pnlBtc).toFixed(6)} BTC\`` +
            (pnlUsd ? ` (\`$${pnlUsd}\`)` : '')
          : '  P&L: n/a') +
        `\n  ID: \`${strat.id.slice(0, 8)}\``,
      );
    }
    lines.push('\nTip: /suggest to see which strategy fits current conditions.');

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  }

  @Command('strategy_create')
  async onStrategyCreate(@Ctx() ctx: Context) {
    const tc = s(ctx);
    const types = Object.values(StrategyType)
      .map((t, i) => `${i + 1}. ${t.toLowerCase().replace(/_/g, ' ')}`)
      .join('\n');

    tc.session.pendingAction = { type: 'strategy_create', step: 'type' };
    await ctx.reply(
      `📝 *Create a Strategy*\n\nChoose a type:\n${types}\n\nReply with the number or name:`,
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
            unrealized_pnl: result.unrealized_pnl,
          };
        })
        .filter((d) => d.equity > 0 || d.balance > 0);

      if (accountData.length === 0) {
        await ctx.reply('📭 No active balances found on your Deribit account.');
        return;
      }

      const ordersRes = await client.trading.getOpenOrdersByCurrency({ currency: 'BTC' });
      const openOrdersCount = 'result' in ordersRes ? ordersRes.result.length : 0;

      // Build a structured fallback regardless — shown if AI is unavailable
      const fallback = buildPortfolioText(accountData, openOrdersCount);

      let summary: string;
      try {
        const aiSummary = await this.aiService.summarizePortfolio({ summaries: accountData, openOrdersCount });
        // If AI returned its own fallback string, use the structured one instead
        summary = aiSummary.startsWith('Unable to') ? fallback : aiSummary;
      } catch {
        summary = fallback;
      }

      await this.safeReply(ctx, summary);
      this.seedHistory(s(ctx), 'Give me a summary of my Deribit portfolio.', summary);
      await ctx.reply('_Want to dive deeper? Just ask — e.g. "how can I reduce my margin usage?"_', {
        parse_mode: 'Markdown',
      });
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
      await ctx.reply(
        'Just type your question directly — no /ask needed!\nOr: /ask What is delta in options?',
      );
      return;
    }

    await this.continueConversation(ctx, tc, question);
  }

  @Command('reset')
  async onReset(@Ctx() ctx: Context) {
    s(ctx).session.askHistory = [];
    await ctx.reply('🔄 Conversation history cleared. Starting fresh!');
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

    // Active wizard takes priority
    if (tc.session?.pendingAction?.type === 'connect_deribit') {
      await this.handleConnectWizard(ctx, tc, from, text);
      return;
    }
    if (tc.session?.pendingAction?.type === 'strategy_create') {
      await this.handleStrategyWizard(ctx, tc, from, text);
      return;
    }

    // Everything else continues the conversation
    await this.continueConversation(ctx, tc, text);
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

  private async handleStrategyWizard(
    ctx: Context,
    tc: TelegramContext,
    from: NonNullable<typeof tc.from>,
    text: string,
  ) {
    const step = tc.session.pendingAction?.step;
    const data = tc.session.pendingAction?.data ?? {};
    const types = Object.values(StrategyType);

    if (step === 'type') {
      // Accept number (1-8) or type name
      const idx = parseInt(text, 10);
      let chosen: StrategyType | undefined;
      if (!isNaN(idx) && idx >= 1 && idx <= types.length) {
        chosen = types[idx - 1];
      } else {
        chosen = types.find(
          (t) => t.toLowerCase() === text.toUpperCase() || t.toLowerCase().replace(/_/g, ' ') === text.toLowerCase(),
        );
      }

      if (!chosen) {
        await ctx.reply('Unknown type. Reply with a number 1–8 or the strategy name.');
        return;
      }

      tc.session.pendingAction = { type: 'strategy_create', step: 'name', data: { type: chosen } };
      await ctx.reply(`*${chosen.toLowerCase().replace(/_/g, ' ')}* selected.\n\nGive this strategy a name:`, {
        parse_mode: 'Markdown',
      });
      return;
    }

    if (step === 'name') {
      tc.session.pendingAction = { type: 'strategy_create', step: 'allocation', data: { ...data, name: text } };
      await ctx.reply('How much BTC to allocate? (e.g. `0.05`):', { parse_mode: 'Markdown' });
      return;
    }

    if (step === 'allocation') {
      const allocation = parseFloat(text);
      if (isNaN(allocation) || allocation <= 0) {
        await ctx.reply('Invalid amount. Enter a positive number, e.g. `0.05`:', { parse_mode: 'Markdown' });
        return;
      }

      tc.session.pendingAction = {
        type: 'strategy_create',
        step: 'dte',
        data: { ...data, allocationBtc: allocation },
      };
      await ctx.reply(
        'Target days-to-expiration (DTE)? e.g. `21` for 3-week options, or `skip`:',
        { parse_mode: 'Markdown' },
      );
      return;
    }

    if (step === 'dte') {
      const dte = text.toLowerCase() === 'skip' ? null : parseInt(text, 10);
      tc.session.pendingAction = {
        type: 'strategy_create',
        step: 'rebalance',
        data: { ...data, dte: dte !== null && !isNaN(dte) ? dte : null },
      };
      await ctx.reply(
        'Rebalance trigger? USD move in BTC price that triggers a delta hedge — e.g. `500`, or `skip`:',
        { parse_mode: 'Markdown' },
      );
      return;
    }

    if (step === 'rebalance') {
      const rebalance = text.toLowerCase() === 'skip' ? null : parseInt(text, 10);
      tc.session.pendingAction = {
        type: 'strategy_create',
        step: 'ivr_threshold',
        data: { ...data, rebalanceTriggerUsd: rebalance !== null && !isNaN(rebalance) ? rebalance : null },
      };
      await ctx.reply(
        'Minimum IV rank to enter? (0–100, or `skip` for no threshold):',
        { parse_mode: 'Markdown' },
      );
      return;
    }

    if (step === 'ivr_threshold') {
      const { id: userId } = await this.authService.getOrCreateUser(BigInt(from.id), from.username);

      const ivrThreshold = text.toLowerCase() === 'skip' ? null : parseInt(text, 10);

      const params: Record<string, any> = {};
      if (data.dte !== null) params.dte = data.dte;
      if (data.rebalanceTriggerUsd !== null) params.rebalanceTriggerUsd = data.rebalanceTriggerUsd;
      if (ivrThreshold !== null && !isNaN(ivrThreshold)) params.ivrThreshold = ivrThreshold;

      const dto: CreateStrategyDto = {
        name: data.name as string,
        type: data.type as StrategyType,
        allocationBtc: data.allocationBtc as number,
        params,
      };

      const strategy = await this.strategyService.create(userId, dto);
      tc.session.pendingAction = undefined;

      // Summary of what was saved
      const paramLines = [
        `Type: ${strategy.type.toLowerCase().replace(/_/g, ' ')}`,
        `Allocation: ${strategy.allocationBtc} BTC`,
        params.dte ? `DTE: ${params.dte} days` : null,
        params.rebalanceTriggerUsd ? `Rebalance: every $${params.rebalanceTriggerUsd} move` : null,
        params.ivrThreshold ? `Min IVR: ${params.ivrThreshold}` : null,
      ].filter(Boolean).join('\n');

      await ctx.reply(
        `✅ *${strategy.name}* created in DRAFT mode\n\n${paramLines}\n\nFetching market analysis...`,
        { parse_mode: 'Markdown' },
      );

      // AI entry analysis
      try {
        const conditions = await this.marketDataService.getAllConditions();
        const suggestion = await this.aiService.suggestStrategies(conditions);
        await this.safeReply(ctx, `💡 *Market conditions for your strategy*\n\n${suggestion}`);
      } catch (err) {
        this.logger.warn(`AI analysis failed: ${err.message}`);
      }

      await ctx.reply(
        `ID: \`${strategy.id}\`\n\nUse /strategies to see all your strategies.`,
        { parse_mode: 'Markdown' },
      );
    }
  }

  /**
   * The single entry-point for all conversational AI turns.
   * Fetches fresh context, appends the user message, calls the AI,
   * appends the response, and trims history to stay within limits.
   */
  private async continueConversation(ctx: Context, tc: TelegramContext, userText: string) {
    const from = tc.from;
    if (!from) return;

    if (!tc.session.askHistory) tc.session.askHistory = [];
    tc.session.askHistory.push({ role: 'user', content: userText });

    // Trim to last 30 turns (15 exchanges)
    if (tc.session.askHistory.length > 30) {
      tc.session.askHistory = tc.session.askHistory.slice(-30);
    }

    const userId = await this.resolveUserId(BigInt(from.id), from.username);
    const context = userId ? await this.buildAiContext(userId) : undefined;

    await ctx.reply('🤔 ...');
    const response = await this.aiService.ask(tc.session.askHistory, context ?? undefined);
    tc.session.askHistory.push({ role: 'assistant', content: response });

    await this.safeReply(ctx, response);
  }

  /**
   * Seed conversation history after a command produces AI output,
   * so the user can immediately ask follow-up questions.
   */
  private seedHistory(tc: TelegramContext, userPrompt: string, assistantResponse: string) {
    if (!tc.session.askHistory) tc.session.askHistory = [];
    tc.session.askHistory.push(
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: assistantResponse },
    );
    // Keep history bounded
    if (tc.session.askHistory.length > 30) {
      tc.session.askHistory = tc.session.askHistory.slice(-30);
    }
  }

  /** Fetch live market + strategy context for the system prompt. */
  private async buildAiContext(userId: string) {
    const [conditions, strategies] = await Promise.allSettled([
      this.marketDataService.getAllConditions(),
      this.strategyService.list(userId),
    ]);
    return {
      marketConditions: conditions.status === 'fulfilled' ? conditions.value : undefined,
      activeStrategies:
        strategies.status === 'fulfilled'
          ? strategies.value.map((s) => ({
              name: s.name,
              type: s.type as string,
              status: s.status as string,
              allocationBtc: Number(s.allocationBtc),
            }))
          : [],
    };
  }

  /**
   * Send a message with Markdown formatting. If Telegram rejects it due to a
   * parse error (unmatched * _ ` from AI output), retry as plain text so the
   * message always reaches the user.
   */
  private async safeReply(ctx: Context, text: string): Promise<void> {
    try {
      await ctx.reply(text, { parse_mode: 'Markdown' });
    } catch (err) {
      const msg: string = err?.message ?? '';
      if (msg.includes('Bad Request') || msg.includes("can't parse entities")) {
        await ctx.reply(text); // plain text fallback
      } else {
        throw err;
      }
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

/** Format raw account data into a readable portfolio summary (no AI required). */
function buildPortfolioText(
  data: Array<{
    currency: string;
    equity: number;
    balance: number;
    available_funds: number;
    initial_margin: number;
    maintenance_margin: number;
    unrealized_pnl?: number;
    delta_total?: number;
  }>,
  openOrdersCount: number,
): string {
  const lines: string[] = ['📊 *Portfolio Summary*\n'];
  for (const d of data) {
    const pnlStr =
      d.unrealized_pnl !== undefined
        ? `\n  Unrealized P&L: \`${d.unrealized_pnl >= 0 ? '+' : ''}${d.unrealized_pnl.toFixed(6)}\``
        : '';
    const deltaStr =
      d.delta_total !== undefined && d.delta_total !== 0
        ? `\n  Delta: \`${d.delta_total.toFixed(4)}\``
        : '';
    lines.push(
      `*${d.currency}*\n` +
      `  Equity: \`${d.equity.toFixed(6)}\`\n` +
      `  Balance: \`${d.balance.toFixed(6)}\`\n` +
      `  Available: \`${d.available_funds.toFixed(6)}\`\n` +
      `  Margin used: \`${d.initial_margin.toFixed(6)}\`` +
      pnlStr +
      deltaStr,
    );
  }
  if (openOrdersCount > 0) lines.push(`\nOpen orders: \`${openOrdersCount}\``);
  return lines.join('\n');
}

/** Label the IV/RV ratio for quick visual scanning. */
function ivOverRvLabel(ratio: number | null): string {
  if (ratio === null) return '';
  if (ratio >= 1.5) return '🔥 premium elevated';
  if (ratio >= 1.1) return '📈 slight premium';
  if (ratio >= 0.9) return '⚖️ fair value';
  return '📉 IV cheap';
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
