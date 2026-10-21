require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const multer = require('multer');
const Razorpay = require('razorpay');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
app.use(cors());
app.use(express.json());

// ===== Cloudinary Setup =====
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ===== MongoDB Connection =====
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB Atlas'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// ===== Mongoose Models =====
const ProductSchema = new mongoose.Schema({
  name: String, category: String, price: Number, description: String, imageUrls: [String], date: { type: Date, default: Date.now }
});
const Product = mongoose.model('Product', ProductSchema);

const OrderSchema = new mongoose.Schema({
  razorpayOrderId: String, status: String, date: { type: Date, default: Date.now }, customer: { name: String, phone: String, address: String }, items: Array, amount: Number
});
const Order = mongoose.model('Order', OrderSchema);

const RequestSchema = new mongoose.Schema({
  buyerName: String, buyerPhone: String, wantedProduct: String, date: { type: Date, default: Date.now }
});
const Request = mongoose.model('Request', RequestSchema);

// ===== Express Static =====
app.use(express.static('public'));

// ===== Multer Cloudinary Storage Setup =====
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'revibe_uploads', // Cloudinary folder name
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp']
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 5 * 1024 * 1024 } });

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'placeholder',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'placeholder'
});

function requireAdmin(req, res, next) {
  const key = req.header('x-admin-key');
  if (!key || key !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ===== API Routes =====
app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.find().sort({ date: -1 }).lean();
    res.json(products.map(p => ({ ...p, id: p._id.toString() })));
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/products', requireAdmin, upload.array('images', 5), async (req, res) => {
  try {
    const { name, category, price, description } = req.body;
    // Cloudinary returns the full URL in file.path
    const imageUrls = req.files ? req.files.map(file => file.path) : [];
    const product = await Product.create({ name, category, price: parseFloat(price), description, imageUrls });
    res.json({ ...product.toObject(), id: product._id.toString() });
  } catch (err) { res.status(500).json({ error: 'Failed to add product' }); }
});

app.put('/api/admin/products/:id', requireAdmin, upload.array('images', 5), async (req, res) => {
  try {
    const { name, category, price, description } = req.body;
    const updateData = { name, category, price: parseFloat(price), description };
    
    if (req.files && req.files.length > 0) {
      updateData.imageUrls = req.files.map(file => file.path);
    }
    
    const product = await Product.findByIdAndUpdate(req.params.id, updateData, { new: true });
    res.json({ ...product.toObject(), id: product._id.toString() });
  } catch (err) { res.status(500).json({ error: 'Failed to update product' }); }
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: 'Failed to delete' }); }
});

app.post('/api/checkout', async (req, res) => {
  try {
    const { items, customer, paymentMethod } = req.body;
    let total = 0; const lineItems = [];
    for (const { id, qty } of items) {
      const product = await Product.findById(id);
      if (product) { total += product.price * qty; lineItems.push({ id: product._id.toString(), name: product.name, price: product.price, qty }); }
    }
    if (total <= 0) return res.status(400).json({ error: 'Empty cart' });

    if (paymentMethod === 'cod') {
      const order = await Order.create({ status: 'COD Pending', customer, items: lineItems, amount: total });
      return res.json({ success: true, message: 'COD Order placed', orderId: order._id });
    } 
    const rzpOrder = await razorpay.orders.create({ amount: Math.round(total * 100), currency: 'INR', receipt: 'ORD_' + Date.now() });
    await Order.create({ razorpayOrderId: rzpOrder.id, status: 'pending', customer, items: lineItems, amount: total });
    res.json({ success: true, orderId: rzpOrder.id, amount: rzpOrder.amount, currency: 'INR' });
  } catch (err) { res.status(500).json({ error: 'Checkout failed' }); }
});

app.post('/api/verify-payment', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
    if (expected === razorpay_signature) {
      await Order.findOneAndUpdate({ razorpayOrderId: razorpay_order_id }, { status: 'Paid', razorpayPaymentId: razorpay_payment_id });
      res.json({ verified: true });
    } else { res.json({ verified: false }); }
  } catch (err) { res.status(500).json({ error: 'Verification failed' }); }
});

app.post('/api/wanted-request', async (req, res) => {
  try {
    const { buyerName, buyerPhone, wantedProduct } = req.body;
    await Request.create({ buyerName, buyerPhone, wantedProduct });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Request failed' }); }
});

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  try {
    const orders = await Order.find().sort({ date: -1 }).lean();
    res.json(orders.map(o => ({ ...o, id: o._id.toString() })));
  } catch (err) { res.status(500).json({ error: 'Failed to load orders' }); }
});

app.get('/api/admin/requests', requireAdmin, async (req, res) => {
  try {
    const reqs = await Request.find().sort({ date: -1 }).lean();
    res.json(reqs.map(r => ({ ...r, id: r._id.toString() })));
  } catch (err) { res.status(500).json({ error: 'Failed to load requests' }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('🚀 ReVibe server running on port ' + PORT));