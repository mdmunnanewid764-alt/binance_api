import test from 'node:test';
import assert from 'node:assert/strict';
import { binancePayService } from '../src/services/binancePay.js';

test('BinancePayService - Nonce generation', () => {
  const nonce = binancePayService.generateNonce(32);
  assert.equal(nonce.length, 32);
  assert.match(nonce, /^[a-zA-Z0-9]+$/);
});

test('BinancePayService - HMAC-SHA512 signature building', () => {
  const timestamp = '1600000000000';
  const nonce = 'abcdefghijklmnopqrstuvwxyz123456';
  const body = JSON.stringify({ merchantTradeNo: 'TEST_001', orderAmount: '10.00' });
  const secretKey = 'test_secret_key_123';

  const sig1 = binancePayService.buildSignature(timestamp, nonce, body, secretKey);
  const sig2 = binancePayService.buildSignature(timestamp, nonce, body, secretKey);

  assert.equal(typeof sig1, 'string');
  assert.equal(sig1.length, 128); // SHA-512 hex length is 128 chars
  assert.equal(sig1, sig2); // Deterministic
  assert.equal(sig1, sig1.toUpperCase()); // Binance requires uppercase hex
});

test('BinancePayService - Webhook signature verification', () => {
  const secretKey = 'merchant_secret_abc';
  binancePayService.secretKey = secretKey;

  const timestamp = Date.now().toString();
  const nonce = binancePayService.generateNonce(32);
  const rawBody = JSON.stringify({
    bizType: 'PAY',
    bizIdStr: '987654321',
    bizStatus: 'PAY_SUCCESS',
    data: '{"merchantTradeNo":"ORDER_TEST_123","totalFee":"25.00","currency":"USDT"}',
  });

  const validSignature = binancePayService.buildSignature(timestamp, nonce, rawBody, secretKey);

  const validHeaders = {
    'binancepay-timestamp': timestamp,
    'binancepay-nonce': nonce,
    'binancepay-signature': validSignature,
    'binancepay-certificate-sn': 'merchant_api_key_xyz',
  };

  // Valid webhook
  const validRes = binancePayService.verifyWebhook(validHeaders, rawBody);
  assert.equal(validRes.isValid, true);

  // Tampered payload
  const tamperedBody = JSON.stringify({ ...JSON.parse(rawBody), bizStatus: 'TAMPERED' });
  const tamperedRes = binancePayService.verifyWebhook(validHeaders, tamperedBody);
  assert.equal(tamperedRes.isValid, false);

  // Expired timestamp (e.g. 10 minutes ago)
  const expiredHeaders = {
    ...validHeaders,
    'binancepay-timestamp': (Date.now() - 600000).toString(),
  };
  const expiredRes = binancePayService.verifyWebhook(expiredHeaders, rawBody);
  assert.equal(expiredRes.isValid, false);
});
