import { registerAs } from '@nestjs/config';

export default registerAs('app', () => {
	const nodeEnv = process.env.NODE_ENV || 'development';
	const isDevelopment = nodeEnv === 'development';
	const port = parseInt(process.env.PORT || '3030', 10);
	const host = process.env.HOST || 'localhost';

	const protocol = isDevelopment ? 'http' : 'https';
	const baseUrl = isDevelopment
		? `${protocol}://${host}:${port}`
		: `${protocol}://${host}`;

	return {
		nodeEnv,
		port,
		apiKeySecret: process.env.API_KEY_SECRET,
		isDevelopment,
		isProduction: nodeEnv === 'production',
		isTest: nodeEnv === 'test',
		baseUrl,
		host,
	};
});
