const User = require('../models/User');
const bcrypt = require('bcryptjs'); // Make sure to: npm install bcryptjs
const jwt = require('jsonwebtoken');

/**
 * Lists all users (without password hashes).
 */
const listUsers = async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.json(users);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Handles user login using Bcrypt for secure password comparison.
 */
const loginUser = async (req, res) => {
    const { username, password } = req.body;

    try {
        // 1. Find the user by username
        const user = await User.findOne({ username: username.trim() });

        if (!user) {
            return res.status(401).json({ 
                success: false, 
                message: "Invalid Username or Password." 
            });
        }

        // 2. Compare the plain text password from the phone with the HASH in the DB
        const isMatch = await bcrypt.compare(password.trim(), user.password);

        if (isMatch) {
            // Sign a JWT containing the user's id, username, and role
            const token = jwt.sign(
              { id: user._id, username: user.username, role: user.role },
              process.env.JWT_SECRET,
              { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
            );

            res.json({
                success: true,
                token,
                user: {
                    id: user._id,
                    username: user.username,
                    role: user.role
                }
            });
        } else {
            res.status(401).json({ 
                success: false, 
                message: "Invalid Username or Password." 
            });
        }

    } catch (error) {
        console.error("Login Error:", error.message);
        res.status(500).json({ 
            success: false, 
            message: "Server error during login." 
        });
    }
};

module.exports = { loginUser, listUsers };