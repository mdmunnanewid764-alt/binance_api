import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/server.js';
import { config } from '../src/config/env.js';
import axios from 'axios';

let serverInstance;
let baseUrl;
let adminToken;
let pendingUserId;
let approvedMerchantToken;
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

test('Auth - Super Admin Login', async () => {
  const res = await axios.post(`${baseUrl}/api/v1/auth/login`, {
    email: config.admin.email,
    password: config.admin.password,
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.equal(res.data.user.role, 'ADMIN');
  assert.ok(res.data.token);
  adminToken = res.data.token;
});

test('Auth - Register new merchant (Requires Admin Approval)', async () => {
  const email = `merchant_${Date.now()}@example.com`;
  const res = await axios.post(`${baseUrl}/api/v1/auth/register`, {
    name: 'Pending Super Store',
    email,
    password: 'securepassword123',
  });

  assert.equal(res.status, 201);
  assert.equal(res.data.success, true);
  assert.equal(res.data.pendingApproval, true);
  assert.equal(res.data.user.status, 'PENDING_APPROVAL');
  assert.equal(res.data.user.isApproved, false);

  pendingUserId = res.data.user.id;

  // Attempt login BEFORE approval -> MUST FAIL WITH 403
  try {
    await axios.post(`${baseUrl}/api/v1/auth/login`, {
      email,
      password: 'securepassword123',
    });
    assert.fail('Should have failed login because user is not yet approved');
  } catch (err) {
    assert.equal(err.response.status, 403);
    assert.equal(err.response.data.pendingApproval, true);
  }
});

test('Admin - List users and Approve pending merchant', async () => {
  const usersRes = await axios.get(`${baseUrl}/api/v1/admin/users`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  assert.equal(usersRes.status, 200);
  assert.equal(usersRes.data.success, true);
  const found = usersRes.data.users.find(u => u.id === pendingUserId);
  assert.ok(found);
  assert.equal(found.status, 'PENDING_APPROVAL');

  // Approve user
  const approveRes = await axios.post(
    `${baseUrl}/api/v1/admin/approve/${pendingUserId}`,
    {},
    {
      headers: { Authorization: `Bearer ${adminToken}` },
    }
  );

  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.data.success, true);
  assert.equal(approveRes.data.user.status, 'ACTIVE');
  assert.equal(approveRes.data.user.isApproved, true);
});

test('Auth - Merchant Login AFTER Admin Approval (Succeeds)', async () => {
  const usersRes = await axios.get(`${baseUrl}/api/v1/admin/users`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const approvedUser = usersRes.data.users.find(u => u.id === pendingUserId);

  const res = await axios.post(`${baseUrl}/api/v1/auth/login`, {
    email: approvedUser.email,
    password: 'securepassword123',
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.ok(res.data.token);
  assert.equal(res.data.user.status, 'ACTIVE');

  approvedMerchantToken = res.data.token;
  testGatewayApiKey = res.data.user.gatewayApiKey;
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
      headers: { Authorization: `Bearer ${approvedMerchantToken}` },
    }
  );

  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.equal(res.data.user.binanceConfig.apiKey, 'mock_binance_key_123');
});

test('Merchant - Fetch Live Binance Wallet Balance', async () => {
  const res = await axios.get(`${baseUrl}/api/v1/merchant/binance-balance`, {
    headers: { Authorization: `Bearer ${approvedMerchantToken}` },
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.ok(res.data.balances);
  assert.ok(res.data.totalEstimatedUSDT);
});

test('Merchant - Fetch Live Binance Transactions', async () => {
  const res = await axios.get(`${baseUrl}/api/v1/merchant/binance-transactions`, {
    headers: { Authorization: `Bearer ${approvedMerchantToken}` },
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.ok(Array.isArray(res.data.transactions));
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
      headers: { Authorization: `Bearer ${approvedMerchantToken}` },
    }
  );

  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.equal(res.data.user.telegramConfig.products.length, 1);
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
