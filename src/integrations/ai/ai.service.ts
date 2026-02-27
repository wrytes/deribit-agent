import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-4-6';

export interface ParsedTradingCommand {
  action: string;
  params: Record<string, any>;
  confidence: 'high' | 'low';
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly client: Anthropic;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('ai.anthropicApiKey');
    this.client = new Anthropic({ apiKey });
  }

  /**
   * Parse a natural language message into a structured trading command.
   * Uses tool_use so we always get a typed action back.
   */
  async parseTradingCommand(text: string): Promise<ParsedTradingCommand> {
    const tools: Anthropic.Tool[] = [
      {
        name: 'portfolio_summary',
        description: 'Show a summary of the user\'s portfolio / account balances',
        input_schema: {
          type: 'object' as const,
          properties: {
            currency: { type: 'string', description: 'Optional specific currency (BTC, ETH, USDC)' },
          },
          required: [],
        },
      },
      {
        name: 'open_positions',
        description: 'Show open positions',
        input_schema: {
          type: 'object' as const,
          properties: {
            currency: { type: 'string', description: 'Currency filter (BTC, ETH, USDC)' },
          },
          required: [],
        },
      },
      {
        name: 'open_orders',
        description: 'Show open orders',
        input_schema: {
          type: 'object' as const,
          properties: {
            currency: { type: 'string', description: 'Currency filter (BTC, ETH, USDC)' },
          },
          required: [],
        },
      },
      {
        name: 'place_order',
        description: 'Place a buy or sell order',
        input_schema: {
          type: 'object' as const,
          properties: {
            side: { type: 'string', enum: ['buy', 'sell'], description: 'Order side' },
            instrument: { type: 'string', description: 'Instrument name, e.g. BTC-PERPETUAL' },
            amount: { type: 'number', description: 'Order amount' },
            price: { type: 'number', description: 'Limit price (omit for market)' },
          },
          required: ['side'],
        },
      },
      {
        name: 'cancel_order',
        description: 'Cancel an open order by order ID',
        input_schema: {
          type: 'object' as const,
          properties: {
            order_id: { type: 'string', description: 'Order ID to cancel' },
          },
          required: [],
        },
      },
      {
        name: 'ask_question',
        description: 'Answer a general question about trading, Deribit, or the portfolio',
        input_schema: {
          type: 'object' as const,
          properties: {
            question: { type: 'string', description: 'The question to answer' },
          },
          required: ['question'],
        },
      },
      {
        name: 'unknown',
        description: 'Cannot determine the intended command',
        input_schema: {
          type: 'object' as const,
          properties: {
            suggestion: { type: 'string', description: 'What the user might mean' },
          },
          required: [],
        },
      },
    ];

    try {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: 256,
        system:
          'You are a Deribit trading assistant. Parse the user\'s message and call the appropriate tool. ' +
          'Deribit supports BTC, ETH, USDC, USDT, EURR. ' +
          'Perpetual instruments: BTC-PERPETUAL, ETH-PERPETUAL. Options use format BTC-DDMMMYY-STRIKE-C/P.',
        messages: [{ role: 'user', content: text }],
        tools,
        tool_choice: { type: 'any' },
      });

      const toolUse = response.content.find((c) => c.type === 'tool_use') as
        | Anthropic.ToolUseBlock
        | undefined;

      if (!toolUse) {
        return { action: 'unknown', params: {}, confidence: 'low' };
      }

      return {
        action: toolUse.name,
        params: toolUse.input as Record<string, any>,
        confidence: toolUse.name === 'unknown' ? 'low' : 'high',
      };
    } catch (error) {
      this.logger.error(`Failed to parse trading command: ${error.message}`);
      return { action: 'unknown', params: {}, confidence: 'low' };
    }
  }

  /**
   * Generate a human-readable portfolio summary from raw account data.
   */
  async summarizePortfolio(data: {
    summaries: Array<{
      currency: string;
      equity: number;
      balance: number;
      margin_balance: number;
      available_funds: number;
      initial_margin: number;
      maintenance_margin: number;
      unrealized_pnl?: number;
      delta_total?: number;
    }>;
    openOrdersCount: number;
  }): Promise<string> {
    try {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: 512,
        system:
          'You are a Deribit trading assistant. Given raw portfolio data, write a concise, friendly summary ' +
          'suitable for a Telegram message. Format using Telegram Markdown v1 only: ' +
          '*bold* for section labels, `backticks` for numeric values, plain text otherwise. ' +
          'Do NOT use ** double asterisks, # headings, or markdown tables (| col |) — Telegram does not render them. For tabular data use a triple-backtick code block with space-padded columns instead.' +
          'Keep it under 200 words. Highlight equity, available funds, margin usage, and P&L. Use emojis sparingly.',
        messages: [
          {
            role: 'user',
            content: `Summarize my Deribit portfolio:\n${JSON.stringify(data, null, 2)}`,
          },
        ],
      });

      const text = response.content.find((c) => c.type === 'text') as
        | Anthropic.TextBlock
        | undefined;
      return text?.text ?? 'Unable to generate portfolio summary.';
    } catch (error) {
      this.logger.error(`Failed to summarize portfolio: ${error.message}`);
      return 'Unable to generate portfolio summary.';
    }
  }

  /**
   * Produce a Telegram-formatted analysis of current market conditions.
   */
  async analyzeMarketConditions(conditions: {
    currency: string;
    indexPrice: number;
    dvolIndex: number | null;
    rv30d: number | null;
    ivRank: number | null;
    ivPercentile: number | null;
    ivOverRv: number | null;
  }[]): Promise<string> {
    try {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: 600,
        system:
          'You are a Deribit volatility analyst. Given current market metrics, write a concise ' +
          'analysis suitable for a Telegram message. Cover: vol regime (high/low/normal), ' +
          'whether IV is elevated vs realized (premium for sellers), and any notable conditions. ' +
          'Format using Telegram Markdown v1: *bold* for labels, `backticks` for numbers. ' +
          'Do NOT use ** double asterisks, # headings, or markdown tables (| col |) — Telegram does not render them. For tabular data use a triple-backtick code block with space-padded columns instead. Keep it under 200 words.',
        messages: [
          {
            role: 'user',
            content: `Analyze these market conditions:\n${JSON.stringify(conditions, null, 2)}`,
          },
        ],
      });

      const text = response.content.find((c) => c.type === 'text') as
        | Anthropic.TextBlock
        | undefined;
      return text?.text ?? 'Unable to generate market analysis.';
    } catch (error) {
      this.logger.error(`Failed to analyze market conditions: ${error.message}`);
      return 'Unable to generate market analysis.';
    }
  }

  /**
   * Rank all strategy types for the current market conditions and return
   * a Telegram-formatted recommendation with reasoning.
   */
  async suggestStrategies(conditions: {
    currency: string;
    indexPrice: number;
    dvolIndex: number | null;
    rv30d: number | null;
    ivRank: number | null;
    ivPercentile: number | null;
    ivOverRv: number | null;
  }[]): Promise<string> {
    const strategyTypes = [
      'IRON_CONDOR — non-directional, sell both sides (best when IV high, low expected move)',
      'STRANGLE — sell OTM put + call (high IV, wide range ok)',
      'STRADDLE — sell ATM put + call (very high IV, expect pin)',
      'COVERED_CALL — hold BTC + sell call (mild bullish, elevated call IV)',
      'CASH_SECURED_PUT — sell put + hold collateral (bullish, want to accumulate BTC)',
      'WHEEL — CSP → covered call cycle (range-bound market)',
      'DELTA_NEUTRAL — keep delta ~0 while collecting theta (any IV, requires active hedging)',
      'CUSTOM — user-defined multi-leg',
    ];

    try {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: 800,
        system:
          'You are a Deribit options strategy advisor. Given current market conditions, rank the ' +
          'available strategy types from best to worst fit and explain why. ' +
          'Be direct and quantitative — reference IV rank, IV/RV ratio, and expected vol regime. ' +
          'Format using Telegram Markdown v1: *bold* for strategy names, `backticks` for numbers. ' +
          'Do NOT use ** double asterisks, # headings, or markdown tables (| col |) — Telegram does not render them. For tabular data use a triple-backtick code block with space-padded columns instead. Show top 3 strategies with brief reasoning each. ' +
          'End with a one-sentence overall market regime summary. Keep it under 250 words.',
        messages: [
          {
            role: 'user',
            content:
              `Market conditions:\n${JSON.stringify(conditions, null, 2)}\n\n` +
              `Available strategies:\n${strategyTypes.join('\n')}`,
          },
        ],
      });

      const text = response.content.find((c) => c.type === 'text') as
        | Anthropic.TextBlock
        | undefined;
      return text?.text ?? 'Unable to generate strategy suggestions.';
    } catch (error) {
      this.logger.error(`Failed to suggest strategies: ${error.message}`);
      return 'Unable to generate strategy suggestions.';
    }
  }

  /**
   * Generate AI commentary on a specific strategy's current state.
   */
  async analyzeStrategy(strategy: {
    name: string;
    type: string;
    status: string;
    allocationBtc: number;
    params: any;
    legs: Array<{ instrumentName: string; direction: string; quantity: number; openPrice: number }>;
    latestSnapshot?: { delta?: number; theta?: number; vega?: number; unrealizedPnlBtc?: number; btcIndexPrice: number } | null;
  }, currentConditions: { indexPrice: number; ivRank: number | null; dvolIndex: number | null }): Promise<string> {
    try {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: 500,
        system:
          'You are a Deribit trading assistant. Analyze the given strategy position and provide ' +
          'a concise status update: current P&L interpretation, greek exposure summary, ' +
          'whether current market conditions are favorable, and any suggested adjustments. ' +
          'Format using Telegram Markdown v1: *bold* for labels, `backticks` for numbers. ' +
          'Do NOT use ** or # headings. Keep it under 200 words.',
        messages: [
          {
            role: 'user',
            content: `Strategy:\n${JSON.stringify(strategy, null, 2)}\n\nCurrent market:\n${JSON.stringify(currentConditions, null, 2)}`,
          },
        ],
      });

      const text = response.content.find((c) => c.type === 'text') as
        | Anthropic.TextBlock
        | undefined;
      return text?.text ?? 'Unable to analyze strategy.';
    } catch (error) {
      this.logger.error(`Failed to analyze strategy: ${error.message}`);
      return 'Unable to analyze strategy.';
    }
  }

  /**
   * Conversational assistant with persistent history and optional live context.
   *
   * `context` is injected into the system prompt so Claude always has fresh
   * numbers even mid-conversation — without the user having to re-run commands.
   */
  async ask(
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
    context?: {
      marketConditions?: Array<{
        currency: string;
        indexPrice: number;
        dvolIndex: number | null;
        rv30d: number | null;
        ivRank: number | null;
        ivPercentile: number | null;
        ivOverRv: number | null;
      }>;
      activeStrategies?: Array<{
        name: string;
        type: string;
        status: string;
        allocationBtc: number;
      }>;
    },
  ): Promise<string> {
    const systemParts: string[] = [
      'You are a knowledgeable Deribit trading assistant embedded in a Telegram bot. ' +
      'Help the user understand their portfolio, analyse volatility conditions, and discuss strategies. ' +
      'Be concise, practical, and engaging — ask clarifying questions when useful. ' +
      'You have memory of this conversation, so reference earlier messages naturally. ' +
      '\n\n' +
      'CRITICAL LIMITS — never break these:\n' +
      '1. You are a conversational assistant ONLY. You cannot execute trades, place orders, or run bot commands.\n' +
      '2. Never pretend to run a command, check account connection status, or simulate bot output.\n' +
      '3. Never tell the user their account is "not connected" — you have no way to check that.\n' +
      '4. When a user describes a strategy they want to create, guide them to use /strategy_create ' +
      '   (the bot wizard will collect all parameters). Do NOT simulate running it yourself.\n' +
      '5. For any action (place order, create strategy, check balance), tell the user which bot command to use.\n' +
      '\n' +
      'Available bot commands: /market, /vol, /suggest, /portfolio, /balance, /positions, /orders, ' +
      '/strategy_create, /strategies, /connect, /api_create.\n\n' +
      'Format responses using Telegram Markdown v1 only: *bold* for emphasis, `backticks` for numbers/code. ' +
      'Do NOT use ** double asterisks, # headings, MarkdownV2 syntax, or markdown tables (| col |) — Telegram does not render them. For tabular data use a triple-backtick code block with space-padded columns instead.',
    ];

    if (context?.marketConditions?.length) {
      const mc = context.marketConditions
        .filter((c) => c.indexPrice > 0)
        .map((c) =>
          `${c.currency}: price=$${c.indexPrice.toLocaleString()} DVOL=${c.dvolIndex?.toFixed(1) ?? 'n/a'} ` +
          `IVR=${c.ivRank?.toFixed(0) ?? 'n/a'}/100 IV/RV=${c.ivOverRv?.toFixed(2) ?? 'n/a'}`,
        )
        .join('; ');
      systemParts.push(`\nCurrent market snapshot: ${mc}`);
    }

    if (context?.activeStrategies?.length) {
      const strats = context.activeStrategies
        .map((s) => `${s.name} (${s.type}, ${s.status}, ${s.allocationBtc} BTC)`)
        .join('; ');
      systemParts.push(`\nUser's active strategies: ${strats}`);
    } else if (context?.activeStrategies) {
      systemParts.push('\nUser has no active strategies yet.');
    }

    try {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: systemParts.join(''),
        messages: conversationHistory,
      });

      const text = response.content.find((c) => c.type === 'text') as
        | Anthropic.TextBlock
        | undefined;
      return text?.text ?? 'Unable to generate a response. Please try again.';
    } catch (error) {
      this.logger.error(`Failed to generate AI response: ${error.message}`);
      return 'Unable to generate a response. Please try again.';
    }
  }
}
