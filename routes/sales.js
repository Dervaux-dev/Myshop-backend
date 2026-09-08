const express = require('express');
const router = express.Router();
const Sale = require('../models/Sale');
const { processSale, syncBulkSales } = require('../controller/saleController');
const { auth, adminOnly } = require('../middleware/auth');

// Process a new sale and update stock (both admin and staff can sell)
router.post('/process', auth, processSale);

// Sync multiple offline sales (Hybrid Sync)
router.post('/sync-bulk', auth, syncBulkSales);

// List all sales (admin-only - revenue data)
router.get('/', auth, adminOnly, async (req, res) => {
  try {
    const sales = await Sale.find().sort({ date: -1 });
    res.json(sales);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
