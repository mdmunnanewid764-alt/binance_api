import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import { supabaseService } from './supabase.js';
import { config } from '../config/env.js';

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
    this.seedAdmin();
    this.hydrateFromSupabase();
  }

  async hydrateFromSupabase() {
    try {
      const cloudData = await supabaseService.fetchAllData();
      if (cloudData) {
        this.data.users = { ...this.data.users, ...cloudData.users };
        this.data.orders = { ...this.data.orders, ...cloudData.orders };
        if (cloudData.telegramUsers) {
          this.data.telegramUsers = { ...this.data.telegramUsers, ...cloudData.telegramUsers };
        }
        this.save();
      }
    } catch (err) {
      console.warn('Supabase cloud hydration notice:', err.message);
    }
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

  seedAdmin() {
    const adminEmail = config.admin.email;
    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(config.admin.password, salt);
    const existing = Object.values(this.data.users).find(u => u.email.toLowerCase() === adminEmail.toLowerCase());

    if (!existing) {
      const adminId = 'admin_root';
      this.data.users[adminId] = {
        id: adminId,
        email: adminEmail,
        name: 'Super Admin',
        role: 'ADMIN',
        status: 'ACTIVE',
        isApproved: true,
        passwordHash,
        binanceConfig: { apiKey: '', secretKey: '', isConnected: false },
        cryptoWallets: {
          bep20: '0x386Ac338C488F61a9B4810fe17Fa2a78BE456108',
          trc20: 'TYasdf123456789TronUSDTAddress9988',
          erc20: '0x386Ac338C488F61a9B4810fe17Fa2a78BE456108',
        },
        telegramConfig: { botToken: '', isActive: false, products: [] },
        gatewayApiKey: 'bg_live_super_admin',
        gatewayApiSecret: 'sec_admin_root_key',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.save();
      console.log(`👑 Super Admin account initialized: ${adminEmail}`);
    } else {
      existing.passwordHash = passwordHash;
      existing.role = 'ADMIN';
      existing.status = 'ACTIVE';
      existing.isApproved = true;
      if (!existing.cryptoWallets) {
        existing.cryptoWallets = {
          bep20: '',
          trc20: '',
          erc20: '',
        };
      }
      existing.updatedAt = new Date().toISOString();
      this.save();
      console.log(`👑 Super Admin account synced: ${adminEmail}`);
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
      role: user.role || 'MERCHANT',
      status: user.status || 'PENDING_APPROVAL',
      isApproved: user.isApproved || false,
      binanceConfig: user.binanceConfig || {
        apiKey: '',
        secretKey: '',
        merchantId: '',
        subMerchantId: '',
        isConnected: false,
      },
      cryptoWallets: user.cryptoWallets || {
        bep20: '', // BNB Smart Chain (BEP20 USDT)
        trc20: '', // TRON (TRC20 USDT)
        erc20: '', // Ethereum (ERC20 USDT)
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

  approveUser(id) {
    return this.updateUser(id, {
      status: 'ACTIVE',
      isApproved: true,
      approvedAt: new Date().toISOString(),
    });
  }

  rejectUser(id) {
    return this.updateUser(id, {
      status: 'REJECTED',
      isApproved: false,
      rejectedAt: new Date().toISOString(),
    });
  }

  deleteUser(id) {
    if (this.data.users[id]) {
      delete this.data.users[id];
      this.save();
      return true;
    }
    return false;
  }

  listUsers() {
    return Object.values(this.data.users).sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  // --- Orders ---
  createOrder(order) {
    this.data.orders[order.merchantTradeNo] = {
      ...order,
      userId: order.userId || null,
      cryptoWallets: order.cryptoWallets || {
        bep20: '',
        trc20: '',
        erc20: '',
      },
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
