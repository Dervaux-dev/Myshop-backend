const express = require('express');
const router = express.Router();
const productController = require('../controller/productController');
const { auth, adminOnly } = require('../middleware/auth');

// All product routes require a valid login (JWT)
router.use(auth);

// Any authenticated user (admin or staff) can view inventory
router.get('/', productController.getProducts);

// Mutations are admin-only
router.post('/add', adminOnly, productController.addProduct);
router.put('/:id', adminOnly, productController.updateProduct);
router.delete('/:id', adminOnly, productController.deleteProduct);
router.post('/:id/restock', adminOnly, productController.restockProduct);

module.exports = router;
