const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const db = require('./db');

const app = express();

// ---------------------------------------------------------------------------
// Security hardening for PUBLIC/cloud deployment.
// ---------------------------------------------------------------------------
app.set('trust proxy', 1);

// Hide framework fingerprint and add sane security headers.
app.disable('x-powered-by');
app.use(helmet());

// Fail fast if critical secrets are missing — never run insecure.
if (!process.env.JWT_SECRET) {
  console.error('❌ JWT_SECRET is not set. Set a long random string before starting.');
  process.exit(1);
}
if (process.env.JWT_SECRET === 'myshop_super_secret_key_change_me_2026') {
  console.warn('⚠️  You are using the default JWT_SECRET. Generate a new one before production deployment.');
}
if (!process.env.PAYMENT_API_KEY) {
  console.warn('⚠️  PAYMENT_API_KEY is not set. The payment webhook (/api/payments/*) will refuse requests until configured.');
}

// CORS: browser apps (the web-build) must be allow-listed via ALLOWED_ORIGINS
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);              // mobile app / curl / same-origin
    if (process.env.NODE_ENV !== 'production') return callback(null, true); // dev
    if (allowedOrigins.length === 0) {
      return callback(null, false);
    }
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  }
}));

// Middleware — cap request body size to avoid oversized payload abuse.
app.use(express.json({ limit: '2mb' }));

// Enforce HTTPS in production when behind a TLS-terminating proxy.
app.use((req, res, next) => {
  const proto = req.headers['x-forwarded-proto'];
  if (process.env.NODE_ENV === 'production' && proto && proto !== 'https') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

// ---------------------------------------------------------------------------
// Rate limiting — anti brute-force / abuse
// ---------------------------------------------------------------------------
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 500,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please slow down.' },
});
app.use('/api', apiLimiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: 'Too many login attempts. Try again later.' },
});
app.use('/api/users/login', loginLimiter);

// ---------------------------------------------------------------------------
// Test PostgreSQL Connection
// ---------------------------------------------------------------------------
db.query('SELECT NOW()')
  .then((res) => {
    console.log('✅ PostgreSQL Database Connected. Server time:', res.rows[0].now);
  })
  .catch((err) => {
    console.warn(
      '⚠️  PostgreSQL connection pending/failed: ' + err.message +
      '\n👉 Note: Once you install/start PostgreSQL, run `npm run migrate` to initialize tables.'
    );
  });

// Define Routes
app.get('/api/health', (req, res) => res.json({ success: true, status: 'ok', engine: 'postgresql' }));
app.use('/api/products', require('./routes/productRoutes'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/users', require('./routes/userRoutes'));
app.use('/api/receipts', require('./routes/receiptRoutes'));
app.use('/api/payments', require('./routes/paymentRoutes'));

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`🚀 MyShop Multi-Tenant API running on port ${PORT}${HOST !== '0.0.0.0' ? ` (host ${HOST})` : ''}`);
});