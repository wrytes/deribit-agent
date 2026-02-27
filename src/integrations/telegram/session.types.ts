import { Context } from 'telegraf';

export interface TelegramSession {
  pendingAction?: {
    type: string;
    step?: string;
    data?: Record<string, any>;
  };
}

export interface TelegramContext extends Context {
  session: TelegramSession;
}
