const express = require('express');
const router = express.Router();
const { loginUser, listUsers } = require('../controller/userController');
const { auth, adminOnly } = require('../middleware/auth');

// Public: login
router.post('/login', loginUser);

// Admin-only: list all users
router.get('/', auth, adminOnly, listUsers);

module.exports = router;