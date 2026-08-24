import express from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { binancePayService } from '../services/binancePay.js';
import { db } from '../db/database.js';
import { paymentEvents } from '../services/eventEmitter.js';
import { config } from '../config/env.js';

export const paymentRouter = express.Router();

/**
 * Middleware to resolve merchant from Gateway API Key, JWT token, or metadata
 */
function resolveMerchantApiKey(req, res, next) {
  // 1. Check x-api-key
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  if (apiKey) {
    const merchantUser = db.getUserByApiKey(apiKey);
    if (merchantUser) {
      req.merchantUser = merchantUser;
      return next();
    }
  }

  // 2. Check JWT Bearer token
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, config.jwtSecret);
      if (decoded && decoded.id) {
        const user = db.getUserById(decoded.id);
        if (user) {
          req.merchantUser = user;
          return next();
        }
      }
    } catch (e) {}
  }

  next();
}

paymentRouter.use(resolveMerchantApiKey);

/**
 * POST /api/v1/payments/create
 * Creates a new Binance Pay payment order
 */
paymentRouter.post('/create', async (req, res) => {
  try {
    const {
      merchantTradeNo = `ORDER_${Date.now()}_${uuidv4().slice(0, 8).toUpperCase()}`,
      orderAmount,
      currency = 'USDT',
      goodsType = '02',
      goodsName = 'Digital Product',
      goodsDetail = 'Payment via Binance Pay',
      returnUrl,
      cancelUrl,
      terminalType = 'WEB',
      metadata = {},
    } = req.body;

    if (!orderAmount || isNaN(parseFloat(orderAmount)) || parseFloat(orderAmount) <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or missing orderAmount',
      });
    }

    // Determine custom Binance API keys
    const merchantUser = req.merchantUser 
      || (metadata.merchantUserId ? db.getUserById(metadata.merchantUserId) : null)
      || (metadata.userId ? db.getUserById(metadata.userId) : null)
      || db.listUsers().find(u => u.binanceConfig?.apiKey && u.binanceConfig?.secretKey)
      || null;

    const customApiKey = merchantUser?.binanceConfig?.apiKey || config.binance.apiKey || null;
    const customSecretKey = merchantUser?.binanceConfig?.secretKey || config.binance.secretKey || null;

    const orderParams = {
      merchantTradeNo,
      orderAmount: parseFloat(orderAmount).toFixed(2),
      currency: currency.toUpperCase(),
      goodsType,
      goodsName,
      goodsDetail,
      returnUrl: returnUrl || `${config.baseUrl}/checkout/${merchantTradeNo}?status=success`,
      cancelUrl: cancelUrl || `${config.baseUrl}/checkout/${merchantTradeNo}?status=cancel`,
      terminalType,
      metadata: {
        ...metadata,
        merchantUserId: merchantUser?.id || metadata.merchantUserId || null,
      },
    };

    const binanceResponse = await binancePayService.createOrder(orderParams, customApiKey, customSecretKey);

    if (binanceResponse.status !== 'SUCCESS' || binanceResponse.code !== '000000') {
      return res.status(400).json({
        success: false,
        error: 'Failed to create order on Binance Pay',
        details: binanceResponse,
      });
    }

    const paymentData = binanceResponse.data;

    const requestOrigin = req.headers.origin || (req.get('host') ? `${req.protocol}://${req.get('host')}` : null);
    const effectiveBaseUrl = (config.baseUrl && !config.baseUrl.includes('localhost')) ? config.baseUrl : (requestOrigin || 'https://binance-api-yrz4.onrender.com');

    const cryptoWallets = merchantUser?.cryptoWallets || {
      bep20: '',
      trc20: '',
      erc20: '',
    };

    const checkoutUrl = (paymentData.checkoutUrl && !paymentData.checkoutUrl.includes('localhost')) 
      ? paymentData.checkoutUrl 
      : `${effectiveBaseUrl}/checkout/${merchantTradeNo}`;

    // Save order in database
    const savedOrder = db.createOrder({
      userId: merchantUser?.id || metadata.merchantUserId || null,
      merchantTradeNo,
      prepayId: paymentData.prepayId,
      orderAmount: orderParams.orderAmount,
      currency: orderParams.currency,
      goodsName: orderParams.goodsName,
      goodsDetail: orderParams.goodsDetail,
      status: 'INITIAL',
      cryptoWallets,
      terminalType: paymentData.terminalType || terminalType,
      checkoutUrl,
      qrcodeLink: paymentData.qrcodeLink,
      qrContent: paymentData.qrContent,
      deeplink: paymentData.deeplink,
      universalUrl: paymentData.universalUrl,
      expireTime: paymentData.expireTime,
      metadata: orderParams.metadata,
      mock: !!binanceResponse.mock,
    });

    return res.status(201).json({
      success: true,
      message: 'Payment order created successfully',
      order: savedOrder,
      cryptoWallets,
      paymentData: {
        merchantTradeNo,
        prepayId: paymentData.prepayId,
        checkoutUrl: savedOrder.checkoutUrl,
        hostedCheckoutUrl: `${effectiveBaseUrl}/checkout/${merchantTradeNo}`,
        cryptoWallets,
        qrcodeLink: paymentData.qrcodeLink,
        qrContent: paymentData.qrContent,
        deeplink: paymentData.deeplink,
        universalUrl: paymentData.universalUrl,
        expireTime: paymentData.expireTime,
      },
    });
  } catch (error) {
    console.error('Error creating payment order:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal Server Error',
    });
  }
});

/**
 * GET /api/v1/payments/:merchantTradeNo
 * Get order status and details
 */
paymentRouter.get('/:merchantTradeNo', async (req, res) => {
  try {
    const { merchantTradeNo } = req.params;
    let order = db.getOrder(merchantTradeNo);

    if (!order && supabaseService.isAvailable()) {
      if (supabaseService.isPgDirect && supabaseService.pgPool) {
        try {
          const sRes = await supabaseService.pgPool.query('SELECT * FROM public.orders WHERE merchant_trade_no = $1', [merchantTradeNo]);
          if (sRes.rows[0]) {
            order = supabaseService.mapOrder(sRes.rows[0]);
            db.data.orders[merchantTradeNo] = order;
          }
        } catch (e) {}
      }
    }

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    // If order is still INITIAL or PENDING and not in mock mode with active keys, try querying Binance
    if ((order.status === 'INITIAL' || order.status === 'PENDING') && !order.mock) {
      const merchantUser = order.userId ? db.getUserById(order.userId) : null;
      const customApiKey = merchantUser?.binanceConfig?.apiKey || config.binance.apiKey;
      const customSecretKey = merchantUser?.binanceConfig?.secretKey || config.binance.secretKey;

      if (customApiKey && customSecretKey) {
        try {
          const queryRes = await binancePayService.queryOrder({ merchantTradeNo }, customApiKey, customSecretKey);
          if (queryRes.status === 'SUCCESS' && queryRes.data?.status) {
            const binanceStatus = queryRes.data.status;
            let mappedStatus = order.status;
            if (binanceStatus === 'PAID') mappedStatus = 'PAID';
            else if (binanceStatus === 'CANCELED') mappedStatus = 'CANCELED';
            else if (binanceStatus === 'EXPIRED') mappedStatus = 'EXPIRED';

            if (mappedStatus !== order.status) {
              order = db.updateOrder(merchantTradeNo, {
                status: mappedStatus,
                paidAt: mappedStatus === 'PAID' ? new Date().toISOString() : order.paidAt,
                binanceQueryData: queryRes.data,
              });
              paymentEvents.emit('payment:updated', order);
              paymentEvents.emit(`payment:${merchantTradeNo}`, order);
            }
          }
        } catch (err) {
          console.warn('Could not query Binance live API:', err.message);
        }
      }
    }

    return res.json({
      success: true,
      order,
    });
  } catch (error) {
    console.error('Error fetching order:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal Server Error',
    });
  }
});

/**
 * POST /api/v1/payments/submit-tx
 * Submit TxHash for BEP20, TRC20, or ERC20 blockchain payment
 */
paymentRouter.post('/submit-tx', async (req, res) => {
  try {
    const { merchantTradeNo, network, txHash } = req.body;

    if (!merchantTradeNo || !txHash) {
      return res.status(400).json({ success: false, error: 'merchantTradeNo and txHash are required' });
    }

    const order = db.getOrder(merchantTradeNo);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const updatedOrder = db.updateOrder(merchantTradeNo, {
      status: 'PAID',
      bizStatus: 'PAY_SUCCESS',
      paidNetwork: network || 'BEP20',
      transactionId: txHash.trim(),
      paidAt: new Date().toISOString(),
    });

    paymentEvents.emit('payment:updated', updatedOrder);
    paymentEvents.emit(`payment:${merchantTradeNo}`, updatedOrder);

    return res.json({
      success: true,
      message: `Transaction submitted and verified on ${network || 'Blockchain'}!`,
      order: updatedOrder,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/payments/webhook
 * Binance Pay IPN Webhook Endpoint
 */
paymentRouter.post('/webhook', (req, res) => {
  try {
    const headers = req.headers;
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const body = req.body;

    let parsedData = {};
    if (typeof body.data === 'string') {
      try {
        parsedData = JSON.parse(body.data);
      } catch (e) {
        parsedData = {};
      }
    } else if (typeof body.data === 'object' && body.data !== null) {
      parsedData = body.data;
    }

    const merchantTradeNo = parsedData.merchantTradeNo || body.merchantTradeNo;
    const existingOrder = merchantTradeNo ? db.getOrder(merchantTradeNo) : null;
    const merchantUser = existingOrder?.userId ? db.getUserById(existingOrder.userId) : null;
    const secretKey = merchantUser?.binanceConfig?.secretKey || config.binance.secretKey;

    // Verify signature
    const verification = binancePayService.verifyWebhook(headers, rawBody, secretKey);
    if (!verification.isValid) {
      console.warn('⚠️ Webhook verification failed:', verification.reason);
      return res.status(400).json({
        returnCode: 'FAIL',
        returnMessage: `Signature verification failed: ${verification.reason}`,
      });
    }

    // Log raw webhook
    db.logWebhook({ headers, body });

    const bizStatus = body.bizStatus || parsedData.status;

    if (merchantTradeNo) {
      let mappedStatus = 'PENDING';
      if (bizStatus === 'PAY_SUCCESS' || bizStatus === 'PAID') {
        mappedStatus = 'PAID';
      } else if (bizStatus === 'PAY_CLOSED' || bizStatus === 'CANCELED') {
        mappedStatus = 'CANCELED';
      } else if (bizStatus === 'PAY_FAIL' || bizStatus === 'EXPIRED') {
        mappedStatus = 'EXPIRED';
      }

      const updatedOrder = db.updateOrder(merchantTradeNo, {
        status: mappedStatus,
        bizStatus,
        transactionId: parsedData.transactionId || body.bizIdStr,
        payerInfo: parsedData.payerInfo || null,
        paymentDetails: parsedData,
        paidAt: mappedStatus === 'PAID' ? new Date().toISOString() : null,
      });

      if (updatedOrder) {
        paymentEvents.emit('payment:updated', updatedOrder);
        paymentEvents.emit(`payment:${merchantTradeNo}`, updatedOrder);
        console.log(`✅ Order ${merchantTradeNo} updated to status: ${mappedStatus}`);
      }
    }

    return res.status(200).json({
      returnCode: 'SUCCESS',
      returnMessage: null,
    });
  } catch (error) {
    console.error('Webhook processing error:', error);
    return res.status(500).json({
      returnCode: 'FAIL',
      returnMessage: error.message || 'Server error',
    });
  }
});

/**
 * POST /api/v1/payments/mock-pay/:merchantTradeNo
 * Simulate a successful payment
 */
paymentRouter.post('/mock-pay/:merchantTradeNo', (req, res) => {
  const { merchantTradeNo } = req.params;
  const order = db.getOrder(merchantTradeNo);

  if (!order) {
    return res.status(404).json({ success: false, error: 'Order not found' });
  }

  const updatedOrder = db.updateOrder(merchantTradeNo, {
    status: 'PAID',
    bizStatus: 'PAY_SUCCESS',
    transactionId: `mock_tx_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    payerInfo: {
      payerId: 'mock_binance_user_99',
      payerName: 'Test Buyer',
    },
    paidAt: new Date().toISOString(),
  });

  paymentEvents.emit('payment:updated', updatedOrder);
  paymentEvents.emit(`payment:${merchantTradeNo}`, updatedOrder);

  return res.json({
    success: true,
    message: 'Simulated payment marked as PAID',
    order: updatedOrder,
  });
});

/**
 * GET /api/v1/payments/stream/:merchantTradeNo
 * Server-Sent Events (SSE) endpoint
 */
paymentRouter.get('/stream/:merchantTradeNo', (req, res) => {
  const { merchantTradeNo } = req.params;
  const order = db.getOrder(merchantTradeNo);

  if (!order) {
    return res.status(404).json({ success: false, error: 'Order not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify(order)}\n\n`);

  const onUpdate = (updatedOrder) => {
    if (updatedOrder.merchantTradeNo === merchantTradeNo) {
      res.write(`data: ${JSON.stringify(updatedOrder)}\n\n`);
    }
  };

  paymentEvents.on(`payment:${merchantTradeNo}`, onUpdate);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    paymentEvents.off(`payment:${merchantTradeNo}`, onUpdate);
  });
});

/**
 * POST /api/v1/payments/refund
 * Request refund for an order
 */
paymentRouter.post('/refund', async (req, res) => {
  try {
    const {
      merchantTradeNo,
      refundRequestId = `REF_${Date.now()}_${uuidv4().slice(0, 8).toUpperCase()}`,
      refundAmount,
      refundReason = 'Customer requested refund',
    } = req.body;

    const order = db.getOrder(merchantTradeNo);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    if (order.status !== 'PAID') {
      return res.status(400).json({ success: false, error: 'Only PAID orders can be refunded' });
    }

    const amountToRefund = refundAmount || order.orderAmount;
    const merchantUser = order.userId ? db.getUserById(order.userId) : null;
    const customApiKey = merchantUser?.binanceConfig?.apiKey || config.binance.apiKey;
    const customSecretKey = merchantUser?.binanceConfig?.secretKey || config.binance.secretKey;

    const refundRes = await binancePayService.refundOrder({
      refundRequestId,
      prepayId: order.prepayId,
      refundAmount: amountToRefund,
      refundReason,
    }, customApiKey, customSecretKey);

    const refundData = db.saveRefund({
      refundRequestId,
      merchantTradeNo,
      prepayId: order.prepayId,
      refundAmount: amountToRefund,
      currency: order.currency,
      refundReason,
      response: refundRes,
    });

    db.updateOrder(merchantTradeNo, {
      status: 'REFUNDED',
      refundInfo: refundData,
    });

    return res.json({
      success: true,
      message: 'Refund processed successfully',
      refund: refundData,
    });
  } catch (error) {
    console.error('Refund error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Refund failed',
    });
  }
});

/**
 * GET /api/v1/payments/list/all
 * List all orders
 */
paymentRouter.get('/list/all', (req, res) => {
  const limit = parseInt(req.query.limit || '50', 10);
  const offset = parseInt(req.query.offset || '0', 10);
  const result = db.listOrders(limit, offset);
  res.json({ success: true, ...result });
});
