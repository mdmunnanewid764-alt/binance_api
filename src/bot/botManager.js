import { Bot, InlineKeyboard, InputFile } from 'grammy';
import QRCode from 'qrcode';
import { config } from '../config/env.js';
import { binancePayService } from '../services/binancePay.js';
import { db } from '../db/database.js';
import { paymentEvents } from '../services/eventEmitter.js';
import { v4 as uuidv4 } from 'uuid';

class BotManager {
  constructor() {
    this.activeBots = new Map(); // key: userId or 'system', value: { bot, products, userId }
    this.isListenerRegistered = false;
  }

  start() {
    this.startSystemBot();
    this.initAllMerchantBots();
    this.registerGlobalPaymentListener();
  }

  startSystemBot() {
    if (!config.telegramBotToken) {
      console.log('ℹ️  No system TELEGRAM_BOT_TOKEN set in .env.');
      return;
    }

    const defaultProducts = [
      { id: 'prod_1', name: '⚡ 1-Month VIP Subscription', amount: '5.00', currency: 'USDT', desc: 'Access to VIP signals' },
      { id: 'prod_2', name: '🚀 1-Year VIP Access', amount: '45.00', currency: 'USDT', desc: 'Full 365-day access' },
      { id: 'prod_3', name: '💎 Lifetime Pro Pass', amount: '99.00', currency: 'USDT', desc: 'Unlimited lifetime access' },
    ];

    this.registerBotInstance('system', config.telegramBotToken, defaultProducts, null);
  }

  initAllMerchantBots() {
    const users = db.listUsers();
    for (const user of users) {
      if (user.telegramConfig?.botToken && user.telegramConfig?.isActive !== false) {
        this.registerBotInstance(
          user.id,
          user.telegramConfig.botToken,
          user.telegramConfig.products || [],
          user
        );
      }
    }
  }

  registerMerchantBot(user, token, products) {
    return this.registerBotInstance(user.id, token, products, user);
  }

  stopMerchantBot(userId) {
    if (this.activeBots.has(userId)) {
      const { bot } = this.activeBots.get(userId);
      try {
        bot.stop();
      } catch (e) {
        // Ignore stop error
      }
      this.activeBots.delete(userId);
      console.log(`🛑 Stopped Telegram bot for user ${userId}`);
    }
  }

  registerBotInstance(key, token, products = [], user = null) {
    this.stopMerchantBot(key);

    try {
      const bot = new Bot(token);
      this.activeBots.set(key, { bot, products, user, userId: key });

      console.log(`🤖 Telegram Bot registered for: [${key === 'system' ? 'System Bot' : (user?.name || key)}]`);

      this.setupBotHandlers(bot, products, user, key);

      // Catch and handle polling errors gracefully
      bot.catch((err) => {
        const error = err.error;
        if (error?.error_code === 409 || error?.message?.includes('409 Conflict')) {
          console.warn(`⚠️ [Bot ${key}] 409 Conflict: Another instance is polling. Waiting...`);
        } else {
          console.warn(`[Bot ${key}] Notice:`, error?.message || error);
        }
      });

      // Start bot with drop_pending_updates to clear backlog
      bot.start({
        drop_pending_updates: true,
        onStart: (botInfo) => {
          console.log(`🚀 Telegram Bot @${botInfo.username} is now live and listening!`);
        },
      }).catch(err => {
        if (err?.error_code === 409 || err?.message?.includes('409 Conflict')) {
          console.warn(`⚠️ [Bot ${key}] 409 Conflict handled.`);
        } else {
          console.warn(`Bot start notice for ${key}:`, err.message);
        }
      });

      return { success: true, message: 'Bot started successfully' };
    } catch (err) {
      console.error(`❌ Failed to register bot for [${key}]:`, err.message);
      return { success: false, error: err.message };
    }
  }

  setupBotHandlers(bot, products, user, botKey) {
    const merchantName = user?.name || 'Binance Pay Store';
    const wallets = user?.cryptoWallets || {
      bep20: '0x386Ac338C488F61a9B4810fe17Fa2a78BE456108',
      trc20: 'TYasdf123456789TronUSDTAddress9988',
      erc20: '0x386Ac338C488F61a9B4810fe17Fa2a78BE456108',
    };

    // /start command
    bot.command('start', async (ctx) => {
      const chatId = ctx.chat.id;
      const firstName = ctx.from.first_name || 'Customer';

      db.saveTelegramUser(chatId, {
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        merchantId: user?.id || 'system',
      });

      const welcomeText =
        `👋 *Welcome ${firstName} to ${merchantName}!* 🟡\n\n` +
        `We accept payments via *Binance Pay, BEP20 (BSC), TRC20 (Tron), and ERC20 (ETH)*.\n\n` +
        `*Commands:*\n` +
        `🛍️ /products or /buy - Browse catalogue & pay\n` +
        `🔍 /status <order_id> - Check payment status\n` +
        `ℹ️ /help - Support\n\n` +
        `_Tap below to select an item:_`;

      const keyboard = new InlineKeyboard()
        .text('🛍️ Browse Products & Buy', 'cmd_products')
        .row()
        .url('🌐 Store Portal', `${config.baseUrl}/checkout/demo`);

      await ctx.reply(welcomeText, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    });

    // /products or /buy
    bot.command(['products', 'buy'], async (ctx) => {
      await this.sendProductsMenu(ctx, products, merchantName);
    });

    // /status command
    bot.command('status', async (ctx) => {
      const text = ctx.message.text.trim();
      const parts = text.split(/\s+/);
      const orderId = parts[1];

      if (!orderId) {
        return ctx.reply('⚠️ Please provide an Order ID.\nExample: `/status ORDER_123456`', { parse_mode: 'Markdown' });
      }

      const order = db.getOrder(orderId);
      if (!order) {
        return ctx.reply(`❌ Order *${orderId}* not found.`, { parse_mode: 'Markdown' });
      }

      const statusEmoji = order.status === 'PAID' ? '✅' : order.status === 'PENDING' ? '⏳' : '⚠️';
      const responseText =
        `📦 *Order Details:*\n` +
        `• *ID:* \`${order.merchantTradeNo}\`\n` +
        `• *Item:* ${order.goodsName}\n` +
        `• *Amount:* ${order.orderAmount} ${order.currency}\n` +
        `• *Status:* ${statusEmoji} *${order.status}*\n` +
        (order.transactionId ? `• *TxID:* \`${order.transactionId}\`\n` : '');

      const keyboard = new InlineKeyboard();
      if (order.status !== 'PAID') {
        keyboard.url('💳 Pay Now', order.checkoutUrl || `${config.baseUrl}/checkout/${order.merchantTradeNo}`);
      }

      await ctx.reply(responseText, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    });

    // /help command
    bot.command('help', async (ctx) => {
      await ctx.reply(
        `💡 *Payment Help*\n\n1. Select an item with /products\n2. Choose your preferred network: *Binance Pay, BEP20, TRC20, or ERC20*\n3. Scan QR or transfer USDT to the address.\n4. Instant confirmation!`,
        { parse_mode: 'Markdown' }
      );
    });

    // Callback queries
    bot.on('callback_query:data', async (ctx) => {
      const chatId = ctx.chat.id;
      const data = ctx.callbackQuery.data;

      try {
        if (data === 'cmd_products') {
          await ctx.answerCallbackQuery();
          return this.sendProductsMenu(ctx, products, merchantName);
        }

        if (data.startsWith('buy_')) {
          const prodId = data.replace('buy_', '');
          const product = products.find(p => p.id === prodId);

          if (!product) {
            return ctx.answerCallbackQuery({ text: 'Product not found', show_alert: true });
          }

          await ctx.answerCallbackQuery({ text: `Creating invoice for ${product.name}...` });

          const merchantTradeNo = `TG_${Date.now()}_${uuidv4().slice(0, 6).toUpperCase()}`;
          const customApiKey = user?.binanceConfig?.apiKey || null;
          const customSecretKey = user?.binanceConfig?.secretKey || null;

          const orderParams = {
            merchantTradeNo,
            orderAmount: product.amount,
            currency: product.currency || 'USDT',
            goodsType: '02',
            goodsName: product.name,
            goodsDetail: product.desc || `${product.name} purchase`,
            terminalType: 'APP',
            metadata: {
              telegramChatId: chatId,
              telegramUserId: ctx.from.id,
              telegramUsername: ctx.from.username,
              merchantUserId: user?.id || 'system',
              productId: product.id,
            },
          };

          const binanceRes = await binancePayService.createOrder(orderParams, customApiKey, customSecretKey);
          const paymentData = binanceRes.data;

          const savedOrder = db.createOrder({
            userId: user?.id || null,
            merchantTradeNo,
            prepayId: paymentData.prepayId,
            orderAmount: product.amount,
            currency: product.currency || 'USDT',
            goodsName: product.name,
            goodsDetail: product.desc,
            status: 'INITIAL',
            cryptoWallets: wallets,
            checkoutUrl: paymentData.checkoutUrl || `${config.baseUrl}/checkout/${merchantTradeNo}`,
            qrcodeLink: paymentData.qrcodeLink,
            deeplink: paymentData.deeplink,
            universalUrl: paymentData.universalUrl,
            metadata: orderParams.metadata,
          });

          const targetPayUrl = paymentData.deeplink || savedOrder.checkoutUrl;
          const qrBuffer = await QRCode.toBuffer(targetPayUrl, {
            errorCorrectionLevel: 'H',
            margin: 2,
            scale: 8,
            color: { dark: '#0b0e11', light: '#f0b90b' },
          });

          const caption =
            `🧾 *Invoice Created:* *${product.name}*\n\n` +
            `💰 *Amount:* *${product.amount} ${product.currency || 'USDT'}*\n` +
            `🆔 *Order ID:* \`${merchantTradeNo}\`\n\n` +
            `👇 *Choose your payment network below:*`;

          const keyboard = new InlineKeyboard()
            .url('🟡 Binance Pay (1-Click App)', paymentData.deeplink || savedOrder.checkoutUrl)
            .row()
            .text('⚡ BEP20 (BSC Address)', `show_bep20_${merchantTradeNo}`)
            .text('🔴 TRC20 (Tron Address)', `show_trc20_${merchantTradeNo}`)
            .row()
            .text('🔷 ERC20 (Ethereum Address)', `show_erc20_${merchantTradeNo}`)
            .row()
            .url('🌐 Open Multi-Chain Checkout UI', `${config.baseUrl}/checkout/${merchantTradeNo}`);

          await ctx.replyWithPhoto(new InputFile(qrBuffer, 'invoice_qr.png'), {
            caption,
            parse_mode: 'Markdown',
            reply_markup: keyboard,
          });
        }

        if (data.startsWith('show_bep20_')) {
          const tradeNo = data.replace('show_bep20_', '');
          const order = db.getOrder(tradeNo);
          const addr = wallets.bep20 || '0x386Ac338C488F61a9B4810fe17Fa2a78BE456108';
          await ctx.answerCallbackQuery();

          const qrBuffer = await QRCode.toBuffer(addr, { scale: 8, margin: 2 });
          const msg =
            `⚡ *BEP20 (BNB Smart Chain) Deposit*\n\n` +
            `💰 *Amount:* *${order?.orderAmount || ''} USDT*\n` +
            `📬 *Address:* \`${addr}\`\n\n` +
            `_Send exact USDT via BEP20 (BSC) network._`;

          await ctx.replyWithPhoto(new InputFile(qrBuffer, 'bep20.png'), {
            caption: msg,
            parse_mode: 'Markdown',
          });
        }

        if (data.startsWith('show_trc20_')) {
          const tradeNo = data.replace('show_trc20_', '');
          const order = db.getOrder(tradeNo);
          const addr = wallets.trc20 || 'TYasdf123456789TronUSDTAddress9988';
          await ctx.answerCallbackQuery();

          const qrBuffer = await QRCode.toBuffer(addr, { scale: 8, margin: 2 });
          const msg =
            `🔴 *TRC20 (TRON Network) Deposit*\n\n` +
            `💰 *Amount:* *${order?.orderAmount || ''} USDT*\n` +
            `📬 *Address:* \`${addr}\`\n\n` +
            `_Send exact USDT via TRC20 network._`;

          await ctx.replyWithPhoto(new InputFile(qrBuffer, 'trc20.png'), {
            caption: msg,
            parse_mode: 'Markdown',
          });
        }

        if (data.startsWith('show_erc20_')) {
          const tradeNo = data.replace('show_erc20_', '');
          const order = db.getOrder(tradeNo);
          const addr = wallets.erc20 || '0x386Ac338C488F61a9B4810fe17Fa2a78BE456108';
          await ctx.answerCallbackQuery();

          const qrBuffer = await QRCode.toBuffer(addr, { scale: 8, margin: 2 });
          const msg =
            `🔷 *ERC20 (Ethereum Network) Deposit*\n\n` +
            `💰 *Amount:* *${order?.orderAmount || ''} USDT*\n` +
            `📬 *Address:* \`${addr}\`\n\n` +
            `_Send exact USDT via ERC20 network._`;

          await ctx.replyWithPhoto(new InputFile(qrBuffer, 'erc20.png'), {
            caption: msg,
            parse_mode: 'Markdown',
          });
        }
      } catch (err) {
        console.error('Bot callback query error:', err);
        ctx.reply(`⚠️ Error: ${err.message}`);
      }
    });
  }

  async sendProductsMenu(ctx, products, merchantName) {
    if (!products || products.length === 0) {
      return ctx.reply(`ℹ️ No products currently listed in *${merchantName}*.`, { parse_mode: 'Markdown' });
    }

    const message = `🛒 *${merchantName} Catalogue*\n\nSelect an item to generate an instant invoice (Binance Pay / BEP20 / TRC20 / ERC20):\n`;
    const keyboard = new InlineKeyboard();

    products.forEach(p => {
      keyboard.text(`${p.name} - ${p.amount} ${p.currency || 'USDT'}`, `buy_${p.id}`).row();
    });

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  }

  registerGlobalPaymentListener() {
    if (this.isListenerRegistered) return;
    this.isListenerRegistered = true;

    paymentEvents.on('payment:updated', async (order) => {
      if (order.status === 'PAID' && order.metadata?.telegramChatId) {
        const chatId = order.metadata.telegramChatId;
        const merchantUserId = order.metadata?.merchantUserId || 'system';

        const botData = this.activeBots.get(merchantUserId) || this.activeBots.get('system');
        if (botData?.bot) {
          const paidText =
            `🎉 *PAYMENT RECEIVED SUCCESSFULLY!*\n\n` +
            `✅ Your payment for *${order.goodsName}* has been confirmed (${order.paidNetwork || 'Binance Pay'}).\n\n` +
            `🧾 *Receipt Details:*\n` +
            `• *Order ID:* \`${order.merchantTradeNo}\`\n` +
            `• *Amount:* ${order.orderAmount} ${order.currency}\n` +
            (order.transactionId ? `• *TxID:* \`${order.transactionId}\`\n` : '') +
            `• *Status:* ✅ PAID / COMPLETED\n\n` +
            `🚀 Thank you for your purchase!`;

          try {
            await botData.bot.api.sendMessage(chatId, paidText, { parse_mode: 'Markdown' });
          } catch (err) {
            console.error(`Failed to send payment receipt to chat ${chatId}:`, err.message);
          }
        }
      }
    });
  }
}

export const botManager = new BotManager();
