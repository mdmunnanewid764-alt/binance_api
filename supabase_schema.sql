-- ==========================================================
-- Binance Pay Payment Gateway & Multi-Chain (Supabase Schema)
-- Project Ref: ogfmjifaxvndydwnjvps
-- ==========================================================

-- 1. Users Table (Merchants & Admin)
CREATE TABLE IF NOT EXISTS public.users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'MERCHANT',
  status TEXT DEFAULT 'PENDING_APPROVAL',
  is_approved BOOLEAN DEFAULT false,
  crypto_wallets JSONB DEFAULT '{}'::jsonb,
  binance_config JSONB DEFAULT '{}'::jsonb,
  telegram_config JSONB DEFAULT '{}'::jsonb,
  gateway_api_key TEXT UNIQUE,
  gateway_api_secret TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure columns exist if table was already created
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'MERCHANT';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'PENDING_APPROVAL';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT false;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS crypto_wallets JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS binance_config JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS telegram_config JSONB DEFAULT '{}'::jsonb;

-- 2. Orders Table (Binance Pay, BEP20, TRC20, ERC20)
CREATE TABLE IF NOT EXISTS public.orders (
  merchant_trade_no TEXT PRIMARY KEY,
  user_id TEXT REFERENCES public.users(id) ON DELETE SET NULL,
  prepay_id TEXT,
  order_amount NUMERIC(18, 4) NOT NULL,
  currency TEXT DEFAULT 'USDT',
  goods_name TEXT NOT NULL,
  goods_detail TEXT,
  status TEXT DEFAULT 'INITIAL',
  biz_status TEXT,
  paid_network TEXT,
  crypto_wallets JSONB DEFAULT '{}'::jsonb,
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

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS paid_network TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS crypto_wallets JSONB DEFAULT '{}'::jsonb;

-- 3. Webhook Events Log
CREATE TABLE IF NOT EXISTS public.webhooks_log (
  id BIGSERIAL PRIMARY KEY,
  headers JSONB,
  body JSONB,
  received_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Telegram Users
CREATE TABLE IF NOT EXISTS public.telegram_users (
  chat_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  merchant_id TEXT,
  last_seen TIMESTAMPTZ DEFAULT NOW()
);

-- Indices for rapid queries
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON public.orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);
CREATE INDEX IF NOT EXISTS idx_users_api_key ON public.users(gateway_api_key);
