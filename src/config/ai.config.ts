import { registerAs } from '@nestjs/config';

export default registerAs('ai', () => ({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
}));
