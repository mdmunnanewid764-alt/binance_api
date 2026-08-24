import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabaseService } from './supabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../../data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const initialData = {
  users: {},
  orders: {},
  webhooks: [],
  refunds: {},
  telegramUsers: {},
};

class Database {
  constructor() {
    this.data = this.load();
  }

  load() {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        return { ...initialData, ...JSON.parse(raw) };
      }
    } catch (err) {
      console.error('Error loading local DB, initializing fresh:', err.message);
    }
    return { ...initialData };
  }

  save() {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('Error saving DB:', err.message);
    }
  }

  // --- Users ---
  createUser(user) {
    const id = user.id || `usr_${Date.now()}`;
    const newUser = {
      id,
      email: user.email.toLowerCase(),
      name: user.name || 'Merchant',
      passwordHash: user.passwordHash,
      binanceConfig: user.binanceConfig || {
        apiKey: '',
        secretKey: '',
        merchantId: '',
        subMerchantId: '',
        isConnected: false,
      },
      telegramConfig: user.telegramConfig || {
        botToken: '',
        botUsername: '',
        isActive: false,
        products: [
          { id: 'prod_1', name: '⚡ 1-Month VIP Subscription', amount: '5.00', currency: 'USDT', desc: 'Access to premium group' },
          { id: 'prod_2', name: '🚀 1-Year VIP Access', amount: '45.00', currency: 'USDT', desc: 'Full 365-day access' },
        ],
      },
      gatewayApiKey: user.gatewayApiKey || `bg_live_${Buffer.from(id).toString('hex').slice(0, 16)}`,
      gatewayApiSecret: user.gatewayApiSecret || `sec_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.data.users[id] = newUser;
    this.save();

    // Async sync to Supabase
    if (supabaseService.isAvailable()) {
      supabaseService.createUser(newUser).catch(e => console.warn('Supabase sync user error:', e.message));
    }

    return newUser;
  }

  getUserById(id) {
    return this.data.users[id] || null;
  }

  getUserByEmail(email) {
    if (!email) return null;
    return Object.values(this.data.users).find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
  }

  getUserByApiKey(apiKey) {
    if (!apiKey) return null;
    return Object.values(this.data.users).find(u => u.gatewayApiKey === apiKey) || null;
  }

  updateUser(id, updates) {
    if (!this.data.users[id]) return null;
    this.data.users[id] = {
      ...this.data.users[id],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.save();

    if (supabaseService.isAvailable()) {
      supabaseService.updateUser(id, updates).catch(e => console.warn('Supabase update user error:', e.message));
    }

    return this.data.users[id];
  }

  listUsers() {
    return Object.values(this.data.users);
  }

  // --- Orders ---
  createOrder(order) {
    this.data.orders[order.merchantTradeNo] = {
      ...order,
      userId: order.userId || null,
      status: order.status || 'INITIAL',
      createdAt: order.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.save();

    if (supabaseService.isAvailable()) {
      supabaseService.createOrder(this.data.orders[order.merchantTradeNo]).catch(e => console.warn('Supabase order sync error:', e.message));
    }

    return this.data.orders[order.merchantTradeNo];
  }

  getOrder(merchantTradeNo) {
    return this.data.orders[merchantTradeNo] || null;
  }

  getOrderByPrepayId(prepayId) {
    return Object.values(this.data.orders).find(o => o.prepayId === prepayId) || null;
  }

  updateOrder(merchantTradeNo, updates) {
    if (!this.data.orders[merchantTradeNo]) return null;
    this.data.orders[merchantTradeNo] = {
      ...this.data.orders[merchantTradeNo],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.save();

    if (supabaseService.isAvailable()) {
      supabaseService.updateOrder(merchantTradeNo, updates).catch(e => console.warn('Supabase order update sync error:', e.message));
    }

    return this.data.orders[merchantTradeNo];
  }

  listOrders(limit = 50, offset = 0, userId = null) {
    let list = Object.values(this.data.orders);
    if (userId) {
      list = list.filter(o => o.userId === userId);
    }
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return {
      total: list.length,
      orders: list.slice(offset, offset + limit),
    };
  }

  // --- Webhooks ---
  logWebhook(event) {
    this.data.webhooks.unshift({
      ...event,
      receivedAt: new Date().toISOString(),
    });
    if (this.data.webhooks.length > 500) {
      this.data.webhooks.pop();
    }
    this.save();

    if (supabaseService.isAvailable()) {
      supabaseService.logWebhook(event).catch(e => console.warn('Supabase webhook sync error:', e.message));
    }
  }

  getWebhookLogs(limit = 20) {
    return this.data.webhooks.slice(0, limit);
  }

  // --- Refunds ---
  saveRefund(refund) {
    this.data.refunds[refund.refundRequestId] = {
      ...refund,
      createdAt: new Date().toISOString(),
    };
    this.save();
    return this.data.refunds[refund.refundRequestId];
  }

  getRefund(refundRequestId) {
    return this.data.refunds[refundRequestId] || null;
  }

  // --- Telegram Users ---
  saveTelegramUser(chatId, userData) {
    this.data.telegramUsers[chatId] = {
      ...(this.data.telegramUsers[chatId] || {}),
      ...userData,
      lastSeen: new Date().toISOString(),
    };
    this.save();
    return this.data.telegramUsers[chatId];
  }

  getTelegramUser(chatId) {
    return this.data.telegramUsers[chatId] || null;
  }
}

export const db = new Database();
