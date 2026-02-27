import { registerAs } from '@nestjs/config';

export default registerAs('telegram', () => ({
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  webhookDomain: process.env.TELEGRAM_WEBHOOK_DOMAIN,
  webhookPath: process.env.TELEGRAM_WEBHOOK_PATH || '/telegram/webhook',
  enabled: !!process.env.TELEGRAM_BOT_TOKEN,
}));
