const express = require('express');
const router = express.Router();
const receiptController = require('../controller/receiptController');
const { paymentKeyAuth } = require('../middleware/auth');

// Internal machine-to-machine endpoints for the Python payment service.
// Authenticated with the shared x-payment-key header, not a user JWT.
router.use(paymentKeyAuth);

// The payment service resolves the QR payload's payment ref to a receipt
router.get('/receipts/:paymentRef', receiptController.lookupReceipt);

// The payment service confirms a successful charge; Node records the sale
router.post('/confirm', receiptController.confirmPayment);

module.exports = router;