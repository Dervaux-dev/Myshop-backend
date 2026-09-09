const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

// ---------------------------------------------------------------------------
// Security hardening for PUBLIC/cloud deployment.
// (On a shop LAN the network itself was the firewall; now the API is on the
//  internet, so we must add the protection ourselves.)
// ---------------------------------------------------------------------------

app.set('trust proxy', 1); // be correct behind a reverse proxy (Render/Railway/nginx)

// Hide framework fingerprint and add sane security headers.
app.disable('x-powered-by');
app.use(helmet());

// Fail fast if critical secrets are missing — never run insecure.
if (!process.env.MONGO_URI) {
  console.error('❌ MONGO_URI is not set. Provide it in backend/.env (or host env) before starting.');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error('❌ JWT_SECRET is not set. Set a long random string before starting.');
  process.exit(1);
}
if (process.env.JWT_SECRET === 'myshop_super_secret_key_change_me_2026') {
  console.warn('⚠️  You are using the default JWT_SECRET. Generate a new one before selling this platform.');
}

// CORS: browser apps (the web-build) must be allow-listed via ALLOWED_ORIGINS
// (comma-separated). React Native APK requests send no Origin header, so they
// always pass. In development every origin is allowed for convenience.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);              // mobile app / curl / same-origin
    if (process.env.NODE_ENV !== 'production') return callback(null, true); // dev
    if (allowedOrigins.length === 0) {
      return callback(null, false); // block: no origins allowed yet (set ALLOWED_ORIGINS)
    }
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false); // block: origin not allow-listed
  }
}));

// Middleware — cap request body size to avoid oversized payload abuse.
app.use(express.json({ limit: '1mb' }));

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
  windowMs: 15 * 60 * 1000,       // 15 minutes
  limit: 300,                     // max 300 requests per window per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please slow down.' },
});
app.use('/api', apiLimiter);

// Tighter limit on login: blocks password brute-forcing.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,                      // max 10 attempts per 15 min per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: 'Too many login attempts. Try again later.' },
});
app.use('/api/users/login', loginLimiter);

// Connect to MongoDB Atlas
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB Atlas Connected");
    // Keep the Atlas free/serverless cluster awake. It sleeps after
    // idle (~10 min), making the first login after a break very slow
    // (cold start 10-60s). A lightweight ping every 5 min avoids this.
    const ping = () => mongoose.connection.db.admin().ping()
      .then(() => console.log("⬆️  Atlas kept alive"))
      .catch(() => console.warn("⚠️  Keep-alive ping failed"));
    setInterval(ping, 5 * 60 * 1000);
    setTimeout(ping, 30 * 1000); // first ping shortly after boot
  })
  .catch(err => console.error("❌ Connection Error:", err));

// Define Routes
app.get('/api/health', (req, res) => res.json({ success: true, status: 'ok' }));
app.use('/api/products', require('./routes/productRoutes'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/users', require('./routes/userRoutes'));

const PORT = process.env.PORT || 5000;
// Cloud hosts (Render/Railway) require the server to bind to 0.0.0.0.
// Override with HOST only if you know what you're doing.
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`🚀 MyShop API running on port ${PORT}${HOST !== '0.0.0.0' ? ` (host ${HOST})` : ''}`);
});