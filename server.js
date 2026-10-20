require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const Razorpay = require('razorpay');

const app = express();
app.use(cors());
app.use(express.json());

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const REQUESTS_FILE = path.join(DATA_DIR, 'requests.json');

[DATA_DIR, UPLOAD_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]');
if (!fs.existsSync(REQUESTS_FILE)) fs.writeFileSync(REQUESTS_FILE, '[]');
if (!fs.existsSync(PRODUCTS_FILE)) fs.writeFileSync(PRODUCTS_FILE, '[]');

function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } }
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

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

// Products
app.get('/api/products', (req, res) => { res.json(readJSON(PRODUCTS_FILE, [])); });

app.post('/api/admin/products', requireAdmin, upload.single('image'), (req, res) => {
  const { name, category, price, description } = req.body;
  const products = readJSON(PRODUCTS_FILE, []);
  const product = { id: Date.now(), name, category, price: parseFloat(price), description, imageUrl: req.file ? ('/uploads/' + req.file.filename) : null, date: new Date().toISOString() };
  products.push(product);
  writeJSON(PRODUCTS_FILE, products);
  res.json(product);
});

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  let products = readJSON(PRODUCTS_FILE, []);
  products = products.filter(p => p.id !== Number(req.params.id));
  writeJSON(PRODUCTS_FILE, products);
  res.json({ deleted: true });
});

// Checkout (Online & COD)
app.post('/api/checkout', async (req, res) => {
  try {
    const { items, customer, paymentMethod } = req.body;
    const products = readJSON(PRODUCTS_FILE, []);
    let total = 0;
    const lineItems = [];
    
    for (const { id, qty } of items) {
      const product = products.find(p => p.id === Number(id));
      if (product) { total += product.price * qty; lineItems.push({ id: product.id, name: product.name, price: product.price, qty }); }
    }
    if (total <= 0) return res.status(400).json({ error: 'Empty cart' });

    const orderId = 'ORD_' + Date.now();
    
    if (paymentMethod === 'cod') {
      const orders = readJSON(ORDERS_FILE, []);
      orders.push({ id: orderId, status: 'COD Pending', date: new Date().toISOString(), customer, items: lineItems, amount: total });
      writeJSON(ORDERS_FILE, orders);
      return res.json({ success: true, message: 'COD Order placed' });
    } 
    
    // Online Payment
    const rzpOrder = await razorpay.orders.create({ amount: Math.round(total * 100), currency: 'INR', receipt: orderId });
    const orders = readJSON(ORDERS_FILE, []);
    orders.push({ id: rzpOrder.id, status: 'pending', date: new Date().toISOString(), customer, items: lineItems, amount: total });
    writeJSON(ORDERS_FILE, orders);
    res.json({ success: true, orderId: rzpOrder.id, amount: rzpOrder.amount, currency: 'INR' });
  } catch (err) {
    res.status(500).json({ error: 'Checkout failed' });
  }
});

app.post('/api/verify-payment', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
  const verified = expected === razorpay_signature;
  
  if (verified) {
    const orders = readJSON(ORDERS_FILE, []);
    const order = orders.find(o => o.id === razorpay_order_id);
    if (order) { order.status = 'Paid'; order.paymentId = razorpay_payment_id; writeJSON(ORDERS_FILE, orders); }
  }
  res.json({ verified });
});

// Wanted Requests (Buyer looking for a product)
app.post('/api/wanted-request', (req, res) => {
  const { buyerName, buyerPhone, wantedProduct } = req.body;
  if(!buyerName || !buyerPhone || !wantedProduct) return res.status(400).json({error: 'Missing fields'});
  
  const requests = readJSON(REQUESTS_FILE, []);
  requests.push({ id: 'REQ_'+Date.now(), buyerName, buyerPhone, wantedProduct, date: new Date().toISOString() });
  writeJSON(REQUESTS_FILE, requests);
  res.json({ success: true });
});

// Admin Fetch
app.get('/api/admin/orders', requireAdmin, (req, res) => res.json(readJSON(ORDERS_FILE, []).reverse()));
app.get('/api/admin/requests', requireAdmin, (req, res) => res.json(readJSON(REQUESTS_FILE, []).reverse()));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('ReVibe server running on port ' + PORT));