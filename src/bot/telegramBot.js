import TelegramBot from 'node-telegram-bot-api';
import QRCode from 'qrcode';
import { config } from '../config/env.js';
import { binancePayService } from '../services/binancePay.js';
import { db } from '../db/database.js';
import { paymentEvents } from '../services/eventEmitter.js';
import { v4 as uuidv4 } from 'uuid';

export class TelegramPaymentBot {
  constructor() {
    this.bot = null;
    this.products = [
      { id: 'prod_1', name: '⚡ 1-Month VIP Subscription', amount: '5.00', currency: 'USDT', desc: 'Access to premium signals & private group' },
      { id: 'prod_2', name: '🚀 1-Year VIP Access', amount: '45.00', currency: 'USDT', desc: 'Full 365-day access + priority 1-on-1 support' },
      { id: 'prod_3', name: '💎 Lifetime Pro Pass', amount: '99.00', currency: 'USDT', desc: 'Lifetime unlimited access to all features' },
      { id: 'prod_test', name: '🧪 Test Coffee (Demo)', amount: '1.00', currency: 'USDT', desc: '1 USDT test payment' },
    ];
  }

  start() {
    if (!config.telegramBotToken) {
      console.log('ℹ️  TELEGRAM_BOT_TOKEN not provided in .env. Telegram bot is in standby mode.');
      console.log('   👉 To enable: Add your bot token from @BotFather to .env and restart.');
      return;
    }

    try {
      this.bot = new TelegramBot(config.telegramBotToken, { polling: true });
      console.log('🤖 Telegram Payment Bot initialized and polling for updates...');

      this.registerHandlers();
      this.registerPaymentListener();
    } catch (err) {
      console.error('❌ Failed to start Telegram Bot:', err.message);
    }
  }

  registerHandlers() {
    // /start command
    this.bot.onText(/\/start/, (msg) => {
      const chatId = msg.chat.id;
      const firstName = msg.from.first_name || 'there';

      db.saveTelegramUser(chatId, {
        username: msg.from.username,
        firstName: msg.from.first_name,
        lastName: msg.from.last_name,
      });

      const welcomeText = 
        `👋 *Welcome ${firstName} to Binance Pay Store!*\n\n` +
        `🛒 You can purchase products & digital services with zero gas fees using *Binance Pay*.\n\n` +
        `*Available Commands:*\n` +
        `🛍️ /products - View catalogue & buy with Binance Pay\n` +
        `🔍 /status <order_id> - Check status of an existing order\n` +
        `ℹ️ /help - Support and information\n\n` +
        `_Tap below to browse products:_`;

      const keyboard = {
        inline_keyboard: [
          [{ text: '🛍️ Browse Products & Services', callback_data: 'cmd_products' }],
          [{ text: '🌐 Open Web Store', url: `${config.baseUrl}/demo` }],
        ],
      };

      this.bot.sendMessage(chatId, welcomeText, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    });

    // /products or /buy command
    this.bot.onText(/\/(products|buy)/, (msg) => {
      this.sendProductsMenu(msg.chat.id);
    });

    // /status command
    this.bot.onText(/\/status(?:\s+(\S+))?/, (msg, match) => {
      const chatId = msg.chat.id;
      const orderId = match[1];

      if (!orderId) {
        return this.bot.sendMessage(
          chatId,
          '⚠️ Please provide an Order ID.\nExample: `/status ORDER_123456`',
          { parse_mode: 'Markdown' }
        );
      }

      const order = db.getOrder(orderId);
      if (!order) {
        return this.bot.sendMessage(chatId, `❌ Order *${orderId}* not found.`, { parse_mode: 'Markdown' });
      }

      const statusEmoji = order.status === 'PAID' ? '✅' : order.status === 'PENDING' ? '⏳' : '⚠️';
      const responseText =
        `📦 *Order Details:*\n` +
        `• *ID:* \`${order.merchantTradeNo}\`\n` +
        `• *Item:* ${order.goodsName}\n` +
        `• *Amount:* ${order.orderAmount} ${order.currency}\n` +
        `• *Status:* ${statusEmoji} *${order.status}*\n` +
        (order.transactionId ? `• *TxID:* \`${order.transactionId}\`\n` : '') +
        (order.paidAt ? `• *Paid At:* ${new Date(order.paidAt).toLocaleString()}\n` : '');

      const buttons = [];
      if (order.status !== 'PAID') {
        buttons.push([{ text: '💳 Pay Now', url: order.checkoutUrl || `${config.baseUrl}/checkout/${order.merchantTradeNo}` }]);
      }

      this.bot.sendMessage(chatId, responseText, {
        parse_mode: 'Markdown',
        reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined,
      });
    });

    // /help command
    this.bot.onText(/\/help/, (msg) => {
      const helpText =
        `💡 *Binance Pay Bot Help*\n\n` +
        `1. Choose an item from /products.\n` +
        `2. Receive a secure Binance Pay checkout link and QR code.\n` +
        `3. Scan the QR code with your Binance mobile app or tap "Pay with Binance".\n` +
        `4. Payment is verified instantly with *zero gas fees*!\n\n` +
        `If you have questions, please reach out to admin.`;

      this.bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
    });

    // Callback queries (Button clicks)
    this.bot.on('callback_query', async (query) => {
      const chatId = query.message.chat.id;
      const data = query.data;

      try {
        if (data === 'cmd_products') {
          await this.bot.answerCallbackQuery(query.id);
          return this.sendProductsMenu(chatId);
        }

        if (data.startsWith('buy_')) {
          const prodId = data.replace('buy_', '');
          const product = this.products.find(p => p.id === prodId);

          if (!product) {
            return this.bot.answerCallbackQuery(query.id, { text: 'Product not found', show_alert: true });
          }

          await this.bot.answerCallbackQuery(query.id, { text: `Creating Binance Pay invoice for ${product.name}...` });

          // Create payment order
          const merchantTradeNo = `TG_${Date.now()}_${uuidv4().slice(0, 6).toUpperCase()}`;
          const orderParams = {
            merchantTradeNo,
            orderAmount: product.amount,
            currency: product.currency,
            goodsType: '02',
            goodsName: product.name,
            goodsDetail: product.desc,
            terminalType: 'APP',
            metadata: {
              telegramChatId: chatId,
              telegramUserId: query.from.id,
              telegramUsername: query.from.username,
              productId: product.id,
            },
          };

          const binanceRes = await binancePayService.createOrder(orderParams);

          if (binanceRes.status !== 'SUCCESS') {
            return this.bot.sendMessage(chatId, '❌ Failed to generate Binance Pay invoice. Please try again.');
          }

          const paymentData = binanceRes.data;

          // Save order to DB
          const savedOrder = db.createOrder({
            merchantTradeNo,
            prepayId: paymentData.prepayId,
            orderAmount: product.amount,
            currency: product.currency,
            goodsName: product.name,
            goodsDetail: product.desc,
            status: 'INITIAL',
            checkoutUrl: paymentData.checkoutUrl || `${config.baseUrl}/checkout/${merchantTradeNo}`,
            qrcodeLink: paymentData.qrcodeLink,
            deeplink: paymentData.deeplink,
            universalUrl: paymentData.universalUrl,
            metadata: orderParams.metadata,
            mock: !!binanceRes.mock,
          });

          // Generate QR Code image buffer for Binance Pay URL / Checkout
          const targetPayUrl = paymentData.deeplink || savedOrder.checkoutUrl;
          const qrBuffer = await QRCode.toBuffer(targetPayUrl, {
            errorCorrectionLevel: 'H',
            margin: 2,
            scale: 8,
            color: { dark: '#0b0e11', light: '#f0b90b' },
          });

          const caption =
            `🟡 *Binance Pay Invoice Created!*\n\n` +
            `📦 *Item:* ${product.name}\n` +
            `💰 *Amount:* *${product.amount} ${product.currency}*\n` +
            `🆔 *Order ID:* \`${merchantTradeNo}\`\n\n` +
            `📱 *How to pay:*\n` +
            `• Scan the QR code above with your *Binance App*, or\n` +
            `• Tap the *Pay in Binance App* button below!\n\n` +
            `⏱️ Payment is confirmed automatically within seconds.`;

          const keyboard = {
            inline_keyboard: [
              [
                { text: '🟡 Pay with Binance App', url: paymentData.deeplink || savedOrder.checkoutUrl },
              ],
              [
                { text: '🌐 Web Checkout Page', url: `${config.baseUrl}/checkout/${merchantTradeNo}` },
              ],
            ],
          };

          // If in mock mode, add a one-tap mock pay button for effortless testing
          if (savedOrder.mock) {
            keyboard.inline_keyboard.push([
              { text: '🧪 Test Payment (Simulate Success)', callback_data: `mockpay_${merchantTradeNo}` }
            ]);
          }

          await this.bot.sendPhoto(chatId, qrBuffer, {
            caption,
            parse_mode: 'Markdown',
            reply_markup: keyboard,
          });
        }

        if (data.startsWith('mockpay_')) {
          const merchantTradeNo = data.replace('mockpay_', '');
          const order = db.getOrder(merchantTradeNo);

          if (!order) {
            return this.bot.answerCallbackQuery(query.id, { text: 'Order not found', show_alert: true });
          }

          await this.bot.answerCallbackQuery(query.id, { text: 'Simulating successful payment...' });

          const updatedOrder = db.updateOrder(merchantTradeNo, {
            status: 'PAID',
            bizStatus: 'PAY_SUCCESS',
            transactionId: `mock_tx_${Date.now()}`,
            paidAt: new Date().toISOString(),
          });

          paymentEvents.emit('payment:updated', updatedOrder);
          paymentEvents.emit(`payment:${merchantTradeNo}`, updatedOrder);
        }
      } catch (error) {
        console.error('Telegram callback query error:', error);
        this.bot.sendMessage(chatId, `⚠️ Error processing request: ${error.message}`);
      }
    });
  }

  sendProductsMenu(chatId) {
    let message = `🛒 *Binance Pay Store Menu*\n\nSelect an item to generate an instant crypto invoice:\n`;

    const inline_keyboard = this.products.map(p => ([
      {
        text: `${p.name} - ${p.amount} ${p.currency}`,
        callback_data: `buy_${p.id}`,
      }
    ]));

    this.bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard },
    });
  }

  registerPaymentListener() {
    // Listen for real-time payment updates from webhooks
    paymentEvents.on('payment:updated', async (order) => {
      if (order.status === 'PAID' && order.metadata?.telegramChatId && this.bot) {
        const chatId = order.metadata.telegramChatId;
        const paidText =
          `🎉 *PAYMENT RECEIVED SUCCESSFULLY!*\n\n` +
          `✅ Your payment for *${order.goodsName}* has been verified by Binance Pay.\n\n` +
          `🧾 *Receipt Details:*\n` +
          `• *Order ID:* \`${order.merchantTradeNo}\`\n` +
          `• *Amount Paid:* ${order.orderAmount} ${order.currency}\n` +
          (order.transactionId ? `• *Binance TxID:* \`${order.transactionId}\`\n` : '') +
          `• *Status:* ✅ PAID / COMPLETED\n\n` +
          `🚀 Thank you for your purchase! Your service/access is now active.`;

        try {
          await this.bot.sendMessage(chatId, paidText, { parse_mode: 'Markdown' });
        } catch (err) {
          console.error(`Failed to send payment notification to Telegram chat ${chatId}:`, err.message);
        }
      }
    });
  }
}

export const telegramBot = new TelegramPaymentBot();
