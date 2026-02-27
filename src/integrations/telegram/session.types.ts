import { Context } from 'telegraf';

export interface TelegramSession {
  pendingAction?: {
    type: string;
    step?: string;
    data?: Record<string, any>;
  };
  askHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface TelegramContext extends Context {
  session: TelegramSession;
}
