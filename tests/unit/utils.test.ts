import { describe, it, expect } from 'bun:test';
import {
  generateManagementKey,
  generateProvisionedKey,
  computeKeyHash,
  generateDeviceCode,
  generateUserCode,
  generateTransactionId,
} from '../../src/utils/token';
import { hashPassword, verifyPassword } from '../../src/utils/password';

describe('Token utilities', () => {
  it('generateManagementKey returns sk-mgmt- format', () => {
    const key = generateManagementKey();
    expect(key).toMatch(/^sk-mgmt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('generateProvisionedKey returns sk-prov- format with 32 hex', () => {
    const key = generateProvisionedKey();
    expect(key).toMatch(/^sk-prov-[0-9a-f]{32}$/);
  });

  it('computeKeyHash returns 16 hex chars', () => {
    const hash = computeKeyHash('sk-prov-abcdef1234567890abcdef1234567890');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('computeKeyHash is deterministic for same input', () => {
    const input = 'sk-prov-test123';
    expect(computeKeyHash(input)).toBe(computeKeyHash(input));
  });

  it('generateDeviceCode returns unique values', () => {
    const a = generateDeviceCode();
    const b = generateDeviceCode();
    expect(a).not.toBe(b);
    expect(a.length).toBe(40);
  });

  it('generateUserCode returns XXXX-XXXX format', () => {
    const code = generateUserCode();
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('generateTransactionId returns txn_ format', () => {
    const id = generateTransactionId();
    expect(id).toMatch(/^txn_[0-9a-f-]{36}$/);
  });
});

describe('Password utilities', () => {
  it('hashPassword returns bcrypt hash', async () => {
    const hash = await hashPassword('TestPass123!');
    expect(hash).toMatch(/^\$2/);
  });

  it('verifyPassword returns true for correct password', async () => {
    const hash = await hashPassword('TestPass123!');
    expect(await verifyPassword('TestPass123!', hash)).toBe(true);
  });

  it('verifyPassword returns false for wrong password', async () => {
    const hash = await hashPassword('TestPass123!');
    expect(await verifyPassword('WrongPass', hash)).toBe(false);
  });
});
