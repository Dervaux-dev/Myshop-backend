const mongoose = require('mongoose');

const saleSchema = new mongoose.Schema({
  items: [
    {
      name: { type: String, required: true },
      qty: { type: Number, required: true },
      price: { type: Number, required: true },
      subtotal: { type: Number, required: true }
    }
  ],
  grandTotal: { 
    type: Number, 
    required: true 
  },
  // Who made the sale (derived from the JWT on the backend)
  soldBy: { 
    type: String, 
    default: 'unknown' 
  },
  soldById: { 
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null 
  },
  date: { 
    type: Date, 
    default: Date.now 
  },
  syncedFrom: { 
    type: String, 
    enum: ['mobile', 'web'], 
    default: 'mobile' 
  }
});

module.exports = mongoose.model('Sale', saleSchema);