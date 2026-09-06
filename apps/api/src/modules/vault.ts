/**
 * Secret Vault (Phase 9) — encrypted at rest with AES-256-GCM.
 *
 * The master key comes from INTEGRATION_VAULT_KEY (base64, 32 bytes) or is
 * auto-generated on first use and stored 0600 at <dataDir>/vault.key — so a
 * default install is protected without config, and production can pin the key
 * via env (e.g. docker-compose). Ciphertext format: base64(iv).base64(tag).
 * base64(payload). Plaintext never touches the database.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';

let cachedKey: Buffer | null = null;

function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const env = process.env.INTEGRATION_VAULT_KEY;
  if (env) {
    const k = Buffer.from(env, 'base64');
    if (k.length !== 32) throw new Error('INTEGRATION_VAULT_KEY must be base64 of 32 bytes');
    cachedKey = k;
    return k;
  }
  // auto-generate + persist (dev default; pin via env in production)
  const file = path.join(config.dataDir, 'vault.key');
  if (fs.existsSync(file)) {
    const k = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (k.length === 32) { cachedKey = k; return k; }
    throw new Error(`vault key file ${file} is malformed (expected base64 of 32 bytes)`);
  }
  const k = crypto.randomBytes(32);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file, k.toString('base64'), { mode: 0o600 });
  cachedKey = k;
  return k;
}

/** Encrypt a secret string → "iv.tag.payload" (all base64url segments). */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const payload = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${payload.toString('base64')}`;
}

/** Decrypt "iv.tag.payload" back to the plaintext; throws on tamper. */
export function decryptSecret(ciphertext: string): string {
  const [ivB64, tagB64, payloadB64] = ciphertext.split('.');
  if (!ivB64 || !tagB64 || !payloadB64) throw new Error('malformed ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(payloadB64, 'base64')), decipher.final()]).toString('utf8');
}

/** True when a master key already exists (no auto-generation side effect). */
export function vaultKeyExists(): boolean {
  if (process.env.INTEGRATION_VAULT_KEY) return true;
  return fs.existsSync(path.join(config.dataDir, 'vault.key'));
}

/** TEST ONLY: reset the cached key (so tests can pin their own). */
export function __resetVaultKeyForTests(): void { cachedKey = null; }
