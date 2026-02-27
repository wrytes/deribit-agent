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
          'Do NOT use ** double asterisks, # headings, or any other markdown syntax. ' +
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
   * Answer a trading question with optional conversation history.
   */
  async ask(
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<string> {
    try {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system:
          'You are a knowledgeable Deribit trading assistant. Help users understand their portfolio, ' +
          'trading strategies, options, perpetuals, margin, and Deribit-specific concepts. ' +
          'Be concise and practical. Available bot commands: /portfolio, /positions, /orders, /balance, /ask, /connect, /api_create. ' +
          'Format responses using Telegram Markdown v1 only: *bold* for emphasis, `backticks` for code/values. ' +
          'Do NOT use ** double asterisks, # headings, or any other markdown syntax.',
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
