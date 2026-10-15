const crypto = require('crypto');
const db = require('../db');
const { sanitizeItems, executeSaleTransaction } = require('../services/saleService');

// ---------------------------------------------------------------------------
// QR payload: a payment link the customer's phone opens when scanning.
//   e.g.  https://pay-frontend-beta.vercel.app/?ref=<payment_ref>&amount=1500.00&currency=RWF
// The site reads `ref` (unique payment id), converts the local amount to
// sats, charges the customer into the shop's wallet, then confirms the
// payment back to this backend via POST /api/payments/confirm.
// Base URL is configurable through PAYMENT_BASE_URL (backend/.env).
// ---------------------------------------------------------------------------
const DEFAULT_CURRENCY = 'RWF';
const FALLBACK_PAYMENT_BASE_URL = 'https://pay-frontend-beta.vercel.app';

const buildQrPayload = (paymentRef, amount, currency = DEFAULT_CURRENCY) => {
  const baseUrl = process.env.PAYMENT_BASE_URL || FALLBACK_PAYMENT_BASE_URL;
  const url = new URL(baseUrl);
  url.searchParams.set('ref', paymentRef);
  url.searchParams.set('amount', Number(amount).toFixed(2));
  url.searchParams.set('currency', String(currency).toUpperCase());
  return url.toString();
};

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const generateReceiptNumber = () => {
  const now = new Date();
  const stamp =
    now.getFullYear().toString().slice(2) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
  return `R${stamp}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
};

const toReceiptDto = (r) => {
  let items = r.items;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch (e) { items = []; }
  }
  return {
    id: r.id,
    receiptNumber: r.receipt_number,
    paymentRef: r.payment_ref,
    soldBy: r.sold_by_name,
    grandTotal: Number(r.grand_total),
    currency: r.currency,
    status: r.status,
    createdAt: r.created_at,
    paidAt: r.paid_at,
    items
  };
};

/**
 * 1. Generate a pending receipt. Totals are computed server-side from the
 *    authoritative product prices (client prices are ignored) so the QR
 *    amount can be trusted by the payment service.
 */
exports.generateReceipt = async (req, res) => {
  const { items } = req.body;
  const businessId = req.user.businessId;

  try {
    const cleanItems = sanitizeItems(items);
    if (cleanItems.length === 0) {
      return res.status(400).json({ success: false, error: 'Receipt must contain at least one valid item.' });
    }
    if (cleanItems.length > 100) {
      return res.status(400).json({ success: false, error: 'Maximum 100 line items per receipt.' });
    }

    // Resolve authoritative prices from the DB and compute the total.
    const resolvedItems = [];
    let grandTotal = 0;
    for (const item of cleanItems) {
      const prodRes = await db.query(
        'SELECT id, name, price FROM products WHERE LOWER(name) = LOWER($1) AND business_id = $2',
        [item.name, businessId]
      );
      if (prodRes.rows.length === 0) {
        throw new HttpError(404, `Product "${item.name}" not found in this shop.`);
      }
      const price = Number(prodRes.rows[0].price);
      const subtotal = Number((price * item.qty).toFixed(2));
      grandTotal += subtotal;
      resolvedItems.push({ name: item.name, qty: item.qty, price, subtotal });
    }
    grandTotal = Number(grandTotal.toFixed(2));

    const paymentRef = crypto.randomUUID();

    // Insert with a retry loop in case the human-readable number collides.
    let receipt;
    for (let attempt = 0; attempt < 3; attempt++) {
      const receiptNumber = generateReceiptNumber();
      try {
        const insertRes = await db.query(
          `INSERT INTO receipts
             (business_id, receipt_number, payment_ref, sold_by, sold_by_name, items, grand_total, currency, status)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'pending')
           RETURNING id, receipt_number, payment_ref, sold_by_name, items, grand_total, currency, status, created_at, paid_at`,
          [
            businessId,
            receiptNumber,
            paymentRef,
            req.user.id,
            req.user.username,
            JSON.stringify(resolvedItems),
            grandTotal,
            DEFAULT_CURRENCY
          ]
        );
        receipt = insertRes.rows[0];
        break;
      } catch (error) {
        if (error.code === '23505' && attempt < 2) continue; // receipt_number collision
        throw error;
      }
    }

    res.status(201).json({
      success: true,
      message: 'Receipt created. Show the QR to the customer to pay.',
      receipt: toReceiptDto(receipt),
      qrPayload: buildQrPayload(receipt.payment_ref, Number(receipt.grand_total), receipt.currency)
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message });
  }
};

/**
 * 2. List receipts (admin only), optionally filtered by status.
 */
exports.listReceipts = async (req, res) => {
  const businessId = req.user.businessId;
  const { status, limit } = req.query;
  const maxLimit = Math.min(parseInt(limit, 10) || 50, 100);

  try {
    const params = [businessId];
    let where = 'WHERE business_id = $1';
    if (status && ['pending', 'paid', 'cancelled'].includes(status)) {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }
    params.push(maxLimit);

    const result = await db.query(
      `SELECT id, receipt_number, payment_ref, sold_by_name, grand_total, currency, status, created_at, paid_at, processor_ref
       FROM receipts ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json(result.rows.map(toReceiptDto));
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * 3. Look up a receipt by its payment reference.
 *    Used by the cashier app to poll status AND by the payment service
 *    (which is authenticated via paymentKeyAuth instead of a user session).
 */
exports.lookupReceipt = async (req, res) => {
  const { paymentRef } = req.params;

  try {
    let result;
    if (req.user) {
      result = await db.query(
        `SELECT id, receipt_number, payment_ref, sold_by_name, items, grand_total, currency, status, created_at, paid_at
         FROM receipts
         WHERE payment_ref = $1 AND business_id = $2`,
        [paymentRef, req.user.businessId]
      );
    } else if (req.paymentService) {
      result = await db.query(
        `SELECT id, receipt_number, payment_ref, sold_by_name, items, grand_total, currency, status, created_at, paid_at
         FROM receipts
         WHERE payment_ref = $1`,
        [paymentRef]
      );
    } else {
      return res.status(403).json({ success: false, error: 'Forbidden.' });
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Receipt not found.' });
    }
    res.json({ success: true, receipt: toReceiptDto(result.rows[0]) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * 4. Cancel a pending receipt (staff/admin). Since stock is only deducted on
 *    payment confirmation, cancelling costs nothing.
 */
exports.cancelReceipt = async (req, res) => {
  const { paymentRef } = req.params;

  try {
    const result = await db.query(
      `UPDATE receipts SET status = 'cancelled'
       WHERE payment_ref = $1 AND business_id = $2 AND status = 'pending'
       RETURNING id, receipt_number, status`,
      [paymentRef, req.user.businessId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Pending receipt not found.' });
    }
    res.json({ success: true, message: 'Receipt cancelled.', receipt: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * 5. Webhook called by the Python payment SERVICE after a successful charge.
 *    Authenticated via paymentKeyAuth (x-payment-key header), NOT a user token.
 *
 *    Atomically: mark receipt paid -> deduct stock -> record the sale.
 *    Idempotent: confirming the same payment_ref twice reuses the same sale.
 */
exports.confirmPayment = async (req, res) => {
  const { paymentRef, processorRef } = req.body || {};
  if (!paymentRef) {
    return res.status(400).json({ success: false, error: 'paymentRef is required.' });
  }

  try {
    const result = await db.withTransaction(async (client) => {
      // Lock the receipt row so only one confirmation can ever win.
      const receiptRes = await client.query(
        `SELECT id, business_id, items, grand_total, currency, status, sold_by, sold_by_name
         FROM receipts
         WHERE payment_ref = $1
         FOR UPDATE`,
        [paymentRef]
      );
      const receipt = receiptRes.rows[0];
      if (!receipt) throw new HttpError(404, 'Receipt not found.');

      if (receipt.status === 'paid') {
        const saleRes = await client.query(
          'SELECT id FROM sales WHERE source_receipt_id = $1 LIMIT 1',
          [receipt.id]
        );
        return { alreadyPaid: true, saleId: saleRes.rows[0]?.id || null };
      }
      if (receipt.status === 'cancelled') {
        throw new HttpError(409, 'Receipt has been cancelled.');
      }

      await client.query(
        `UPDATE receipts
         SET status = 'paid', paid_at = NOW(), processor_ref = $2
         WHERE id = $1`,
        [receipt.id, processorRef || null]
      );

      const saleId = await executeSaleTransaction({
        client,
        items: receipt.items,
        businessId: receipt.business_id,
        soldBy: receipt.sold_by,
        soldByName: receipt.sold_by_name,
        date: new Date(),
        sourceReceiptId: receipt.id,
        // Receipt line prices were resolved server-side when it was created
        // (that is the amount the customer agreed to pay), so keep them even
        // if the product price changed in the meantime.
        trustItemPrices: true
      });

      return { alreadyPaid: false, saleId };
    });

    if (result.alreadyPaid) {
      return res.json({
        success: true,
        message: 'Receipt already settled.',
        alreadyPaid: true,
        saleId: result.saleId
      });
    }
    res.json({
      success: true,
      message: 'Payment confirmed. Sale recorded and stock deducted.',
      saleId: result.saleId
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};