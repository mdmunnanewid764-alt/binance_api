import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  jwtSecret: process.env.JWT_SECRET || 'binance-gateway-super-secret-jwt-key-2026',
  databaseUrl: process.env.DATABASE_URL || '',
  binance: {
    apiKey: process.env.BINANCE_PAY_API_KEY || '',
    secretKey: process.env.BINANCE_PAY_SECRET_KEY || '',
    baseUrl: process.env.BINANCE_PAY_BASE_URL || 'https://bpay.binanceapi.com',
    spotBaseUrl: process.env.BINANCE_SPOT_BASE_URL || 'https://api.binance.com',
  },
  supabase: {
    url: process.env.SUPABASE_URL || (process.env.DATABASE_URL?.includes('supabase.co') ? `https://${process.env.DATABASE_URL.split('@db.')[1]?.split('.supabase.co')[0]}.supabase.co` : ''),
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '',
  },
  webhookUrl: process.env.WEBHOOK_URL || 'http://localhost:3000/api/v1/payments/webhook',
  mockMode: process.env.MOCK_MODE === 'true' || !process.env.BINANCE_PAY_API_KEY,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
};
