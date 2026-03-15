import { createHash, randomBytes } from 'node:crypto';

export function generateManagementKey(): string {
  return `sk-mgmt-${crypto.randomUUID()}`;
}

export function generateProvisionedKey(): string {
  return `sk-prov-${randomBytes(16).toString('hex')}`;
}

export function computeKeyHash(keyValue: string): string {
  return createHash('sha256').update(keyValue).digest('hex').slice(0, 16);
}

export function generateDeviceCode(): string {
  return randomBytes(20).toString('hex');
}

export function generateUserCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  const bytes = randomBytes(8);
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function generateTransactionId(): string {
  return `txn_${crypto.randomUUID()}`;
}
