import { Bot, InlineKeyboard, InputFile } from 'grammy';
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
      return;
    }

    try {
      this.bot = new Bot(config.telegramBotToken);
      console.log('🤖 Telegram Payment Bot initialized and polling for updates...');

      this.registerHandlers();
      this.registerPaymentListener();
      this.bot.start().catch(err => console.warn('Bot polling notice:', err.message));
    } catch (err) {
      console.error('❌ Failed to start Telegram Bot:', err.message);
    }
  }

  registerHandlers() {
    // /start command
    this.bot.command('start', async (ctx) => {
      const chatId = ctx.chat.id;
      const firstName = ctx.from.first_name || 'there';

      db.saveTelegramUser(chatId, {
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
      });

      const welcomeText = 
        `👋 *Welcome ${firstName} to Binance Pay Store!*\n\n` +
        `🛒 You can purchase products & digital services with zero gas fees using *Binance Pay*.\n\n` +
        `*Available Commands:*\n` +
        `🛍️ /products - View catalogue & buy with Binance Pay\n` +
        `🔍 /status <order_id> - Check status of an existing order\n` +
        `ℹ️ /help - Support and information\n\n` +
        `_Tap below to browse products:_`;

      const keyboard = new InlineKeyboard()
        .text('🛍️ Browse Products & Services', 'cmd_products')
        .row()
        .url('🌐 Open Web Store', `${config.baseUrl}/demo`);

      await ctx.reply(welcomeText, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    });

    // /products or /buy command
    this.bot.command(['products', 'buy'], async (ctx) => {
      await this.sendProductsMenu(ctx);
    });

    // /status command
    this.bot.command('status', async (ctx) => {
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
        (order.transactionId ? `• *TxID:* \`${order.transactionId}\`\n` : '') +
        (order.paidAt ? `• *Paid At:* ${new Date(order.paidAt).toLocaleString()}\n` : '');

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
    this.bot.command('help', async (ctx) => {
      await ctx.reply(
        `💡 *Binance Pay Bot Help*\n\n1. Choose an item from /products.\n2. Receive a secure Binance Pay checkout link and QR code.\n3. Scan the QR code with your Binance mobile app or tap "Pay with Binance".\n4. Payment is verified instantly with *zero gas fees*!`,
        { parse_mode: 'Markdown' }
      );
    });

    // Callback queries
    this.bot.on('callback_query:data', async (ctx) => {
      const chatId = ctx.chat.id;
      const data = ctx.callbackQuery.data;

      try {
        if (data === 'cmd_products') {
          await ctx.answerCallbackQuery();
          return this.sendProductsMenu(ctx);
        }

        if (data.startsWith('buy_')) {
          const prodId = data.replace('buy_', '');
          const product = this.products.find(p => p.id === prodId);

          if (!product) {
            return ctx.answerCallbackQuery({ text: 'Product not found', show_alert: true });
          }

          await ctx.answerCallbackQuery({ text: `Creating Binance Pay invoice for ${product.name}...` });

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
              telegramUserId: ctx.from.id,
              telegramUsername: ctx.from.username,
              productId: product.id,
            },
          };

          const binanceRes = await binancePayService.createOrder(orderParams);

          if (binanceRes.status !== 'SUCCESS') {
            return ctx.reply('❌ Failed to generate Binance Pay invoice. Please try again.');
          }

          const paymentData = binanceRes.data;

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
            `📱 *Scan QR with Binance App* or tap button below!`;

          const keyboard = new InlineKeyboard()
            .url('🟡 Pay with Binance App', paymentData.deeplink || savedOrder.checkoutUrl)
            .row()
            .url('🌐 Web Checkout Page', `${config.baseUrl}/checkout/${merchantTradeNo}`);

          if (savedOrder.mock) {
            keyboard.row().text('🧪 Test Payment (Simulate Success)', `mockpay_${merchantTradeNo}`);
          }

          await ctx.replyWithPhoto(new InputFile(qrBuffer, 'invoice.png'), {
            caption,
            parse_mode: 'Markdown',
            reply_markup: keyboard,
          });
        }

        if (data.startsWith('mockpay_')) {
          const merchantTradeNo = data.replace('mockpay_', '');
          const order = db.getOrder(merchantTradeNo);

          if (!order) {
            return ctx.answerCallbackQuery({ text: 'Order not found', show_alert: true });
          }

          await ctx.answerCallbackQuery({ text: 'Simulating successful payment...' });

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
        ctx.reply(`⚠️ Error processing request: ${error.message}`);
      }
    });
  }

  async sendProductsMenu(ctx) {
    let message = `🛒 *Binance Pay Store Menu*\n\nSelect an item to generate an instant crypto invoice:\n`;
    const keyboard = new InlineKeyboard();

    this.products.forEach(p => {
      keyboard.text(`${p.name} - ${p.amount} ${p.currency}`, `buy_${p.id}`).row();
    });

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  }

  registerPaymentListener() {
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
          `🚀 Thank you for your purchase!`;

        try {
          await this.bot.api.sendMessage(chatId, paidText, { parse_mode: 'Markdown' });
        } catch (err) {
          console.error(`Failed to send payment notification to Telegram chat ${chatId}:`, err.message);
        }
      }
    });
  }
}

export const telegramBot = new TelegramPaymentBot();
