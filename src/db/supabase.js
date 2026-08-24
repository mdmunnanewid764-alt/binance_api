import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { config } from '../config/env.js';

const { Pool } = pg;

class SupabaseService {
  constructor() {
    this.client = null;
    this.pgPool = null;
    this.isConnected = false;
    this.isPgDirect = false;
    this.init();
  }

  async init() {
    // 1. Try Direct PostgreSQL connection if DATABASE_URL is provided
    if (config.databaseUrl && config.databaseUrl.includes('postgres')) {
      try {
        this.pgPool = new Pool({
          connectionString: config.databaseUrl,
          ssl: { rejectUnauthorized: false },
        });

        const client = await this.pgPool.connect();
        this.isConnected = true;
        this.isPgDirect = true;
        client.release();
        console.log('⚡ Connected directly to Supabase PostgreSQL Database (Cloud)!');

        await this.autoMigratePg();
        return;
      } catch (err) {
        console.warn('⚠️ Direct PostgreSQL connection failed, trying Supabase REST client:', err.message);
      }
    }

    // 2. Try Supabase JS / REST Client
    if (config.supabase.url && config.supabase.serviceRoleKey) {
      try {
        this.client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        this.isConnected = true;
        this.isPgDirect = false;
        console.log('⚡ Connected to Supabase via REST Client!');
      } catch (err) {
        console.warn('⚠️ Supabase JS Client failed, using local DB:', err.message);
        this.isConnected = false;
      }
    }
  }

  async autoMigratePg() {
    if (!this.pgPool) return;
    try {
      await this.pgPool.query(`
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

        ALTER TABLE public.users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'MERCHANT';
        ALTER TABLE public.users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'PENDING_APPROVAL';
        ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT false;
        ALTER TABLE public.users ADD COLUMN IF NOT EXISTS crypto_wallets JSONB DEFAULT '{}'::jsonb;
        ALTER TABLE public.users ADD COLUMN IF NOT EXISTS binance_config JSONB DEFAULT '{}'::jsonb;
        ALTER TABLE public.users ADD COLUMN IF NOT EXISTS telegram_config JSONB DEFAULT '{}'::jsonb;

        CREATE TABLE IF NOT EXISTS public.orders (
          merchant_trade_no TEXT PRIMARY KEY,
          user_id TEXT,
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
        ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_user_id_fkey;

        CREATE TABLE IF NOT EXISTS public.webhooks_log (
          id BIGSERIAL PRIMARY KEY,
          headers JSONB,
          body JSONB,
          received_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS public.telegram_users (
          chat_id TEXT PRIMARY KEY,
          username TEXT,
          first_name TEXT,
          last_name TEXT,
          merchant_id TEXT,
          last_seen TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      console.log('✅ Supabase PostgreSQL schema verified & auto-migrated successfully.');
    } catch (err) {
      console.warn('Auto-migration notice:', err.message);
    }
  }

  isAvailable() {
    return this.isConnected && (!!this.client || !!this.pgPool);
  }

  // --- Hydration / Sync on Startup ---
  async fetchAllData() {
    if (!this.isAvailable()) return null;

    const result = { users: {}, orders: {}, webhooks: [], telegramUsers: {} };

    try {
      if (this.isPgDirect && this.pgPool) {
        const uRes = await this.pgPool.query('SELECT * FROM public.users');
        uRes.rows.forEach(r => {
          const u = this.mapUser(r);
          result.users[u.id] = u;
        });

        const oRes = await this.pgPool.query('SELECT * FROM public.orders');
        oRes.rows.forEach(r => {
          const o = this.mapOrder(r);
          result.orders[o.merchantTradeNo] = o;
        });

        const tRes = await this.pgPool.query('SELECT * FROM public.telegram_users');
        tRes.rows.forEach(r => {
          result.telegramUsers[r.chat_id] = {
            chatId: r.chat_id,
            username: r.username,
            firstName: r.first_name,
            lastName: r.last_name,
            merchantId: r.merchant_id,
            lastSeen: r.last_seen,
          };
        });

        console.log(`📦 Hydrated from Supabase Cloud: ${Object.keys(result.users).length} Users, ${Object.keys(result.orders).length} Orders`);
        return result;
      }

      if (this.client) {
        const { data: uData } = await this.client.from('users').select('*');
        (uData || []).forEach(r => {
          const u = this.mapUser(r);
          result.users[u.id] = u;
        });

        const { data: oData } = await this.client.from('orders').select('*');
        (oData || []).forEach(r => {
          const o = this.mapOrder(r);
          result.orders[o.merchantTradeNo] = o;
        });

        return result;
      }
    } catch (err) {
      console.warn('Supabase fetchAllData notice:', err.message);
    }
    return null;
  }

  // --- Users ---
  async createUser(user) {
    if (!this.isAvailable()) return null;

    if (this.isPgDirect && this.pgPool) {
      try {
        const query = `
          INSERT INTO public.users (
            id, email, name, password_hash, role, status, is_approved, crypto_wallets, binance_config, telegram_config, gateway_api_key, gateway_api_secret, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          ON CONFLICT (email) DO UPDATE SET
            name = EXCLUDED.name,
            password_hash = EXCLUDED.password_hash,
            role = EXCLUDED.role,
            status = EXCLUDED.status,
            is_approved = EXCLUDED.is_approved,
            crypto_wallets = EXCLUDED.crypto_wallets,
            binance_config = EXCLUDED.binance_config,
            telegram_config = EXCLUDED.telegram_config,
            gateway_api_key = COALESCE(public.users.gateway_api_key, EXCLUDED.gateway_api_key),
            gateway_api_secret = COALESCE(public.users.gateway_api_secret, EXCLUDED.gateway_api_secret),
            updated_at = EXCLUDED.updated_at
          RETURNING *;
        `;
        const res = await this.pgPool.query(query, [
          user.id,
          user.email.toLowerCase(),
          user.name,
          user.passwordHash,
          user.role || 'MERCHANT',
          user.status || 'PENDING_APPROVAL',
          user.isApproved || false,
          JSON.stringify(user.cryptoWallets || {}),
          JSON.stringify(user.binanceConfig || {}),
          JSON.stringify(user.telegramConfig || {}),
          user.gatewayApiKey,
          user.gatewayApiSecret,
          user.createdAt,
          user.updatedAt,
        ]);
        return this.mapUser(res.rows[0]);
      } catch (err) {
        console.warn('PG createUser error:', err.message);
        return null;
      }
    }

    if (this.client) {
      const dbPayload = {
        id: user.id,
        email: user.email.toLowerCase(),
        name: user.name,
        password_hash: user.passwordHash,
        role: user.role || 'MERCHANT',
        status: user.status || 'PENDING_APPROVAL',
        is_approved: user.isApproved || false,
        crypto_wallets: user.cryptoWallets || {},
        binance_config: user.binanceConfig || {},
        telegram_config: user.telegramConfig || {},
        gateway_api_key: user.gatewayApiKey,
        gateway_api_secret: user.gatewayApiSecret,
        created_at: user.createdAt,
        updated_at: user.updatedAt,
      };
      const { data } = await this.client.from('users').upsert(dbPayload).select().single();
      return this.mapUser(data);
    }
    return null;
  }

  async updateUser(id, updates) {
    if (!this.isAvailable()) return null;

    if (this.isPgDirect && this.pgPool) {
      try {
        const fields = [];
        const values = [];
        let idx = 1;

        if (updates.name) { fields.push(`name = $${idx++}`); values.push(updates.name); }
        if (updates.role) { fields.push(`role = $${idx++}`); values.push(updates.role); }
        if (updates.status) { fields.push(`status = $${idx++}`); values.push(updates.status); }
        if (updates.isApproved !== undefined) { fields.push(`is_approved = $${idx++}`); values.push(updates.isApproved); }
        if (updates.cryptoWallets) { fields.push(`crypto_wallets = $${idx++}`); values.push(JSON.stringify(updates.cryptoWallets)); }
        if (updates.binanceConfig) { fields.push(`binance_config = $${idx++}`); values.push(JSON.stringify(updates.binanceConfig)); }
        if (updates.telegramConfig) { fields.push(`telegram_config = $${idx++}`); values.push(JSON.stringify(updates.telegramConfig)); }
        if (updates.gatewayApiKey) { fields.push(`gateway_api_key = $${idx++}`); values.push(updates.gatewayApiKey); }
        if (updates.gatewayApiSecret) { fields.push(`gateway_api_secret = $${idx++}`); values.push(updates.gatewayApiSecret); }
        fields.push(`updated_at = $${idx++}`); values.push(new Date().toISOString());

        values.push(id);
        const query = `UPDATE public.users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *;`;
        const res = await this.pgPool.query(query, values);
        return this.mapUser(res.rows[0]);
      } catch (e) { return null; }
    }

    if (this.client) {
      const payload = {};
      if (updates.name) payload.name = updates.name;
      if (updates.role) payload.role = updates.role;
      if (updates.status) payload.status = updates.status;
      if (updates.isApproved !== undefined) payload.is_approved = updates.isApproved;
      if (updates.cryptoWallets) payload.crypto_wallets = updates.cryptoWallets;
      if (updates.binanceConfig) payload.binance_config = updates.binanceConfig;
      if (updates.telegramConfig) payload.telegram_config = updates.telegramConfig;
      if (updates.gatewayApiKey) payload.gateway_api_key = updates.gatewayApiKey;
      if (updates.gatewayApiSecret) payload.gateway_api_secret = updates.gatewayApiSecret;
      payload.updated_at = new Date().toISOString();

      const { data } = await this.client.from('users').update(payload).eq('id', id).select().single();
      return this.mapUser(data);
    }
    return null;
  }

  // --- Orders ---
  async createOrder(order) {
    if (!this.isAvailable()) return null;

    if (this.isPgDirect && this.pgPool) {
      try {
        const query = `
          INSERT INTO public.orders (
            merchant_trade_no, user_id, prepay_id, order_amount, currency, goods_name, goods_detail,
            status, biz_status, paid_network, crypto_wallets, transaction_id, terminal_type, checkout_url,
            qrcode_link, deeplink, universal_url, expire_time, metadata, mock, paid_at, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
          ON CONFLICT (merchant_trade_no) DO UPDATE SET
            status = EXCLUDED.status,
            biz_status = EXCLUDED.biz_status,
            paid_network = EXCLUDED.paid_network,
            transaction_id = EXCLUDED.transaction_id,
            paid_at = EXCLUDED.paid_at,
            updated_at = EXCLUDED.updated_at
          RETURNING *;
        `;
        const res = await this.pgPool.query(query, [
          order.merchantTradeNo,
          order.userId || null,
          order.prepayId || null,
          parseFloat(order.orderAmount),
          order.currency || 'USDT',
          order.goodsName,
          order.goodsDetail || '',
          order.status || 'INITIAL',
          order.bizStatus || null,
          order.paidNetwork || null,
          JSON.stringify(order.cryptoWallets || {}),
          order.transactionId || null,
          order.terminalType || 'WEB',
          order.checkoutUrl || null,
          order.qrcodeLink || null,
          order.deeplink || null,
          order.universalUrl || null,
          order.expireTime || null,
          JSON.stringify(order.metadata || {}),
          !!order.mock,
          order.paidAt || null,
          order.createdAt,
          order.updatedAt,
        ]);
        return this.mapOrder(res.rows[0]);
      } catch (err) {
        console.warn('PG createOrder notice:', err.message);
        try {
          const retryRes = await this.pgPool.query(query, [
            order.merchantTradeNo,
            null,
            order.prepayId || null,
            parseFloat(order.orderAmount),
            order.currency || 'USDT',
            order.goodsName,
            order.goodsDetail || '',
            order.status || 'INITIAL',
            order.bizStatus || null,
            order.paidNetwork || null,
            JSON.stringify(order.cryptoWallets || {}),
            order.transactionId || null,
            order.terminalType || 'WEB',
            order.checkoutUrl || null,
            order.qrcodeLink || null,
            order.deeplink || null,
            order.universalUrl || null,
            order.expireTime || null,
            JSON.stringify(order.metadata || {}),
            !!order.mock,
            order.paidAt || null,
            order.createdAt,
            order.updatedAt,
          ]);
          return this.mapOrder(retryRes.rows[0]);
        } catch (retryErr) {
          return null;
        }
      }
    }

    if (this.client) {
      const dbPayload = {
        merchant_trade_no: order.merchantTradeNo,
        user_id: order.userId || null,
        prepay_id: order.prepayId,
        order_amount: parseFloat(order.orderAmount),
        currency: order.currency || 'USDT',
        goods_name: order.goodsName,
        goods_detail: order.goodsDetail,
        status: order.status || 'INITIAL',
        paid_network: order.paidNetwork || null,
        crypto_wallets: order.cryptoWallets || {},
        checkout_url: order.checkoutUrl,
        created_at: order.createdAt,
        updated_at: order.updatedAt,
      };
      const { data } = await this.client.from('orders').upsert(dbPayload).select().single();
      return this.mapOrder(data);
    }
    return null;
  }

  async updateOrder(merchantTradeNo, updates) {
    if (!this.isAvailable()) return null;

    if (this.isPgDirect && this.pgPool) {
      try {
        const fields = [];
        const values = [];
        let idx = 1;

        if (updates.status) { fields.push(`status = $${idx++}`); values.push(updates.status); }
        if (updates.bizStatus) { fields.push(`biz_status = $${idx++}`); values.push(updates.bizStatus); }
        if (updates.paidNetwork) { fields.push(`paid_network = $${idx++}`); values.push(updates.paidNetwork); }
        if (updates.transactionId) { fields.push(`transaction_id = $${idx++}`); values.push(updates.transactionId); }
        if (updates.paidAt) { fields.push(`paid_at = $${idx++}`); values.push(updates.paidAt); }
        fields.push(`updated_at = $${idx++}`); values.push(new Date().toISOString());

        values.push(merchantTradeNo);
        const query = `UPDATE public.orders SET ${fields.join(', ')} WHERE merchant_trade_no = $${idx} RETURNING *;`;
        const res = await this.pgPool.query(query, values);
        return this.mapOrder(res.rows[0]);
      } catch (e) { return null; }
    }
    return null;
  }

  // --- Webhooks & Telegram ---
  async logWebhook(event) {
    if (!this.isAvailable()) return;
    try {
      if (this.isPgDirect && this.pgPool) {
        await this.pgPool.query('INSERT INTO public.webhooks_log (headers, body) VALUES ($1, $2)', [
          JSON.stringify(event.headers || {}),
          JSON.stringify(event.body || {}),
        ]);
      }
    } catch (e) {}
  }

  // --- Mappers ---
  mapUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      passwordHash: row.password_hash,
      role: row.role || 'MERCHANT',
      status: row.status || 'PENDING_APPROVAL',
      isApproved: row.is_approved !== false,
      cryptoWallets: typeof row.crypto_wallets === 'string' ? JSON.parse(row.crypto_wallets) : (row.crypto_wallets || {}),
      binanceConfig: typeof row.binance_config === 'string' ? JSON.parse(row.binance_config) : (row.binance_config || {}),
      telegramConfig: typeof row.telegram_config === 'string' ? JSON.parse(row.telegram_config) : (row.telegram_config || {}),
      gatewayApiKey: row.gateway_api_key,
      gatewayApiSecret: row.gateway_api_secret,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  mapOrder(row) {
    if (!row) return null;
    return {
      merchantTradeNo: row.merchant_trade_no,
      userId: row.user_id,
      prepayId: row.prepay_id,
      orderAmount: row.order_amount ? String(row.order_amount) : '0.00',
      currency: row.currency || 'USDT',
      goodsName: row.goods_name,
      goodsDetail: row.goods_detail,
      status: row.status,
      bizStatus: row.biz_status,
      paidNetwork: row.paid_network,
      cryptoWallets: typeof row.crypto_wallets === 'string' ? JSON.parse(row.crypto_wallets) : (row.crypto_wallets || {}),
      transactionId: row.transaction_id,
      terminalType: row.terminal_type,
      checkoutUrl: row.checkout_url,
      qrcodeLink: row.qrcode_link,
      deeplink: row.deeplink,
      universalUrl: row.universal_url,
      expireTime: row.expire_time,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}),
      mock: row.mock,
      paidAt: row.paid_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export const supabaseService = new SupabaseService();
