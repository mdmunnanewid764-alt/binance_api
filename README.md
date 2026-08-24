# 🟡 Binance Pay Gateway Payment Web API Service & Telegram Bot

A complete, production-ready payment gateway service integrating **Binance Pay OpenAPI v2/v3**, featuring a **RESTful Web API**, **Hosted Checkout UI** with live payment detection (SSE), **Binance IPN Webhook verification**, and an **Interactive Telegram Bot**.

---

## 🌟 Key Features

- **Binance Pay v2/v3 OpenAPI Integration**:
  - HMAC-SHA512 request signing (`BinancePay-Timestamp`, `BinancePay-Nonce`, `BinancePay-Certificate-SN`, `BinancePay-Signature`).
  - Webhook (IPN) signature verification with replay-attack protection.
  - Multi-currency support (`USDT`, `BUSD`, `BNB`, `BTC`, `ETH`, `EUR`, etc.).
  - Direct Binance App deep-linking (`bnc://app.binance.com/...`) & universal QR codes.
- **Hosted Checkout Page**:
  - Clean, dark-themed responsive UI.
  - Instant QR code rendering.
  - Real-time payment detection using Server-Sent Events (SSE) (no refreshing required!).
- **Interactive Telegram Bot**:
  - Sell items & subscriptions inside Telegram chats or channels.
  - Generates instant Binance Pay invoices with scanable QR codes.
  - Sends immediate payment receipt notifications directly to the buyer's Telegram chat upon webhook confirmation.
- **Sandbox / Mock Mode**:
  - Out of the box, you can test end-to-end checkout, payments, and Telegram bot flows without requiring real money or live API keys!
- **Demo Store & Playground**:
  - Interactive web store at `/demo` to test checkout flows, simulated payments, and order tracking.

---

## 📁 Project Structure

```
.
├── src/
│   ├── bot/
│   │   └── telegramBot.js      # Telegram Bot engine with products & payment notifications
│   ├── config/
│   │   └── env.js              # Environment variable configurations
│   ├── db/
│   │   └── database.js         # Lightweight database for orders, transactions & users
│   ├── routes/
│   │   └── paymentRoutes.js    # Express REST API endpoints & SSE stream
│   ├── services/
│   │   ├── binancePay.js       # Binance Pay HMAC signer, webhook verifier & API client
│   │   └── eventEmitter.js     # Pub/sub event broker for live SSE & bot triggers
│   └── server.js               # Main Express application entry point
├── public/
│   ├── checkout.html           # Hosted responsive Binance Pay checkout UI
│   └── demo.html               # Demo Web Store & API Playground
├── tests/
│   ├── api.test.js             # REST API & Webhook integration tests
│   └── binancePay.test.js      # HMAC signing & webhook verification tests
├── package.json
└── .env.example
```

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Create a `.env` file (or copy `.env.example`):
```env
PORT=3000
BASE_URL=http://localhost:3000

# Binance Pay Merchant Credentials (Optional for testing, required for live production)
BINANCE_PAY_API_KEY=your_binance_pay_api_key
BINANCE_PAY_SECRET_KEY=your_binance_pay_secret_key
BINANCE_PAY_BASE_URL=https://bpay.binanceapi.com

# Webhook Callback URL
WEBHOOK_URL=http://localhost:3000/api/v1/payments/webhook

# Mock Mode (Set to true to test without live Binance keys)
MOCK_MODE=true

# Telegram Bot Token (Optional: Get from @BotFather)
TELEGRAM_BOT_TOKEN=
```

### 3. Run the Server
```bash
# Development mode with auto-reload
npm run dev

# Or standard start
npm start
```

### 4. Open the Web Demo Store
Navigate to:
```
http://localhost:3000/demo
```

---

## 🤖 Connecting the Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts to get your **Bot Token**.
3. Open your `.env` and set:
   ```env
   TELEGRAM_BOT_TOKEN=123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ
   ```
4. Restart the server (`npm start`).
5. Open your Telegram bot and send `/start` or `/products` to test purchasing via Binance Pay!

---

## 📡 REST API Reference

### 1. Create Payment Order
`POST /api/v1/payments/create`

**Request Body:**
```json
{
  "orderAmount": "10.00",
  "currency": "USDT",
  "goodsName": "1-Month VIP Subscription",
  "goodsDetail": "Access to VIP members group",
  "merchantTradeNo": "ORDER_1700000000",
  "metadata": {
    "userId": "user_123",
    "telegramChatId": "987654321"
  }
}
```

**Response (`201 Created`):**
```json
{
  "success": true,
  "message": "Payment order created successfully",
  "order": {
    "merchantTradeNo": "ORDER_1700000000",
    "prepayId": "293847298374",
    "orderAmount": "10.00",
    "currency": "USDT",
    "goodsName": "1-Month VIP Subscription",
    "status": "INITIAL"
  },
  "paymentData": {
    "merchantTradeNo": "ORDER_1700000000",
    "prepayId": "293847298374",
    "hostedCheckoutUrl": "http://localhost:3000/checkout/ORDER_1700000000",
    "checkoutUrl": "https://pay.binance.com/...",
    "deeplink": "bnc://app.binance.com/payment/secPay?prepayId=...",
    "universalUrl": "https://app.binance.com/qr/dplk...",
    "expireTime": 1700003600000
  }
}
```

---

### 2. Query Order Status
`GET /api/v1/payments/:merchantTradeNo`

**Response (`200 OK`):**
```json
{
  "success": true,
  "order": {
    "merchantTradeNo": "ORDER_1700000000",
    "orderAmount": "10.00",
    "currency": "USDT",
    "status": "PAID",
    "transactionId": "tx_987654321",
    "paidAt": "2026-08-24T18:25:00.000Z"
  }
}
```

---

### 3. Binance Pay Webhook (IPN)
`POST /api/v1/payments/webhook`

Binance Pay calls this endpoint when a payment status changes.

**Headers sent by Binance:**
- `BinancePay-Timestamp`: Current UTC millisecond timestamp
- `BinancePay-Nonce`: 32-character random string
- `BinancePay-Certificate-SN`: Merchant API Key
- `BinancePay-Signature`: UpperCase HMAC-SHA512 signature

**Binance Webhook Payload:**
```json
{
  "bizType": "PAY",
  "bizIdStr": "123456789",
  "bizStatus": "PAY_SUCCESS",
  "data": "{\"merchantTradeNo\":\"ORDER_1700000000\",\"totalFee\":\"10.00\",\"currency\":\"USDT\"}"
}
```

---

### 4. Real-time Status Stream (SSE)
`GET /api/v1/payments/stream/:merchantTradeNo`

Connects via `EventSource` on the client side to receive real-time push events when the order transitions to `PAID`.

---

### 5. Refund Order
`POST /api/v1/payments/refund`

**Request Body:**
```json
{
  "merchantTradeNo": "ORDER_1700000000",
  "refundAmount": "10.00",
  "refundReason": "Customer requested cancellation"
}
```

---

## 🧪 Running Automated Tests

Run the full suite of unit and integration tests:
```bash
npm test
```

Test coverage includes:
- ✅ Binance Pay HMAC-SHA512 signature generation
- ✅ Binance Pay Webhook signature verification & replay-attack prevention
- ✅ Order creation, retrieval, and status management
- ✅ Simulated payments and webhook triggers
- ✅ Refund processing
