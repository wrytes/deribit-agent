import { SetMetadata } from '@nestjs/common';
import { ApiKeyScope } from '@prisma/client';

export const SCOPES_KEY = 'scopes';
export const RequireScopes = (...scopes: ApiKeyScope[]) =>
  SetMetadata(SCOPES_KEY, scopes);
