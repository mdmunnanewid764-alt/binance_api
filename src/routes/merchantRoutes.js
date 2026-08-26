import express from 'express';
import { authenticateToken } from './authRoutes.js';
import { db } from '../db/database.js';
import { supabaseService } from '../db/supabase.js';
import { binancePayService } from '../services/binancePay.js';
import { botManager } from '../bot/botManager.js';
import crypto from 'crypto';

export const merchantRouter = express.Router();

// Apply auth middleware to all merchant routes
merchantRouter.use(authenticateToken);

/**
 * GET /api/v1/merchant/binance-balance
 * Fetch Live Binance Wallet Balance for the authenticated merchant
 */
merchantRouter.get('/binance-balance', async (req, res) => {
  try {
    const apiKey = req.user.binanceConfig?.apiKey;
    const secretKey = req.user.binanceConfig?.secretKey;

    const balanceData = await binancePayService.getAccountBalance(apiKey, secretKey);
    return res.json(balanceData);
  } catch (error) {
    console.error('Error fetching Binance balance:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/merchant/signed-binance-request
 * Generates HMAC signature for browser direct fetching (bypasses cloud host IP restrictions)
 */
merchantRouter.get('/signed-binance-request', async (req, res) => {
  try {
    const apiKey = req.user.binanceConfig?.apiKey;
    const secretKey = req.user.binanceConfig?.secretKey;

    if (!apiKey || !secretKey) {
      return res.json({ success: false, error: 'No Binance API keys configured' });
    }

    const timeOffset = await binancePayService.getServerTimeOffset();
    const timestamp = Date.now() + timeOffset;
    const recvWindow = 60000;
    const queryString = `timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = binancePayService.buildSpotSignature(queryString, secretKey);

    return res.json({
      success: true,
      apiKey,
      timestamp,
      queryString,
      signature,
      url: `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`,
    });
  } catch (error) {
    console.error('Error signing Binance request:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/merchant/binance-transactions
 * Fetch recent Binance wallet deposits & all verified payment gateway transactions
 */
merchantRouter.get('/binance-transactions', async (req, res) => {
  try {
    const apiKey = req.user.binanceConfig?.apiKey;
    const secretKey = req.user.binanceConfig?.secretKey;
    const isSuperAdmin = req.user.role === 'ADMIN';

    // 1. Gather all verified & paid gateway orders
    let allOrders = Object.values(db.data.orders || {});
    if (!isSuperAdmin) {
      allOrders = allOrders.filter(o => o.userId === req.user.id);
    }

    const gatewayTxList = allOrders
      .filter(o => o.status === 'PAID')
      .map(o => ({
        id: o.transactionId || o.prepayId || o.merchantTradeNo,
        type: o.paidNetwork ? `${o.paidNetwork}` : 'Binance Pay',
        asset: o.currency || 'USDT',
        amount: o.orderAmount,
        status: 'SUCCESS',
        time: o.paidAt || o.createdAt,
        goodsName: o.goodsName,
        tradeNo: o.merchantTradeNo,
      }));

    // 2. Fetch live Binance API deposits if configured
    let binanceApiDeposits = [];
    if (apiKey && secretKey) {
      try {
        const bRes = await binancePayService.getAccountTransactions(apiKey, secretKey);
        if (bRes.success && Array.isArray(bRes.transactions)) {
          binanceApiDeposits = bRes.transactions;
        }
      } catch (e) {}
    }

    // 3. Merge and deduplicate by transaction ID
    const txMap = new Map();
    gatewayTxList.forEach(t => {
      if (t.id) txMap.set(t.id, t);
    });
    binanceApiDeposits.forEach(t => {
      if (t.id) txMap.set(t.id, t);
    });

    const combinedList = Array.from(txMap.values()).sort((a, b) => 
      new Date(b.time).getTime() - new Date(a.time).getTime()
    );

    return res.json({
      success: true,
      realData: true,
      transactions: combinedList,
    });
  } catch (error) {
    console.error('Error fetching Binance transactions:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/merchant/database-status
 * Check if Supabase cloud is connected
 */
merchantRouter.get('/database-status', (req, res) => {
  return res.json({
    success: true,
    supabaseConnected: supabaseService.isAvailable(),
    storageType: supabaseService.isAvailable() ? 'Supabase PostgreSQL (Cloud)' : 'Local JSON/SQLite Storage',
  });
});

/**
 * POST /api/v1/merchant/binance
 * Connect or update Binance Merchant API keys
 */
merchantRouter.post('/binance', async (req, res) => {
  try {
    const { apiKey, secretKey, merchantId, subMerchantId } = req.body;

    const currentConfig = req.user.binanceConfig || {};
    const newConfig = {
      apiKey: apiKey !== undefined ? apiKey.trim() : (currentConfig.apiKey || ''),
      secretKey: secretKey !== undefined ? secretKey.trim() : (currentConfig.secretKey || ''),
      merchantId: merchantId !== undefined ? merchantId.trim() : (currentConfig.merchantId || ''),
      subMerchantId: subMerchantId !== undefined ? subMerchantId.trim() : (currentConfig.subMerchantId || ''),
      isConnected: !!((apiKey !== undefined ? apiKey.trim() : currentConfig.apiKey) && (secretKey !== undefined ? secretKey.trim() : currentConfig.secretKey)),
    };

    const updatedUser = db.updateUser(req.user.id, { binanceConfig: newConfig });

    const safeUser = { ...updatedUser };
    delete safeUser.passwordHash;

    return res.json({
      success: true,
      message: 'Binance Pay configuration updated successfully',
      user: safeUser,
    });
  } catch (error) {
    console.error('Error updating Binance config:', error);
    return res.status(500).json({ success: false, error: error.message || 'Server error' });
  }
});

/**
 * POST /api/v1/merchant/crypto-wallets
 * Save or update BEP20, TRC20, and ERC20 deposit addresses
 */
merchantRouter.post('/crypto-wallets', async (req, res) => {
  try {
    const { bep20, trc20, erc20 } = req.body;
    const currentWallets = req.user.cryptoWallets || {};

    const newWallets = {
      bep20: bep20 !== undefined ? bep20.trim() : (currentWallets.bep20 || ''),
      trc20: trc20 !== undefined ? trc20.trim() : (currentWallets.trc20 || ''),
      erc20: erc20 !== undefined ? erc20.trim() : (currentWallets.erc20 || ''),
    };

    const updatedUser = db.updateUser(req.user.id, { cryptoWallets: newWallets });
    const safeUser = { ...updatedUser };
    delete safeUser.passwordHash;

    return res.json({
      success: true,
      message: 'Crypto deposit addresses (BEP20, TRC20, ERC20) updated successfully',
      cryptoWallets: newWallets,
      user: safeUser,
    });
  } catch (error) {
    console.error('Error updating crypto wallets:', error);
    return res.status(500).json({ success: false, error: error.message || 'Server error' });
  }
});

/**
 * POST /api/v1/merchant/test-binance
 * Verify connected Binance API credentials
 */
merchantRouter.post('/test-binance', async (req, res) => {
  try {
    const { apiKey, secretKey } = req.body;
    const keyToTest = apiKey || req.user.binanceConfig?.apiKey;
    const secretToTest = secretKey || req.user.binanceConfig?.secretKey;

    if (!keyToTest || !secretToTest) {
      return res.status(400).json({
        success: false,
        error: 'No Binance API Key / Secret Key provided or configured.',
      });
    }

    const testRes = await binancePayService.testCredentials(keyToTest, secretToTest);

    if (testRes.success) {
      db.updateUser(req.user.id, {
        binanceConfig: {
          ...(req.user.binanceConfig || {}),
          apiKey: keyToTest,
          secretKey: secretToTest,
          isConnected: true,
        },
      });
    }

    return res.json(testRes);
  } catch (error) {
    console.error('Test Binance error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Verification failed' });
  }
});

/**
 * POST /api/v1/merchant/generate-api-keys
 * Regenerate Gateway API Key & Secret for website integration
 */
merchantRouter.post('/generate-api-keys', (req, res) => {
  try {
    const gatewayApiKey = `bg_live_${crypto.randomBytes(8).toString('hex')}`;
    const gatewayApiSecret = `sec_${crypto.randomBytes(16).toString('hex')}`;

    const updatedUser = db.updateUser(req.user.id, {
      gatewayApiKey,
      gatewayApiSecret,
    });

    const safeUser = { ...updatedUser };
    delete safeUser.passwordHash;

    return res.json({
      success: true,
      message: 'New Gateway API Key generated',
      gatewayApiKey,
      gatewayApiSecret,
      user: safeUser,
    });
  } catch (error) {
    console.error('Error generating API keys:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/merchant/telegram-bot
 * Connect custom Telegram bot and products catalogue
 */
merchantRouter.post('/telegram-bot', (req, res) => {
  try {
    const { botToken, isActive = true, products } = req.body;

    const currentTg = req.user.telegramConfig || {};
    const updatedTg = {
      botToken: botToken !== undefined ? botToken.trim() : currentTg.botToken,
      isActive: isActive !== undefined ? isActive : currentTg.isActive,
      products: products !== undefined ? products : (currentTg.products || []),
    };

    const updatedUser = db.updateUser(req.user.id, { telegramConfig: updatedTg });

    if (updatedTg.botToken && updatedTg.isActive) {
      botManager.registerMerchantBot(updatedUser, updatedTg.botToken, updatedTg.products);
    } else {
      botManager.stopMerchantBot(req.user.id);
    }

    const safeUser = { ...updatedUser };
    delete safeUser.passwordHash;

    return res.json({
      success: true,
      message: 'Telegram Bot configuration updated and synchronized',
      user: safeUser,
    });
  } catch (error) {
    console.error('Error updating Telegram bot config:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/merchant/stats
 * Dashboard stats: Volume, total orders, completed count, recent orders
 */
merchantRouter.get('/stats', (req, res) => {
  try {
    const ordersResult = db.listOrders(100, 0, req.user.id);
    const userOrders = ordersResult.orders;

    let totalVolume = 0;
    let completedCount = 0;
    let pendingCount = 0;

    userOrders.forEach(o => {
      if (o.status === 'PAID') {
        totalVolume += parseFloat(o.orderAmount || 0);
        completedCount++;
      } else if (o.status === 'INITIAL' || o.status === 'PENDING') {
        pendingCount++;
      }
    });

    return res.json({
      success: true,
      stats: {
        totalOrders: userOrders.length,
        completedOrders: completedCount,
        pendingOrders: pendingCount,
        totalVolumeUSDT: totalVolume.toFixed(2),
      },
      recentOrders: userOrders.slice(0, 10),
    });
  } catch (error) {
    console.error('Error fetching merchant stats:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/merchant/orders
 * List all merchant orders
 */
merchantRouter.get('/orders', (req, res) => {
  const limit = parseInt(req.query.limit || '50', 10);
  const offset = parseInt(req.query.offset || '0', 10);
  const result = db.listOrders(limit, offset, req.user.id);
  res.json({ success: true, ...result });
});
