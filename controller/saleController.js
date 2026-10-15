const db = require('../db');
const { sanitizeItems, executeSaleTransaction } = require('../services/saleService');

/**
 * 1. Process a single sale (Online checkout) with full ACID transaction.
 * Guarantees zero negative stock and atomic checkout.
 */
exports.processSale = async (req, res) => {
  const { items, date, clientSaleId } = req.body;
  const businessId = req.user.businessId;
  const soldBy = req.user.id;
  const soldByName = req.user.username;

  try {
    const cleanItems = sanitizeItems(items);
    if (cleanItems.length === 0) {
      return res.status(400).json({ success: false, error: 'Sale must contain at least one valid item.' });
    }

    const saleId = await db.withTransaction(async (client) =>
      executeSaleTransaction({
        client,
        items: cleanItems,
        businessId,
        soldBy,
        soldByName,
        date,
        clientSaleId
        // No grandTotal here on purpose: prices and totals are always
        // resolved server-side from the products table.
      })
    );

    res.status(201).json({ success: true, message: 'Sale processed!', saleId });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

/**
 * 2. Sync multiple sales from Offline storage (High Performance Batch Sync with Idempotency)
 */
exports.syncBulkSales = async (req, res) => {
  const { sales } = req.body;
  const businessId = req.user.businessId;

  if (!Array.isArray(sales) || sales.length === 0) {
    return res.status(400).json({ success: false, error: 'No sales to sync.' });
  }

  // Guardrail limit to avoid payload abuse
  if (sales.length > 250) {
    return res.status(400).json({ success: false, error: 'Maximum 250 sales per batch allowed.' });
  }

  try {
    const syncedCount = await db.withTransaction(async (client) => {
      let count = 0;

      for (const saleData of sales) {
        const cleanItems = sanitizeItems(saleData.items);
        if (cleanItems.length === 0) continue;

        const grandTotal = Number(saleData.grandTotal) || cleanItems.reduce((s, i) => s + i.subtotal, 0);
        const saleDate = saleData.date ? new Date(saleData.date) : new Date();
        const sellerName = saleData.soldBy || req.user.username;

        // Idempotent insert: If client generated an id (UUID), prevent duplicates!
        let saleId = saleData.id;
        let saleRes;

        if (saleId) {
          saleRes = await client.query(
            `INSERT INTO sales (id, business_id, sold_by, sold_by_name, grand_total, date, synced_from, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'mobile', 'synced')
             ON CONFLICT (id) DO NOTHING
             RETURNING id`,
            [saleId, businessId, req.user.id, sellerName, grandTotal, saleDate]
          );

          // If the sale was already synced in a previous request, skip re-decrementing stock!
          if (saleRes.rows.length === 0) {
            continue;
          }
        } else {
          saleRes = await client.query(
            `INSERT INTO sales (business_id, sold_by, sold_by_name, grand_total, date, synced_from, status)
             VALUES ($1, $2, $3, $4, $5, 'mobile', 'synced')
             RETURNING id`,
            [businessId, req.user.id, sellerName, grandTotal, saleDate]
          );
          saleId = saleRes.rows[0].id;
        }

        // Insert items and adjust stock
        for (const it of cleanItems) {
          await client.query(
            `INSERT INTO sale_items (sale_id, business_id, name, qty, price, subtotal)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [saleId, businessId, it.name, it.qty, it.price, it.subtotal]
          );

          // Deduct from stock (ensures stock does not drop below zero)
          await client.query(
            `UPDATE products
             SET stock = GREATEST(0, stock - $1)
             WHERE LOWER(name) = LOWER($2) AND business_id = $3`,
            [it.qty, it.name, businessId]
          );
        }

        count++;
      }

      return count;
    });

    res.status(200).json({ success: true, message: 'Bulk sync completed!', synced: syncedCount });
  } catch (error) {
    console.error('[sync-bulk] error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * 3. High Performance Server-Side Sales Summary (Fast SQL Aggregation)
 * Replaces downloading all sales documents to mobile devices!
 */
exports.getSalesSummary = async (req, res) => {
  const businessId = req.user.businessId;
  try {
    // Total revenue & transactions
    const totalRes = await db.query(
      `SELECT COALESCE(SUM(grand_total), 0)::float as total_revenue, COUNT(*)::int as total_transactions
       FROM sales
       WHERE business_id = $1`,
      [businessId]
    );

    // Sales grouped by cashier
    const cashierRes = await db.query(
      `SELECT sold_by_name as name, COALESCE(SUM(grand_total), 0)::float as amount, COUNT(*)::int as sales_count
       FROM sales
       WHERE business_id = $1
       GROUP BY sold_by_name
       ORDER BY amount DESC`,
      [businessId]
    );

    res.json({
      success: true,
      totalRevenue: totalRes.rows[0]?.total_revenue || 0,
      totalTransactions: totalRes.rows[0]?.total_transactions || 0,
      cashierTotals: cashierRes.rows
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * 4. List sales with pagination (Admin only)
 */
exports.getSales = async (req, res) => {
  const businessId = req.user.businessId;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const offset = parseInt(req.query.offset, 10) || 0;

  try {
    const salesRes = await db.query(
      `SELECT s.id, s.sold_by_name, s.grand_total::float, s.date, s.status,
              COALESCE(
                json_agg(
                  json_build_object(
                    'name', si.name,
                    'qty', si.qty,
                    'price', si.price::float,
                    'subtotal', si.subtotal::float
                  )
                ) FILTER (WHERE si.id IS NOT NULL), '[]'
              ) as items
       FROM sales s
       LEFT JOIN sale_items si ON s.id = si.sale_id
       WHERE s.business_id = $1
       GROUP BY s.id
       ORDER BY s.date DESC
       LIMIT $2 OFFSET $3`,
      [businessId, limit, offset]
    );

    // Normalize property names for backwards compatibility with mobile app
    const formatted = salesRes.rows.map((row) => ({
      _id: row.id,
      id: row.id,
      soldBy: row.sold_by_name,
      grandTotal: row.grand_total,
      date: row.date,
      status: row.status,
      items: row.items
    }));

    res.json(formatted);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};