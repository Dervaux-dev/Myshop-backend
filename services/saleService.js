/**
 * Shared sale logic used both by the POS checkout (processSale) and by the
 * payment-confirmation webhook. Keeps the ACID inventory algorithm in one place:
 *   1. Group duplicate lines, lock product rows (FOR UPDATE) and verify stock
 *   2. Resolve line prices (server-side) and compute the grand total
 *   3. Deduct inventory atomically
 *   4. Insert sale record (idempotent via clientSaleId)
 *   5. Insert normalized line items
 */
const sanitizeItems = (items) => {
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => ({
      name: String(it && it.name ? it.name : '').trim(),
      qty: parseInt(it && it.qty, 10),
      price: Number(it && it.price),
      subtotal: Number(it && it.subtotal)
    }))
    .filter((it) => it.name && !isNaN(it.qty) && it.qty > 0 && !isNaN(it.price));
};

const calculateTotal = (items) =>
  items.reduce((sum, item) => sum + (item.price * item.qty), 0);

/**
 * Runs a single complete sale inside the provided transaction client.
 * Returns the sale id. Throws on invalid input / insufficient stock.
 *
 * Totals are ALWAYS computed server-side from the resolved line prices —
 * the client-supplied grandTotal is never trusted.
 *
 * @param {object} options
 * @param {import('pg').PoolClient} options.client  transaction client
 * @param {Array}  options.items                    raw line items
 * @param {string} options.businessId
 * @param {string} options.soldBy                   user id
 * @param {string} options.soldByName
 * @param {number} [options.grandTotal]             accepted for compatibility, ignored
 * @param {(string|Date)} [options.date]
 * @param {string} [options.clientSaleId]           client generated id for idempotency
 * @param {string} [options.sourceReceiptId]        receipt that paid for this sale
 * @param {boolean} [options.trustItemPrices]       true only for receipt-backed sales,
 *                                                  whose prices were already resolved
 *                                                  server-side when the receipt was made
 */
const executeSaleTransaction = async ({
  client,
  items,
  businessId,
  soldBy,
  soldByName,
  date,
  clientSaleId,
  sourceReceiptId,
  trustItemPrices
}) => {
  const cleanItems = sanitizeItems(items);
  if (cleanItems.length === 0) {
    throw new Error('Sale must contain at least one valid item.');
  }

  // Step A: group duplicate line items by product, so stock is verified
  // against the TOTAL quantity demanded (two lines of 4 must fail against
  // stock of 5, instead of passing each check individually).
  const groups = new Map();
  for (const item of cleanItems) {
    const key = item.name.toLowerCase();
    const existing = groups.get(key);
    if (existing) {
      existing.totalQty += item.qty;
      existing.lines.push(item);
    } else {
      groups.set(key, { name: item.name, totalQty: item.qty, lines: [item] });
    }
  }

  // Step B: lock product rows (one lock per product) and verify stock
  const verifiedProducts = [];
  for (const group of groups.values()) {
    const prodRes = await client.query(
      `SELECT id, name, stock, price
       FROM products
       WHERE LOWER(name) = LOWER($1) AND business_id = $2
       FOR UPDATE`,
      [group.name, businessId]
    );

    if (prodRes.rows.length === 0) {
      throw new Error(`Product "${group.name}" not found in this shop.`);
    }

    const currentProduct = prodRes.rows[0];
    group.productId = currentProduct.id;
    if (currentProduct.stock < group.totalQty) {
      throw new Error(
        `Insufficient stock for "${currentProduct.name}". Available: ${currentProduct.stock}, requested: ${group.totalQty}.`
      );
    }

    const dbPrice = Number(currentProduct.price);
    for (const line of group.lines) {
      const price = trustItemPrices ? Number(line.price) : dbPrice;
      const subtotal = Number((price * line.qty).toFixed(2));
      verifiedProducts.push({
        productId: currentProduct.id,
        name: currentProduct.name,
        qty: line.qty,
        price,
        subtotal
      });
    }
  }

  const finalGrandTotal = Number(
    verifiedProducts.reduce((sum, item) => sum + item.subtotal, 0).toFixed(2)
  );

  // Step C: Deduct inventory atomically, one UPDATE per product
  for (const group of groups.values()) {
    await client.query(
      `UPDATE products
       SET stock = stock - $1
       WHERE id = $2 AND business_id = $3`,
      [group.totalQty, group.productId, businessId]
    );
  }

  // Step D: Insert sale record (idempotent via clientSaleId)
  const saleDate = date ? new Date(date) : new Date();
  const receiptId = sourceReceiptId || null;
  let saleRes;
  if (clientSaleId) {
    saleRes = await client.query(
      `INSERT INTO sales (id, business_id, sold_by, sold_by_name, grand_total, date, synced_from, status, source_receipt_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'mobile', 'synced', $7)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [clientSaleId, businessId, soldBy, soldByName, finalGrandTotal, saleDate, receiptId]
    );
  } else {
    saleRes = await client.query(
      `INSERT INTO sales (business_id, sold_by, sold_by_name, grand_total, date, synced_from, status, source_receipt_id)
       VALUES ($1, $2, $3, $4, $5, 'mobile', 'synced', $6)
       RETURNING id`,
      [businessId, soldBy, soldByName, finalGrandTotal, saleDate, receiptId]
    );
  }

  const saleId = saleRes.rows[0]?.id || clientSaleId;

  // Step E: Insert line items
  for (const item of verifiedProducts) {
    await client.query(
      `INSERT INTO sale_items (sale_id, business_id, product_id, name, qty, price, subtotal)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [saleId, businessId, item.productId, item.name, item.qty, item.price, item.subtotal]
    );
  }

  return saleId;
};

module.exports = { sanitizeItems, calculateTotal, executeSaleTransaction };