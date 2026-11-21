import { handleNimiWebCoordination } from '@nimiplatform/app-tools/web/coordination';

export async function onRequest(context: {
  request: Request;
  env: Record<string, string | undefined>;
}): Promise<Response> {
  return handleNimiWebCoordination(context);
}
