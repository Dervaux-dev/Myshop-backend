const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();
const User = require('./User'); // Reba ko iyi path ari yo

const seedUsers = async () => {
  try {
    // 1. Huza na Database
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB for seeding...");

    // 2. Hanagura abari basanzwe (Niba ushaka gutangira bushya)
    await User.deleteMany();

    // 3. Tegura Password (ziranditse/hashed kuko ni zo zizakora kuri Login)
    const salt = await bcrypt.genSalt(10);
    const adminPassword = await bcrypt.hash('admin123', salt); // Password y'admin
    const staffPassword = await bcrypt.hash('staff123', salt); // Password ya staff

    // 4. Amakuru y'abantu (JSON)
    const users = [
      {
        username: 'admin',
        password: adminPassword,
        role: 'admin'
      },
      {
        username: 'staff',
        password: staffPassword,
        role: 'staff'
      }
    ];

    // 5. Babike bose
    await User.insertMany(users);
    console.log("✅ Admin na Staff babitswe neza!");
    process.exit();
  } catch (error) {
    console.error("❌ Seeding failed:", error);
    process.exit(1);
  }
};

seedUsers();