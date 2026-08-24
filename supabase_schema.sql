-- =======================================================
-- Supabase Schema for Binance Pay Gateway & Multi-Merchant Platform
-- Copy & Run this SQL in your Supabase SQL Editor
-- =======================================================

-- 1. Create Users Table
CREATE TABLE IF NOT EXISTS public.users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  binance_config JSONB DEFAULT '{"apiKey":"","secretKey":"","merchantId":"","subMerchantId":"","isConnected":false}'::jsonb,
  telegram_config JSONB DEFAULT '{"botToken":"","botUsername":"","isActive":false,"products":[]}'::jsonb,
  gateway_api_key TEXT UNIQUE,
  gateway_api_secret TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create Orders Table
CREATE TABLE IF NOT EXISTS public.orders (
  merchant_trade_no TEXT PRIMARY KEY,
  user_id TEXT REFERENCES public.users(id) ON DELETE SET NULL,
  prepay_id TEXT,
  order_amount NUMERIC(18, 4) NOT NULL,
  currency TEXT DEFAULT 'USDT',
  goods_name TEXT NOT NULL,
  goods_detail TEXT,
  status TEXT DEFAULT 'INITIAL', -- INITIAL, PENDING, PAID, CANCELED, EXPIRED, REFUNDED
  biz_status TEXT,
  transaction_id TEXT,
  terminal_type TEXT DEFAULT 'WEB',
  checkout_url TEXT,
  qrcode_link TEXT,
  deeplink TEXT,
  universal_url TEXT,
  expire_time BIGINT,
  metadata JSONB DEFAULT '{}'::jsonb,
  payer_info JSONB,
  payment_details JSONB,
  refund_info JSONB,
  mock BOOLEAN DEFAULT false,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Create Webhooks Log Table
CREATE TABLE IF NOT EXISTS public.webhooks_log (
  id BIGSERIAL PRIMARY KEY,
  headers JSONB,
  body JSONB,
  received_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Create Refunds Table
CREATE TABLE IF NOT EXISTS public.refunds (
  refund_request_id TEXT PRIMARY KEY,
  merchant_trade_no TEXT REFERENCES public.orders(merchant_trade_no) ON DELETE CASCADE,
  prepay_id TEXT,
  refund_amount NUMERIC(18, 4),
  currency TEXT DEFAULT 'USDT',
  refund_reason TEXT,
  response JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Create Telegram Users Table
CREATE TABLE IF NOT EXISTS public.telegram_users (
  chat_id TEXT PRIMARY KEY,
  merchant_id TEXT,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  last_seen TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for high performance
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON public.orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_api_key ON public.users(gateway_api_key);
