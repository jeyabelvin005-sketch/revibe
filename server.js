require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const Razorpay = require('razorpay');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

// ===== MongoDB Connection =====
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB Atlas'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// ===== Mongoose Models =====
const ProductSchema = new mongoose.Schema({
  name: String,
  category: String,
  price: Number,
  description: String,
  imageUrl: String,
  date: { type: Date, default: Date.now }
});
const Product = mongoose.model('Product', ProductSchema);

const OrderSchema = new mongoose.Schema({
  razorpayOrderId: String,
  status: String,
  date: { type: Date, default: Date.now },
  customer: { name: String, phone: String, address: String },
  items: Array,
  amount: Number
});
const Order = mongoose.model('Order', OrderSchema);

const RequestSchema = new mongoose.Schema({
  buyerName: String,
  buyerPhone: String,
  wantedProduct: String,
  date: { type: Date, default: Date.now }
});
const Request = mongoose.model('Request', RequestSchema);

// ===== Setup =====
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const fs = require('fs');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

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
    const formatted = products.map(p => ({ ...p, id: p._id.toString() }));
    res.json(formatted);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/products', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { name, category, price, description } = req.body;
    const product = await Product.create({
      name, category, price: parseFloat(price), description,
      imageUrl: req.file ? ('/uploads/' + req.file.filename) : null
    });
    res.json({ ...product.toObject(), id: product._id.toString() });
  } catch (err) { res.status(500).json({ error: 'Failed to add product' }); }
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
    let total = 0;
    const lineItems = [];
    
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
    } else {
      res.json({ verified: false });
    }
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
    const formatted = orders.map(o => ({ ...o, id: o._id.toString() }));
    res.json(formatted);
  } catch (err) { res.status(500).json({ error: 'Failed to load orders' }); }
});

app.get('/api/admin/requests', requireAdmin, async (req, res) => {
  try {
    const reqs = await Request.find().sort({ date: -1 }).lean();
    const formatted = reqs.map(r => ({ ...r, id: r._id.toString() }));
    res.json(formatted);
  } catch (err) { res.status(500).json({ error: 'Failed to load requests' }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('🚀 ReVibe server running on port ' + PORT));