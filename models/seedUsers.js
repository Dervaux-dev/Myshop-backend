const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();
const User = require('./User'); // Reba ko iyi path ari yo

const seedUsers = async () => {
  try {
    // 1. Huza na Database
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB for seeding...");

    // 2. Insert default users only if they don't exist (safe for production)
    const existingAdmin = await User.findOne({ username: 'admin' });
    const existingStaff = await User.findOne({ username: 'staff' });

    // 3. Tegura Password (ziranditse/hashed kuko ni zo zizakora kuri Login)
    const salt = await bcrypt.genSalt(10);
    const adminPassword = await bcrypt.hash('admin123', salt); // Password y'admin
    const staffPassword = await bcrypt.hash('staff123', salt); // Password ya staff

    // 4. Amakuru y'abantu (JSON)
    const users = [];
    if (!existingAdmin) {
      users.push({ username: 'admin', password: adminPassword, role: 'admin' });
    }
    if (!existingStaff) {
      users.push({ username: 'staff', password: staffPassword, role: 'staff' });
    }

    // 5. Babike bose (only new users)
    if (users.length > 0) {
      await User.insertMany(users);
      console.log(`✅ ${users.length} new user(s) seeded!`);
    } else {
      console.log("ℹ️  Admin and Staff users already exist. Skipping seed.");
    }
    process.exit();
  } catch (error) {
    console.error("❌ Seeding failed:", error);
    process.exit(1);
  }
};

seedUsers();