const express = require('express');
const router = express.Router();
const receiptController = require('../controller/receiptController');
const { auth, adminOnly } = require('../middleware/auth');

// All receipt actions require a valid user login (JWT)
router.use(auth);

// Staff: create a pending receipt with a unique payment ref (QR payment order)
router.post('/', receiptController.generateReceipt);

// Admin: list receipts (optional ?status=pending|paid|cancelled, ?limit)
router.get('/', adminOnly, receiptController.listReceipts);

// Any authenticated user: poll the payment status of a receipt
router.get('/:paymentRef', receiptController.lookupReceipt);

// Staff/admin: cancel a pending receipt (no stock impact)
router.post('/:paymentRef/cancel', receiptController.cancelReceipt);

module.exports = router;