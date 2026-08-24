import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config/env.js';
import { paymentRouter } from './routes/paymentRoutes.js';
import { authRouter } from './routes/authRoutes.js';
import { merchantRouter } from './routes/merchantRoutes.js';
import { adminRouter } from './routes/adminRoutes.js';
import { botManager } from './bot/botManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middlewares
app.use(cors());

// Capture raw body for Binance Pay webhook signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf-8');
  },
}));
app.use(express.urlencoded({ extended: true }));

// Serve static assets
app.use(express.static(path.join(__dirname, '../public')));

// Health check endpoint
app.get('/api/v1/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Binance Pay Payment Gateway',
    timestamp: new Date().toISOString(),
    mockMode: config.mockMode,
    binanceConfigured: !!(config.binance.apiKey && config.binance.secretKey),
    systemTelegramBot: !!config.telegramBotToken,
  });
});

// API Routes
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/merchant', merchantRouter);
app.use('/api/v1/admin', adminRouter);
app.use('/api/v1/payments', paymentRouter);

// Frontend Page Routes
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

app.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/docs.html'));
});

app.get('/demo', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/demo.html'));
});

app.get('/checkout/:merchantTradeNo', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/checkout.html'));
});

// Default root route redirects to /login (Auth First)
app.get('/', (req, res) => {
  res.redirect('/login');
});

// Function to start server
function startServer(port = config.port) {
  const server = app.listen(port, () => {
    console.log('====================================================');
    console.log(`🚀 Binance Pay Multi-Merchant Platform is running!`);
    console.log(`🌐 Server URL:        ${config.baseUrl}`);
    console.log(`🔐 Login Portal:      ${config.baseUrl}/login`);
    console.log(`👑 Admin Account:     ${config.admin.email} (Approval Required)`);
    console.log(`📊 Dashboard:         ${config.baseUrl}/dashboard`);
    console.log(`📖 API Docs:          ${config.baseUrl}/docs`);
    console.log(`⚡ Health Endpoint:   ${config.baseUrl}/api/v1/health`);
    console.log(`🧪 Mock Mode:         ${config.mockMode ? 'ENABLED (Safe testing)' : 'LIVE'}`);
    console.log('====================================================');

    // Initialize all Bots (System + Active Merchant bots)
    botManager.start();
  });

  return server;
}

// Auto-start only if executed directly
if (process.env.NODE_ENV !== 'test' && (!process.argv[1] || process.argv[1].endsWith('server.js'))) {
  startServer();
}

export { app, startServer };
