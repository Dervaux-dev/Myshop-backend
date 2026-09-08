const Product = require('../models/product');

const validateProduct = (body, { partial = false } = {}) => {
  const errors = [];
  const { name, price, stock } = body;

  if (!partial || name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      errors.push('name is required and must be a non-empty string');
    }
  }
  if (!partial || price !== undefined) {
    if (typeof price !== 'number' || isNaN(price) || price < 0) {
      errors.push('price is required and must be a non-negative number');
    }
  }
  if (!partial || stock !== undefined) {
    if (typeof stock !== 'number' || isNaN(stock) || stock < 0) {
      errors.push('stock is required and must be a non-negative number');
    }
  }
  return errors;
};

exports.getProducts = async (req, res) => {
  try {
    const products = await Product.find();
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.addProduct = async (req, res) => {
  try {
    const errors = validateProduct(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: errors.join('; ') });
    }

    const newProduct = new Product(req.body);
    await newProduct.save();
    res.status(201).json({ success: true, product: newProduct });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.updateProduct = async (req, res) => {
  try {
    const errors = validateProduct(req.body, { partial: true });
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: errors.join('; ') });
    }

    const updatedProduct = await Product.findByIdAndUpdate(
      req.params.id, 
      req.body, 
      { new: true, runValidators: true }
    );
    if (!updatedProduct) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    res.json({ success: true, product: updatedProduct });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    const deleted = await Product.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    res.json({ success: true, message: 'Product deleted' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.restockProduct = async (req, res) => {
  try {
    const { quantity } = req.body;
    if (!quantity || quantity <= 0) {
      return res.status(400).json({ success: false, error: 'Quantity must be positive' });
    }
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    product.stock += quantity;
    await product.save();
    res.json({ success: true, product });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};
