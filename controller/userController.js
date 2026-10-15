const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

// Compared against when no user matches, so a missing username takes the same
// time as a wrong password (prevents username enumeration by response timing).
const TIMING_EQUALIZER_HASH = '$2b$10$ACEyvTV1oNFoUEOxf0MQAO/QghPfPGtY1bf2hR6oOvcO8pI1Yaw5.';

/**
 * Verifies a submitted password against a stored bcrypt hash. Tries the raw
 * value first (hashes are stored untrimmed) and then the trimmed copy, so
 * passwords typed with stray spaces still work.
 */
const passwordMatches = async (password, hash) => {
  if (await bcrypt.compare(password, hash)) return true;
  const trimmed = password.trim();
  return trimmed !== password && (await bcrypt.compare(trimmed, hash));
};

/**
 * Lists all users belonging to the requester's business (without password hashes).
 */
const listUsers = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, username, role, created_at FROM users WHERE business_id = $1 ORDER BY username ASC',
      [req.user.businessId]
    );
    // Alias `_id` too so older mobile builds keep working.
    res.json(result.rows.map((row) => ({ _id: row.id, ...row })));
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Handles user login using Bcrypt with tenant assignment.
 */
const loginUser = async (req, res) => {
  const { username, password, businessName } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: 'Username and password are required.'
    });
  }

  try {
    // Usernames are only unique PER BUSINESS, so this query must never be
    // allowed to pick an arbitrary row across tenants: fetch every match,
    // scope to the business when one is given, and refuse ambiguous logins.
    let queryText = `
      SELECT u.id, u.username, u.password_hash, u.role, u.business_id, b.name as business_name
      FROM users u
      JOIN businesses b ON u.business_id = b.id
      WHERE LOWER(u.username) = LOWER($1)
    `;
    const queryParams = [username.trim()];

    // If businessName is specified, scope strictly to that business
    if (businessName && businessName.trim()) {
      queryText += ' AND LOWER(b.name) = LOWER($2)';
      queryParams.push(businessName.trim());
    }

    queryText += ' ORDER BY u.username ASC';

    const result = await db.query(queryText, queryParams);
    const matches = result.rows;

    if (matches.length === 0) {
      // Spend the same time as a real password check would.
      await bcrypt.compare(password, TIMING_EQUALIZER_HASH);
      return res.status(401).json({
        success: false,
        message: 'Invalid Username or Password.'
      });
    }

    if (matches.length > 1) {
      // Same username exists in several businesses — never guess a tenant.
      // Check the password against every match first, so a wrong password
      // still just reports invalid credentials instead of revealing that the
      // username is used by more than one shop.
      const anyMatch = (
        await Promise.all(matches.map((m) => passwordMatches(password, m.password_hash)))
      ).some(Boolean);

      if (!anyMatch) {
        return res.status(401).json({
          success: false,
          message: 'Invalid Username or Password.'
        });
      }

      return res.status(400).json({
        success: false,
        message: 'This username belongs to multiple shops. Please provide your business name.'
      });
    }

    const user = matches[0];

    const isMatch = await passwordMatches(password, user.password_hash);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid Username or Password.'
      });
    }

    // Sign a JWT containing user identity and the tenant businessId
    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: user.role,
        businessId: user.business_id
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        businessId: user.business_id,
        businessName: user.business_name
      }
    });
  } catch (error) {
    console.error('Login Error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Server error during login.'
    });
  }
};

module.exports = { loginUser, listUsers };