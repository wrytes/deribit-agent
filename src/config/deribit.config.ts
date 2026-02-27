import { registerAs } from '@nestjs/config';

export default registerAs('deribit', () => ({
  clientId: process.env.DERIBIT_CLIENT_ID || '',
  clientSecret: process.env.DERIBIT_CLIENT_SECRET || '',
  baseUrl: process.env.DERIBIT_BASE_URL || 'wss://www.deribit.com/ws/api/v2',
}));
