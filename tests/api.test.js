import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/server.js';
import axios from 'axios';
import { db } from '../src/db/database.js';
import { binancePayService } from '../src/services/binancePay.js';

let serverInstance;
let baseUrl;

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

test('GET /api/v1/health - Service health check', async () => {
  const res = await axios.get(`${baseUrl}/api/v1/health`);
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'OK');
  assert.equal(res.data.service, 'Binance Pay Payment Gateway');
});

test('POST /api/v1/payments/create - Create payment order', async () => {
  const tradeNo = `TEST_ORD_${Date.now()}`;
  const res = await axios.post(`${baseUrl}/api/v1/payments/create`, {
    merchantTradeNo: tradeNo,
    orderAmount: '15.50',
    currency: 'USDT',
    goodsName: 'Premium Subscription',
  });

  assert.equal(res.status, 201);
  assert.equal(res.data.success, true);
  assert.equal(res.data.order.merchantTradeNo, tradeNo);
  assert.equal(res.data.order.orderAmount, '15.50');
  assert.equal(res.data.order.currency, 'USDT');
  assert.equal(res.data.order.status, 'INITIAL');
  assert.ok(res.data.paymentData.hostedCheckoutUrl);
});

test('GET /api/v1/payments/:orderId - Query order', async () => {
  const tradeNo = `QUERY_TEST_${Date.now()}`;
  await axios.post(`${baseUrl}/api/v1/payments/create`, {
    merchantTradeNo: tradeNo,
    orderAmount: '20.00',
    currency: 'USDT',
    goodsName: 'Query Test Product',
  });

  const res = await axios.get(`${baseUrl}/api/v1/payments/${tradeNo}`);
  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.equal(res.data.order.merchantTradeNo, tradeNo);
  assert.equal(res.data.order.status, 'INITIAL');
});

test('POST /api/v1/payments/mock-pay/:orderId - Test simulation payment', async () => {
  const tradeNo = `MOCK_TEST_${Date.now()}`;
  await axios.post(`${baseUrl}/api/v1/payments/create`, {
    merchantTradeNo: tradeNo,
    orderAmount: '50.00',
    currency: 'USDT',
    goodsName: 'Mock Payment Product',
  });

  const payRes = await axios.post(`${baseUrl}/api/v1/payments/mock-pay/${tradeNo}`);
  assert.equal(payRes.status, 200);
  assert.equal(payRes.data.success, true);
  assert.equal(payRes.data.order.status, 'PAID');

  // Verify in DB
  const updatedOrder = db.getOrder(tradeNo);
  assert.equal(updatedOrder.status, 'PAID');
});

test('POST /api/v1/payments/webhook - Process Binance Pay IPN webhook', async () => {
  const tradeNo = `WEBHOOK_TEST_${Date.now()}`;
  await axios.post(`${baseUrl}/api/v1/payments/create`, {
    merchantTradeNo: tradeNo,
    orderAmount: '75.00',
    currency: 'USDT',
    goodsName: 'Webhook Test Product',
  });

  const timestamp = Date.now().toString();
  const nonce = binancePayService.generateNonce(32);
  const webhookBody = {
    bizType: 'PAY',
    bizIdStr: 'tx_998877',
    bizStatus: 'PAY_SUCCESS',
    data: JSON.stringify({
      merchantTradeNo: tradeNo,
      totalFee: '75.00',
      currency: 'USDT',
      transactionId: 'tx_998877',
    }),
  };

  const webhookRes = await axios.post(`${baseUrl}/api/v1/payments/webhook`, webhookBody, {
    headers: {
      'Content-Type': 'application/json',
      'BinancePay-Timestamp': timestamp,
      'BinancePay-Nonce': nonce,
      'BinancePay-Certificate-SN': 'test_cert_sn',
      'BinancePay-Signature': 'MOCK_SIGNATURE',
    },
  });

  assert.equal(webhookRes.status, 200);
  assert.equal(webhookRes.data.returnCode, 'SUCCESS');

  const order = db.getOrder(tradeNo);
  assert.equal(order.status, 'PAID');
  assert.equal(order.transactionId, 'tx_998877');
});

test('POST /api/v1/payments/refund - Refund paid order', async () => {
  const tradeNo = `REFUND_TEST_${Date.now()}`;
  await axios.post(`${baseUrl}/api/v1/payments/create`, {
    merchantTradeNo: tradeNo,
    orderAmount: '30.00',
    currency: 'USDT',
    goodsName: 'Refund Test Product',
  });

  // Mark as paid first
  await axios.post(`${baseUrl}/api/v1/payments/mock-pay/${tradeNo}`);

  const refundRes = await axios.post(`${baseUrl}/api/v1/payments/refund`, {
    merchantTradeNo: tradeNo,
    refundReason: 'Customer return',
  });

  assert.equal(refundRes.status, 200);
  assert.equal(refundRes.data.success, true);
  assert.equal(refundRes.data.refund.merchantTradeNo, tradeNo);

  const order = db.getOrder(tradeNo);
  assert.equal(order.status, 'REFUNDED');
});
