import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { PrismaService } from './core/database/prisma.service';

async function bootstrap() {
	const app = await NestFactory.create(AppModule, {
		bufferLogs: true,
	});

	const configService = app.get(ConfigService);

	const logger = app.get(Logger);
	app.useLogger(logger);

	app.enableCors({
		origin: '*',
		methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
		credentials: true,
	});

	app.useGlobalPipes(
		new ValidationPipe({
			whitelist: true,
			transform: true,
			forbidNonWhitelisted: true,
			transformOptions: {
				enableImplicitConversion: true,
			},
		}),
	);

	app.useGlobalFilters(new AllExceptionsFilter());

	const prismaService = app.get(PrismaService);
	await prismaService.enableShutdownHooks(app);

	const config = new DocumentBuilder()
		.setTitle('Deribit Bot API')
		.setDescription(
			'REST API for Deribit trading integration.\n\n' +
				'## Authentication\n' +
				'All endpoints (except /auth/verify) require API key authentication.\n' +
				'Include the `X-API-Key` header with format: `rw_prod_{keyId}.{secret}`\n\n' +
				'## Getting Started\n' +
				'1. Use Telegram bot `/api_create` to generate magic link\n' +
				'2. Visit magic link to retrieve API key\n' +
				'3. Use API key in `X-API-Key` header for all requests\n' +
				'4. Use Telegram bot `/connect` or `POST /deribit-account` to set Deribit credentials',
		)
		.setVersion('1.0.0')
		.addApiKey(
			{
				type: 'apiKey',
				name: 'x-api-key',
				in: 'header',
				description: 'API key in format: rw_prod_{keyId}.{secret}',
			},
			'api-key',
		)
		.addSecurityRequirements('api-key')
		.addTag('auth', 'API key management and verification')
		.addTag('deribit-account', 'Deribit credential management')
		.addTag('account', 'Deribit account data')
		.addTag('trading', 'Deribit trading operations')
		.addTag('data', 'Historical data ingestion and management')
		.addTag('training', 'ML model training sessions')
		.addTag('agent', 'Live and paper trading agent runs')
		.addTag('misc', 'Health check, root, Telegram webhook')
		.build();

	const document = SwaggerModule.createDocument(app, config);
	SwaggerModule.setup('api/docs', app, document, {
		customSiteTitle: 'Deribit Bot - API Docs',
		customCss: '.swagger-ui .topbar { display: none }',
		swaggerOptions: {
			persistAuthorization: true,
			docExpansion: 'none',
			filter: true,
			showRequestDuration: true,
		},
	});

	const port = configService.get<number>('app.port', 3030);
	const baseUrl = configService.get<string>('app.baseUrl');

	await app.listen(port);

	logger.log(`Application is running on: ${baseUrl}`);
	logger.log(`API Documentation: ${baseUrl}/api/docs`);
	logger.log(`Health check: ${baseUrl}/health`);
	logger.log(`Environment: ${configService.get('app.nodeEnv')}`);
}

bootstrap().catch((error) => {
	console.error('Failed to start application:', error);
	process.exit(1);
});
