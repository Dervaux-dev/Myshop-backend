const express = require('express');
const router = express.Router();
const {
  processSale,
  syncBulkSales,
  getSalesSummary,
  getSales
} = require('../controller/saleController');
const { auth, adminOnly } = require('../middleware/auth');

// Process a new sale with atomic inventory update (both admin and staff can sell)
router.post('/process', auth, processSale);

// Sync multiple offline sales (Hybrid Sync with idempotency)
router.post('/sync-bulk', auth, syncBulkSales);

// High-speed server-side aggregation for reports
router.get('/summary', auth, adminOnly, getSalesSummary);

// List sales with pagination (admin-only revenue data)
router.get('/', auth, adminOnly, getSales);

module.exports = router;
