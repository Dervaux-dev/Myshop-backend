const jwt = require('jsonwebtoken');
const crypto = require('crypto');

/**
 * Verifies the JWT from the Authorization header and attaches
 * the decoded user (id, username, role, businessId) to req.user.
 * Enforces tenant identification for multi-business isolation.
 */
const auth = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'No token provided. Please log in.' });
  }

  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = {
      id: decoded.id,
      username: decoded.username,
      role: decoded.role,
      businessId: decoded.businessId || decoded.business_id
    };

    if (!req.user.businessId) {
      return res.status(403).json({
        success: false,
        message: 'Invalid token: Missing business tenant identity. Please re-login.'
      });
    }

    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }
};

/**
 * Ensures the authenticated user is an admin.
 * Must be used AFTER the auth middleware.
 */
const adminOnly = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin access required.' });
  }
  next();
};

/**
 * Authenticates the external payment service (the Python side) via a shared
 * secret in the x-payment-key header. Uses a timing-safe comparison.
 * Attaches req.paymentService = true on success so handlers can distinguish
 * machine-to-machine access from user sessions.
 */
const paymentKeyAuth = (req, res, next) => {
  const configured = process.env.PAYMENT_API_KEY;
  if (!configured) {
    return res.status(503).json({
      success: false,
      error: 'Payment service is not configured (PAYMENT_API_KEY is missing).'
    });
  }

  const provided = req.headers['x-payment-key'];
  if (!provided) {
    return res.status(401).json({ success: false, message: 'Missing payment service API key.' });
  }

  const a = Buffer.from(String(provided));
  const b = Buffer.from(configured);
  const safe = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!safe) {
    return res.status(401).json({ success: false, message: 'Invalid payment service API key.' });
  }

  req.paymentService = true;
  next();
};

module.exports = { auth, adminOnly, paymentKeyAuth };
