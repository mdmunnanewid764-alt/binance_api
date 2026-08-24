import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/server.js';
import axios from 'axios';

let serverInstance;
let baseUrl;
let testUserToken;
let testGatewayApiKey;

before(async () => {
  return new Promise((resolve) => {
    serverInstance = app.listen(0, () => {
      const port = serverInstance.address().port;
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
});

after(async () => {
  if (serverInstance) {
    serverInstance.close();
  }
});

test('Auth - Register new merchant user', async () => {
  const email = `merchant_${Date.now()}@example.com`;
  const res = await axios.post(`${baseUrl}/api/v1/auth/register`, {
    name: 'Super Store',
    email,
    password: 'securepassword123',
  });

  assert.equal(res.status, 201);
  assert.equal(res.data.success, true);
  assert.ok(res.data.token);
  assert.equal(res.data.user.email, email);

  testUserToken = res.data.token;
  testGatewayApiKey = res.data.user.gatewayApiKey;
});

test('Auth - Login merchant user', async () => {
  const email = `login_test_${Date.now()}@example.com`;
  await axios.post(`${baseUrl}/api/v1/auth/register`, {
    name: 'Login User',
    email,
    password: 'mypassword123',
  });

  const res = await axios.post(`${baseUrl}/api/v1/auth/login`, {
    email,
    password: 'mypassword123',
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.ok(res.data.token);
});

test('Auth - GET /api/v1/auth/me', async () => {
  const res = await axios.get(`${baseUrl}/api/v1/auth/me`, {
    headers: { Authorization: `Bearer ${testUserToken}` },
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.ok(res.data.user.id);
});

test('Merchant - Connect Binance credentials', async () => {
  const res = await axios.post(
    `${baseUrl}/api/v1/merchant/binance`,
    {
      apiKey: 'mock_binance_key_123',
      secretKey: 'mock_binance_secret_456',
      merchantId: '987654321',
    },
    {
      headers: { Authorization: `Bearer ${testUserToken}` },
    }
  );

  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.equal(res.data.user.binanceConfig.apiKey, 'mock_binance_key_123');
});

test('Merchant - Test Binance credentials verification', async () => {
  const res = await axios.post(
    `${baseUrl}/api/v1/merchant/test-binance`,
    {
      apiKey: 'mock_binance_key_123',
      secretKey: 'mock_binance_secret_456',
    },
    {
      headers: { Authorization: `Bearer ${testUserToken}` },
    }
  );

  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
});

test('Merchant - Fetch Live Binance Wallet Balance', async () => {
  const res = await axios.get(`${baseUrl}/api/v1/merchant/binance-balance`, {
    headers: { Authorization: `Bearer ${testUserToken}` },
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.ok(res.data.balances);
  assert.ok(res.data.totalEstimatedUSDT);
});

test('Merchant - Fetch Live Binance Transactions', async () => {
  const res = await axios.get(`${baseUrl}/api/v1/merchant/binance-transactions`, {
    headers: { Authorization: `Bearer ${testUserToken}` },
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.ok(Array.isArray(res.data.transactions));
});

test('Merchant - Check Database Cloud Status', async () => {
  const res = await axios.get(`${baseUrl}/api/v1/merchant/database-status`, {
    headers: { Authorization: `Bearer ${testUserToken}` },
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.ok(res.data.storageType);
});

test('Merchant - Connect Telegram Bot and Products', async () => {
  const res = await axios.post(
    `${baseUrl}/api/v1/merchant/telegram-bot`,
    {
      botToken: '',
      isActive: true,
      products: [
        { id: 'p1', name: 'VIP Pass', amount: '12.00', currency: 'USDT' },
      ],
    },
    {
      headers: { Authorization: `Bearer ${testUserToken}` },
    }
  );

  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.equal(res.data.user.telegramConfig.products.length, 1);
});

test('Merchant - Generate Gateway API Keys', async () => {
  const res = await axios.post(
    `${baseUrl}/api/v1/merchant/generate-api-keys`,
    {},
    {
      headers: { Authorization: `Bearer ${testUserToken}` },
    }
  );

  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.ok(res.data.gatewayApiKey.startsWith('bg_live_'));
  testGatewayApiKey = res.data.gatewayApiKey;
});

test('Payment - Create order using Merchant x-api-key', async () => {
  const tradeNo = `MERCHANT_ORD_${Date.now()}`;
  const res = await axios.post(
    `${baseUrl}/api/v1/payments/create`,
    {
      merchantTradeNo: tradeNo,
      orderAmount: '45.00',
      currency: 'USDT',
      goodsName: 'Store Checkout Item',
    },
    {
      headers: { 'x-api-key': testGatewayApiKey },
    }
  );

  assert.equal(res.status, 201);
  assert.equal(res.data.success, true);
  assert.equal(res.data.order.merchantTradeNo, tradeNo);
});

test('Merchant - GET /api/v1/merchant/stats', async () => {
  const res = await axios.get(`${baseUrl}/api/v1/merchant/stats`, {
    headers: { Authorization: `Bearer ${testUserToken}` },
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.ok(res.data.stats.totalOrders >= 1);
});
