import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const readRecord = async (file: string): Promise<Record<string, unknown>> => {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

/** Credentials are used only on a loopback listener owned by our parent host. */
export const localAuthHeaders = async (
  origin: string,
  parentPorts: ReadonlySet<number>,
  signal: AbortSignal,
): Promise<Record<string, string>> => {
  const url = new URL(origin);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return {};
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!parentPorts.has(port)) return {};

  const dataDir = process.env.OPENCHAMBER_DATA_DIR || path.join(os.homedir(), '.config', 'openchamber');
  const instance = await readRecord(path.join(dataDir, 'run', `openchamber-${port}.json`));
  if (typeof instance.uiPassword === 'string' && instance.uiPassword) {
    try {
      const response = await fetch(new URL('/auth/session', origin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ password: instance.uiPassword }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
        redirect: 'manual',
      });
      const cookie = response.headers.get('set-cookie')?.match(/(?:^|,\s*)(oc_ui_session(?:_\d+)?=[^;]+)/)?.[1];
      await response.body?.cancel();
      if (response.ok && cookie) return { Cookie: cookie };
    } catch {
      // A missing or unavailable login can still use the desktop credential.
    }
  }
  const settings = await readRecord(path.join(dataDir, 'settings.json'));
  if (settings.desktopLocalPort === port && typeof settings.desktopLocalClientToken === 'string'
    && settings.desktopLocalClientToken) {
    return { Authorization: `Bearer ${settings.desktopLocalClientToken}` };
  }
  return {};
};
