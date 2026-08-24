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
    // 1. Try Direct PostgreSQL connection if DATABASE_URL is given
    if (config.databaseUrl && config.databaseUrl.includes('postgres')) {
      try {
        this.pgPool = new Pool({
          connectionString: config.databaseUrl,
          ssl: { rejectUnauthorized: false },
        });

        // Test connection
        const client = await this.pgPool.connect();
        this.isConnected = true;
        this.isPgDirect = true;
        client.release();
        console.log('⚡ Connected directly to Supabase PostgreSQL Database!');

        // Run auto-migration
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
          binance_config JSONB DEFAULT '{}'::jsonb,
          telegram_config JSONB DEFAULT '{}'::jsonb,
          gateway_api_key TEXT UNIQUE,
          gateway_api_secret TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
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
        CREATE TABLE IF NOT EXISTS public.webhooks_log (
          id BIGSERIAL PRIMARY KEY,
          headers JSONB,
          body JSONB,
          received_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      console.log('✅ Supabase PostgreSQL tables verified/migrated successfully.');
    } catch (err) {
      console.warn('Auto-migration notice:', err.message);
    }
  }

  isAvailable() {
    return this.isConnected && (!!this.client || !!this.pgPool);
  }

  // --- Users ---
  async createUser(user) {
    if (!this.isAvailable()) return null;

    if (this.isPgDirect && this.pgPool) {
      try {
        const query = `
          INSERT INTO public.users (id, email, name, password_hash, binance_config, telegram_config, gateway_api_key, gateway_api_secret, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (id) DO NOTHING
          RETURNING *;
        `;
        const res = await this.pgPool.query(query, [
          user.id,
          user.email.toLowerCase(),
          user.name,
          user.passwordHash,
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
        binance_config: user.binanceConfig,
        telegram_config: user.telegramConfig,
        gateway_api_key: user.gatewayApiKey,
        gateway_api_secret: user.gatewayApiSecret,
        created_at: user.createdAt,
        updated_at: user.updatedAt,
      };
      const { data, error } = await this.client.from('users').insert(dbPayload).select().single();
      if (error) return null;
      return this.mapUser(data);
    }
    return null;
  }

  async getUserById(id) {
    if (!this.isAvailable()) return null;
    if (this.isPgDirect && this.pgPool) {
      try {
        const res = await this.pgPool.query('SELECT * FROM public.users WHERE id = $1', [id]);
        return this.mapUser(res.rows[0]);
      } catch (e) { return null; }
    }
    if (this.client) {
      const { data, error } = await this.client.from('users').select('*').eq('id', id).single();
      if (error || !data) return null;
      return this.mapUser(data);
    }
    return null;
  }

  async getUserByEmail(email) {
    if (!this.isAvailable()) return null;
    if (this.isPgDirect && this.pgPool) {
      try {
        const res = await this.pgPool.query('SELECT * FROM public.users WHERE LOWER(email) = LOWER($1)', [email]);
        return this.mapUser(res.rows[0]);
      } catch (e) { return null; }
    }
    if (this.client) {
      const { data, error } = await this.client.from('users').select('*').eq('email', email.toLowerCase()).single();
      if (error || !data) return null;
      return this.mapUser(data);
    }
    return null;
  }

  async getUserByApiKey(apiKey) {
    if (!this.isAvailable()) return null;
    if (this.isPgDirect && this.pgPool) {
      try {
        const res = await this.pgPool.query('SELECT * FROM public.users WHERE gateway_api_key = $1', [apiKey]);
        return this.mapUser(res.rows[0]);
      } catch (e) { return null; }
    }
    if (this.client) {
      const { data, error } = await this.client.from('users').select('*').eq('gateway_api_key', apiKey).single();
      if (error || !data) return null;
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
      if (updates.binanceConfig) payload.binance_config = updates.binanceConfig;
      if (updates.telegramConfig) payload.telegram_config = updates.telegramConfig;
      if (updates.gatewayApiKey) payload.gateway_api_key = updates.gatewayApiKey;
      if (updates.gatewayApiSecret) payload.gateway_api_secret = updates.gatewayApiSecret;
      payload.updated_at = new Date().toISOString();

      const { data, error } = await this.client.from('users').update(payload).eq('id', id).select().single();
      if (error || !data) return null;
      return this.mapUser(data);
    }
    return null;
  }

  mapUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      passwordHash: row.password_hash,
      binanceConfig: typeof row.binance_config === 'string' ? JSON.parse(row.binance_config) : (row.binance_config || {}),
      telegramConfig: typeof row.telegram_config === 'string' ? JSON.parse(row.telegram_config) : (row.telegram_config || {}),
      gatewayApiKey: row.gateway_api_key,
      gatewayApiSecret: row.gateway_api_secret,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // --- Orders ---
  async createOrder(order) {
    if (!this.isAvailable()) return null;
    if (this.isPgDirect && this.pgPool) {
      try {
        const query = `
          INSERT INTO public.orders (
            merchant_trade_no, user_id, prepay_id, order_amount, currency, goods_name, goods_detail,
            status, terminal_type, checkout_url, qrcode_link, deeplink, universal_url, expire_time,
            metadata, mock, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
          ON CONFLICT (merchant_trade_no) DO NOTHING
          RETURNING *;
        `;
        const res = await this.pgPool.query(query, [
          order.merchantTradeNo, order.userId || null, order.prepayId, order.orderAmount,
          order.currency, order.goodsName, order.goodsDetail, order.status, order.terminalType,
          order.checkoutUrl, order.qrcodeLink, order.deeplink, order.universalUrl, order.expireTime,
          JSON.stringify(order.metadata || {}), order.mock, order.createdAt, order.updatedAt,
        ]);
        return this.mapOrder(res.rows[0]);
      } catch (err) { return null; }
    }

    if (this.client) {
      const dbPayload = {
        merchant_trade_no: order.merchantTradeNo,
        user_id: order.userId || null,
        prepay_id: order.prepayId,
        order_amount: order.orderAmount,
        currency: order.currency,
        goods_name: order.goodsName,
        goods_detail: order.goodsDetail,
        status: order.status,
        terminal_type: order.terminalType,
        checkout_url: order.checkoutUrl,
        qrcode_link: order.qrcodeLink,
        deeplink: order.deeplink,
        universal_url: order.universalUrl,
        expire_time: order.expireTime,
        metadata: order.metadata,
        mock: order.mock,
        created_at: order.createdAt,
        updated_at: order.updatedAt,
      };
      const { data } = await this.client.from('orders').insert(dbPayload).select().single();
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
        if (updates.transactionId) { fields.push(`transaction_id = $${idx++}`); values.push(updates.transactionId); }
        if (updates.paidAt) { fields.push(`paid_at = $${idx++}`); values.push(updates.paidAt); }
        fields.push(`updated_at = $${idx++}`); values.push(new Date().toISOString());

        values.push(merchantTradeNo);
        const query = `UPDATE public.orders SET ${fields.join(', ')} WHERE merchant_trade_no = $${idx} RETURNING *;`;
        const res = await this.pgPool.query(query, values);
        return this.mapOrder(res.rows[0]);
      } catch (e) { return null; }
    }

    if (this.client) {
      const payload = {};
      if (updates.status) payload.status = updates.status;
      if (updates.bizStatus) payload.biz_status = updates.bizStatus;
      if (updates.transactionId) payload.transaction_id = updates.transactionId;
      if (updates.paidAt) payload.paid_at = updates.paidAt;
      payload.updated_at = new Date().toISOString();
      const { data } = await this.client.from('orders').update(payload).eq('merchant_trade_no', merchantTradeNo).select().single();
      return this.mapOrder(data);
    }
    return null;
  }

  mapOrder(row) {
    if (!row) return null;
    return {
      merchantTradeNo: row.merchant_trade_no,
      userId: row.user_id,
      prepayId: row.prepay_id,
      orderAmount: row.order_amount,
      currency: row.currency,
      goodsName: row.goods_name,
      goodsDetail: row.goods_detail,
      status: row.status,
      bizStatus: row.biz_status,
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

  async logWebhook(event) {
    if (!this.isAvailable()) return;
    if (this.isPgDirect && this.pgPool) {
      try {
        await this.pgPool.query('INSERT INTO public.webhooks_log (headers, body) VALUES ($1, $2)', [
          JSON.stringify(event.headers || {}),
          JSON.stringify(event.body || {}),
        ]);
      } catch (e) {}
    } else if (this.client) {
      await this.client.from('webhooks_log').insert({
        headers: event.headers,
        body: event.body,
      });
    }
  }
}

export const supabaseService = new SupabaseService();
