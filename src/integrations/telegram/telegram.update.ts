import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Update, Start, Command, On, Ctx, InjectBot } from 'nestjs-telegraf';
import { Context, Telegraf } from 'telegraf';
import { AuthService } from '../../modules/auth/auth.service';
import { PrismaService } from '../../core/database/prisma.service';
import { DeribitClientService } from '../deribit/deribit.client.service';
import { MarketDataService } from '../../modules/market-data/market-data.service';
import type { TelegramContext } from './session.types';
import { Currency } from '@wrytes/deribit-api-client';

function s(ctx: Context): TelegramContext {
	return ctx as unknown as TelegramContext;
}

const CURRENCIES: Currency[] = [
	Currency.BTC,
	Currency.ETH,
	Currency.USDC,
	Currency.USDT,
];

@Update()
@Injectable()
export class TelegramUpdate implements OnModuleInit {
	private readonly logger = new Logger(TelegramUpdate.name);

	constructor(
		@InjectBot() private readonly bot: Telegraf,
		private readonly authService: AuthService,
		private readonly prisma: PrismaService,
		private readonly deribitClientService: DeribitClientService,
		private readonly marketDataService: MarketDataService,
	) {}

	async onModuleInit() {
		try {
			await this.bot.telegram.setMyCommands([
				{ command: 'start', description: 'Show available commands' },
				{
					command: 'status',
					description: 'Account info and Deribit connection',
				},
				{
					command: 'market',
					description: 'Current prices, DVOL, IV rank',
				},
				{ command: 'balance', description: 'Quick balance overview' },
				{ command: 'positions', description: 'Open positions' },
				{ command: 'orders', description: 'Open orders' },
				{
					command: 'connect',
					description: 'Link your Deribit credentials',
				},
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
		const greeting = isNew
			? 'Welcome to Deribit Agent! 🤖\n\n'
			: 'Welcome back! 👋\n\n';

		await ctx.reply(
			greeting +
				'📊 *Market*\n' +
				'/market — prices, DVOL, IV rank\n\n' +
				'💼 *Account*\n' +
				'/balance — balances\n' +
				'/positions — open positions\n' +
				'/orders — open orders\n\n' +
				'⚙️ *Setup*\n' +
				'/status — account & connection\n' +
				'/connect — link Deribit credentials\n\n' +
				'🔬 *Platform (REST API)*\n' +
				'Data ingestion, training sessions, and agent runs are managed via REST API.\n' +
				'Manage API keys at wrytes.io — use your wrytes-api token to authenticate.\n' +
				'Swagger docs: `GET /api`',
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

		const [deribitAccount] = await Promise.all([
			this.prisma.deribitAccount
				.findFirst({ where: { userId, isDefault: true } })
				.then(
					(a) =>
						a ??
						this.prisma.deribitAccount.findFirst({
							where: { userId },
						}),
				),
		]);

		const lines: string[] = ['👤 *Account Status*\n'];
		lines.push(
			`Telegram: @${from.username ?? from.first_name}\nID: \`${from.id}\``,
		);

		lines.push('\n🔌 *Deribit Connection*');
		if (deribitAccount) {
			lines.push(
				`Status: ✅ Connected\n` +
					`Client ID: \`${deribitAccount.clientId}\`\n` +
					`Network: ${deribitAccount.isTestnet ? '🧪 Testnet' : '🌐 Mainnet'}`,
			);
		} else {
			lines.push(
				'Status: ❌ Not connected\nUse /connect to link your Deribit account.',
			);
		}

		lines.push('\n🔑 *API Keys*\nManage your API keys at wrytes.io');

		await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
	}

	// ---------------------------------------------------------------------------
	// Market
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
						`  IV Pct: \`${c.ivPercentile?.toFixed(1) ?? 'n/a'}%\`\n` +
						`  RV 30d: \`${c.rv30d ? (c.rv30d * 100).toFixed(1) + '%' : 'n/a'}\``,
				);
			}

			await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
		} catch (err) {
			await ctx.reply(`❌ Error: ${err.message}`);
		}
	}

	// ---------------------------------------------------------------------------
	// Portfolio / account
	// ---------------------------------------------------------------------------

	@Command('balance')
	async onBalance(@Ctx() ctx: Context) {
		const from = s(ctx).from;
		if (!from) return;

		const userId = await this.resolveUserId(BigInt(from.id), from.username);
		if (!userId) {
			await ctx.reply('Use /connect first to link your Deribit account.');
			return;
		}

		try {
			const client = await this.deribitClientService.getClient(userId);
			const results = await Promise.allSettled(
				CURRENCIES.map((c) =>
					client.account.getAccountSummary({ currency: c }),
				),
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
		if (!userId) {
			await ctx.reply('Use /connect first to link your Deribit account.');
			return;
		}

		try {
			const client = await this.deribitClientService.getClient(userId);
			const summariesRes = await client.account.getAccountSummaries({});
			if (!('result' in summariesRes)) {
				await ctx.reply('Unable to fetch positions.');
				return;
			}

			const active = (summariesRes.result as any).summaries.filter(
				(pos: any) => pos.delta_total !== 0 || pos.initial_margin > 0,
			);

			if (active.length === 0) {
				await ctx.reply('📭 No open positions.');
				return;
			}

			const lines: string[] = ['📈 *Open Positions*\n'];
			for (const pos of active) {
				lines.push(
					`*${pos.currency}*\n` +
						`  Delta: \`${pos.delta_total ?? 0}\`\n` +
						`  Init margin: \`${pos.initial_margin}\`\n` +
						`  Maint margin: \`${pos.maintenance_margin}\``,
				);
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
		if (!userId) {
			await ctx.reply('Use /connect first to link your Deribit account.');
			return;
		}

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
					allOrders.push(...(res.value.result as any[]));
				}
			}

			if (allOrders.length === 0) {
				await ctx.reply('📭 No open orders.');
				return;
			}

			const lines: string[] = [
				`📋 *Open Orders* (${allOrders.length})\n`,
			];
			for (const o of allOrders.slice(0, 10)) {
				lines.push(
					`*${o.direction.toUpperCase()}* ${o.instrument_name}\n` +
						`  Amount: \`${o.amount}\` | Price: \`${o.price}\`\n` +
						`  ID: \`${o.order_id}\` | State: ${o.order_state}`,
				);
			}
			if (allOrders.length > 10)
				lines.push(`_...and ${allOrders.length - 10} more_`);

			await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
		} catch (err) {
			await ctx.reply(`❌ Error: ${err.message}`);
		}
	}

	// ---------------------------------------------------------------------------
	// Deribit credential setup
	// ---------------------------------------------------------------------------

	@Command('connect')
	async onConnect(@Ctx() ctx: Context) {
		s(ctx).session.pendingAction = {
			type: 'connect_deribit',
			step: 'client_id',
		};
		await ctx.reply('Please send your Deribit Client ID:');
	}

	// ---------------------------------------------------------------------------
	// Text handler — /connect wizard only
	// ---------------------------------------------------------------------------

	@On('text')
	async onText(@Ctx() ctx: Context) {
		const tc = s(ctx);
		const from = tc.from;
		const message = tc.message;
		if (!from || !message || !('text' in message)) return;

		const text = (message as any).text.trim() as string;
		if (text.startsWith('/')) return;

		if (tc.session?.pendingAction?.type === 'connect_deribit') {
			await this.handleConnectWizard(ctx, tc, from, text);
			return;
		}

		await ctx.reply(
			'Use the REST API for data, training, and agent operations.\nType /start for help.',
		);
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

			const existing = await this.prisma.deribitAccount.findFirst({
				where: { userId },
			});
			if (existing) {
				await this.prisma.deribitAccount.update({
					where: { id: existing.id },
					data: { clientId, clientSecret: text },
				});
			} else {
				await this.prisma.deribitAccount.create({
					data: {
						userId,
						clientId,
						clientSecret: text,
						isDefault: true,
					},
				});
			}

			this.deribitClientService.evictClient(userId);
			tc.session.pendingAction = undefined;
			await ctx.reply(
				'✅ Connected! Credentials saved.\n\nTry /balance or /positions.',
			);
			this.logger.log(
				`User ${userId} saved Deribit credentials via Telegram`,
			);
		}
	}

	private async resolveUserId(
		telegramId: bigint,
		username?: string,
	): Promise<string | null> {
		const user = await this.authService.findUserByTelegramId(telegramId);
		if (user) return user.id;
		const { id } = await this.authService.getOrCreateUser(
			telegramId,
			username,
		);
		return id;
	}
}

function timeAgo(date: Date): string {
	const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
	if (seconds < 60) return 'just now';
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86400)}d ago`;
}
