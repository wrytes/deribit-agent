import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ApiKey } from '@prisma/client';

export const ApiKeyDecorator = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): ApiKey => {
    const request = ctx.switchToHttp().getRequest();
    return request.apiKey;
  },
);
