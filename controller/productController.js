const db = require('../db');

const validateProduct = (body, { partial = false } = {}) => {
  const errors = [];
  const { name, price, stock } = body;

  if (!partial || name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      errors.push('name is required and must be a non-empty string');
    }
  }
  if (!partial || price !== undefined) {
    const numPrice = Number(price);
    if (isNaN(numPrice) || numPrice < 0) {
      errors.push('price is required and must be a non-negative number');
    }
  }
  if (!partial || stock !== undefined) {
    const numStock = Number(stock);
    if (isNaN(numStock) || numStock < 0 || !Number.isInteger(numStock)) {
      errors.push('stock is required and must be a non-negative integer');
    }
  }
  return errors;
};

// PostgreSQL returns `id`; alias `_id` too so older mobile builds keep working.
const withLegacyAlias = (row) => (row && row.id ? { _id: row.id, ...row } : row);

// 1. Get all products for the tenant business
exports.getProducts = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, barcode, name, price::float, stock, category, created_at
       FROM products
       WHERE business_id = $1
       ORDER BY name ASC`,
      [req.user.businessId]
    );
    res.json(result.rows.map(withLegacyAlias));
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// 2. Add product scoped to tenant business
exports.addProduct = async (req, res) => {
  try {
    const errors = validateProduct(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: errors.join('; ') });
    }

    const { name, price, stock, category, barcode } = req.body;
    const finalBarcode = barcode && barcode.trim() ? barcode.trim() : null;

    const result = await db.query(
      `INSERT INTO products (business_id, barcode, name, price, stock, category)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, barcode, name, price::float, stock, category, created_at`,
      [
        req.user.businessId,
        finalBarcode,
        name.trim(),
        Number(price),
        parseInt(stock, 10),
        (category && category.trim()) || 'General'
      ]
    );

    res.status(201).json({ success: true, product: withLegacyAlias(result.rows[0]) });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({
        success: false,
        error: 'A product with this name already exists in your shop inventory.'
      });
    }
    res.status(400).json({ success: false, error: error.message });
  }
};

// 3. Update product with field whitelisting (Prevents mass-assignment)
exports.updateProduct = async (req, res) => {
  try {
    const errors = validateProduct(req.body, { partial: true });
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: errors.join('; ') });
    }

    const { name, price, stock, category, barcode } = req.body;
    const fields = [];
    const values = [req.params.id, req.user.businessId];

    if (name !== undefined) {
      values.push(name.trim());
      fields.push(`name = $${values.length}`);
    }
    if (price !== undefined) {
      values.push(Number(price));
      fields.push(`price = $${values.length}`);
    }
    if (stock !== undefined) {
      values.push(parseInt(stock, 10));
      fields.push(`stock = $${values.length}`);
    }
    if (category !== undefined) {
      values.push(category.trim());
      fields.push(`category = $${values.length}`);
    }
    if (barcode !== undefined) {
      values.push(barcode ? barcode.trim() : null);
      fields.push(`barcode = $${values.length}`);
    }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields provided to update.' });
    }

    const queryText = `
      UPDATE products
      SET ${fields.join(', ')}
      WHERE id = $1 AND business_id = $2
      RETURNING id, barcode, name, price::float, stock, category, created_at
    `;

    const result = await db.query(queryText, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Product not found in this shop.' });
    }

    res.json({ success: true, product: withLegacyAlias(result.rows[0]) });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({
        success: false,
        error: 'Another product with this name already exists in your shop.'
      });
    }
    res.status(400).json({ success: false, error: error.message });
  }
};

// 4. Delete product
exports.deleteProduct = async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM products WHERE id = $1 AND business_id = $2 RETURNING id',
      [req.params.id, req.user.businessId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Product not found in this shop.' });
    }

    res.json({ success: true, message: 'Product deleted' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

// 5. Restock product atomically (Eliminates lost updates & race conditions)
exports.restockProduct = async (req, res) => {
  try {
    const quantity = parseInt(req.body.quantity, 10);
    if (!quantity || quantity <= 0) {
      return res.status(400).json({ success: false, error: 'Quantity must be a positive integer.' });
    }

    const result = await db.query(
      `UPDATE products
       SET stock = stock + $1
       WHERE id = $2 AND business_id = $3
       RETURNING id, barcode, name, price::float, stock, category`,
      [quantity, req.params.id, req.user.businessId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Product not found in this shop.' });
    }

    res.json({ success: true, product: withLegacyAlias(result.rows[0]) });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};
