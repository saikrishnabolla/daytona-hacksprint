import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function loadConfig() {
  const path = fileURLToPath(new URL('../.env.server', import.meta.url));
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_0-9]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (value) process.env[match[1]] = value;
  }
  return { ...process.env };
}

export function redact(value, config = process.env) {
  let result = String(value);
  for (const [key, secret] of Object.entries(config)) {
    if (/KEY|TOKEN|SECRET|PASSWORD/.test(key) && typeof secret === 'string' && secret.length > 7) result = result.split(secret).join('[redacted]');
  }
  return result.replace(/([?&](?:token|authorization|api_key)=)[^&\s]+/gi, '$1[redacted]');
}
