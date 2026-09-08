const Sale = require('../models/Sale');
const Product = require('../models/Product');

// Sanitize a raw items array: coerce string numbers (from a mobile SQLite DB)
// so they don't cause a mongoose CastError, and drop items without a name.
const sanitizeItems = (items) => {
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => ({
      name: String(it && it.name ? it.name : '').trim(),
      qty: Number(it && it.qty),
      price: Number(it && it.price),
      subtotal: Number(it && it.subtotal)
    }))
    .filter((it) => it.name && isFinite(it.qty) && it.qty > 0);
};

// 1. Process a single sale (Online)
exports.processSale = async (req, res) => {
  const { items, grandTotal, date } = req.body;
  try {
    const cleanItems = sanitizeItems(items);

    if (cleanItems.length === 0) {
      return res.status(400).json({ success: false, error: 'Sale must contain at least one valid item.' });
    }

    const newSale = new Sale({
      items: cleanItems,
      grandTotal: Number(grandTotal) || cleanItems.reduce((s, i) => s + (i.subtotal || 0), 0),
      date,
      // Attach the authenticated user as the seller (from the JWT)
      soldBy: req.user ? req.user.username : 'unknown',
      soldById: req.user ? req.user.id : null
    });
    await newSale.save();

    // Deduct stock for each item
    for (const item of cleanItems) {
      await Product.findOneAndUpdate(
        { name: item.name },
        { $inc: { stock: -item.qty } }
      );
    }
    res.status(201).json({ success: true, message: "Sale processed!" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// 2. Sync multiple sales from Offline storage (Hybrid Sync)
exports.syncBulkSales = async (req, res) => {
  const { sales } = req.body; // sales is an array of sale objects
  try {
    if (!Array.isArray(sales) || sales.length === 0) {
      return res.status(400).json({ success: false, error: "No sales to sync." });
    }

    let syncedCount = 0;

    for (const saleData of sales) {
      const items = sanitizeItems(saleData.items);

      if (items.length === 0) continue;

      const newSale = new Sale({
        items,
        grandTotal: Number(saleData.grandTotal) || items.reduce((s, i) => s + i.subtotal, 0),
        date: saleData.date ? new Date(saleData.date) : Date.now(),
        // Preserve seller if the offline record had one; otherwise use the syncing user
        soldBy: saleData.soldBy || (req.user ? req.user.username : 'unknown'),
        soldById: saleData.soldById || (req.user ? req.user.id : null),
        status: 'synced'
      });
      await newSale.save();

      for (const item of items) {
        await Product.findOneAndUpdate(
          { name: item.name },
          { $inc: { stock: -item.qty } }
        );
      }
      syncedCount++;
    }

    res.status(200).json({ success: true, message: "Bulk sync completed!", synced: syncedCount });
  } catch (error) {
    console.error("[sync-bulk] error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};