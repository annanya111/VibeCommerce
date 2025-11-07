// backend/server.js
// backend/server.js
// Full server with: userId persistence, validation, Fake Store seeding, error handling,
// and exports `app` (so tests can import it if needed). Listens when run directly.

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Simple validation middleware generator
function requireFields(fields = []) {
  return (req, res, next) => {
    for (const f of fields) {
      // check both body and query for convenience
      if ((req.body && (req.body[f] === undefined || req.body[f] === "")) &&
          (req.query && (req.query[f] === undefined || req.query[f] === ""))) {
        return res.status(400).json({ error: `${f} is required` });
      }
    }
    next();
  };
}

const dbFile = path.join(__dirname, 'db.sqlite');
const db = new sqlite3.Database(dbFile);

// Helper: parse userId from query or body (default 1)
function parseUserIdFromReq(req) {
  if (req.query && req.query.userId) return Number(req.query.userId);
  if (req.body && req.body.userId) return Number(req.body.userId);
  return 1;
}

// DB setup & seeding (tries Fake Store API first, falls back)
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS cart (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      productId INTEGER NOT NULL,
      qty INTEGER NOT NULL,
      userId INTEGER DEFAULT 1,
      FOREIGN KEY(productId) REFERENCES products(id)
    )
  `);

  // Ensure userId column exists (in case of older DB)
  db.all("PRAGMA table_info(cart);", (err, rows) => {
    if (err) {
      console.error("PRAGMA table_info error:", err);
    } else {
      const hasUserId = rows && rows.some(r => r.name === "userId");
      if (!hasUserId) {
        db.run("ALTER TABLE cart ADD COLUMN userId INTEGER DEFAULT 1", (alterErr) => {
          if (alterErr) console.error("Failed to add userId column:", alterErr);
          else console.log("Added userId column to cart (default 1)");
        });
      }
    }
  });

  // Seed products if empty. Try Fake Store API first.
  db.get("SELECT COUNT(*) AS count FROM products", async (err, row) => {
    if (err) {
      console.error("DB seed check error:", err);
      return;
    }
    if (row.count === 0) {
      // Try Fake Store API
      try {
        console.log("No products found — attempting to seed from Fake Store API...");
        const res = await fetch("https://fakestoreapi.com/products");
        if (!res.ok) throw new Error("Fake Store response not OK: " + res.status);
        const ext = await res.json();
        const sample = ext.slice(0, 8).map(p => [p.title || p.name || ("Item " + p.id), Number(p.price) || 0]);
        const stmt = db.prepare("INSERT INTO products (name, price) VALUES (?, ?)");
        sample.forEach(item => stmt.run(item[0], item[1]));
        stmt.finalize(() => console.log("Seeded products from Fake Store API"));
        return;
      } catch (fetchErr) {
        console.warn("Fake Store seed failed:", fetchErr.message || fetchErr);
        // fallback to local sample
        const sample = [
          ["Shoes", 1200],
          ["T-Shirt", 700],
          ["Jeans", 1800],
          ["Watch", 2500],
          ["Perfume", 900]
        ];
        const stmt = db.prepare("INSERT INTO products (name, price) VALUES (?, ?)");
        sample.forEach(item => stmt.run(item[0], item[1]));
        stmt.finalize(() => console.log("Seeded fallback sample products"));
      }
    }
  });

}); // db.serialize end

// Generic error handler middleware
function errorHandler(err, req, res, next) {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
}

// Routes

app.get('/', (req, res) => res.json({ ok: true }));

// GET /api/products - list all products
app.get('/api/products', (req, res) => {
  db.all("SELECT id, name, price FROM products", (err, rows) => {
    if (err) {
      console.error('GET /api/products error', err);
      return res.status(500).json({ error: 'Server error fetching products' });
    }
    res.json(rows);
  });
});

// GET /api/cart - return cart items for a given user + total
app.get('/api/cart', (req, res) => {
  const userId = parseUserIdFromReq(req);
  const sql = `
    SELECT c.id as cartId, p.id as productId, p.name, p.price, c.qty
    FROM cart c JOIN products p ON c.productId = p.id
    WHERE c.userId = ?
  `;
  db.all(sql, [userId], (err, rows) => {
    if (err) {
      console.error('GET /api/cart error', err);
      return res.status(500).json({ error: 'Server error fetching cart' });
    }
    const total = rows.reduce((acc, r) => acc + r.price * r.qty, 0);
    res.json({ cart: rows, total });
  });
});

// POST /api/cart { productId, qty, userId } - add or increment for specific user
app.post('/api/cart', requireFields(['productId','qty']), (req, res) => {
  const { productId, qty } = req.body;
  const userId = parseUserIdFromReq(req);
  db.get("SELECT id, qty FROM cart WHERE productId = ? AND userId = ?", [productId, userId], (err, row) => {
    if (err) {
      console.error('POST /api/cart select error', err);
      return res.status(500).json({ error: 'Server error' });
    }
    if (row) {
      const newQty = row.qty + Number(qty);
      db.run("UPDATE cart SET qty = ? WHERE id = ?", [newQty, row.id], function(err) {
        if (err) { console.error(err); return res.status(500).json({ error: 'Server error updating cart' }); }
        res.json({ message: 'Cart updated' });
      });
    } else {
      db.run("INSERT INTO cart (productId, qty, userId) VALUES (?, ?, ?)", [productId, qty, userId], function(err) {
        if (err) { console.error(err); return res.status(500).json({ error: 'Server error adding to cart' }); }
        res.json({ message: 'Added to cart' });
      });
    }
  });
});

// PATCH /api/cart-update { cartId, qty, userId } - update quantity directly (ensures ownership)
app.patch('/api/cart-update', requireFields(['cartId','qty']), (req, res) => {
  const { cartId, qty } = req.body;
  const userId = parseUserIdFromReq(req);

  if (Number(qty) <= 0) {
    db.run("DELETE FROM cart WHERE id = ? AND userId = ?", [cartId, userId], function(err) {
      if (err) { console.error(err); return res.status(500).json({ error: 'Server error' }); }
      if (this.changes === 0) return res.status(404).json({ error: 'Cart item not found' });
      return res.json({ message: 'Removed' });
    });
    return;
  }

  db.run("UPDATE cart SET qty = ? WHERE id = ? AND userId = ?", [qty, cartId, userId], function(err) {
    if (err) { console.error(err); return res.status(500).json({ error: 'Server error' }); }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Cart item not found for this user' });
    }
    res.json({ message: 'Updated' });
  });
});

// DELETE /api/cart/:id - remove cart item (cart id) for specific user
app.delete('/api/cart/:id', (req, res) => {
  const id = req.params.id;
  const userId = parseUserIdFromReq(req);
  db.run("DELETE FROM cart WHERE id = ? AND userId = ?", [id, userId], function(err) {
    if (err) {
      console.error('DELETE /api/cart/:id error', err);
      return res.status(500).json({ error: 'Server error' });
    }
    if (this.changes === 0) return res.status(404).json({ error: 'Cart item not found' });
    res.json({ message: 'Removed' });
  });
});

// POST /api/checkout - accepts { cartItems?, name, email, userId? } OR uses server-side cart if cartItems not provided
app.post('/api/checkout', requireFields(['name','email']), (req, res) => {
  try {
    const { cartItems, name, email } = req.body;
    const userId = parseUserIdFromReq(req);

    // If frontend supplied cartItems array -> resolve product details and compute receipt
    if (Array.isArray(cartItems) && cartItems.length > 0) {
      const ids = cartItems.map(ci => ci.productId);
      const placeholders = ids.map(() => "?").join(",");
      db.all(`SELECT id, name, price FROM products WHERE id IN (${placeholders})`, ids, (err, rows) => {
        if (err) {
          console.error("checkout product fetch error", err);
          return res.status(500).json({ error: "Server error" });
        }
        const mapById = {};
        rows.forEach(r => mapById[r.id] = r);
        const items = cartItems.map(ci => {
          const p = mapById[ci.productId] || { id: ci.productId, name: "Unknown", price: 0 };
          return { productId: p.id, name: p.name, price: p.price, qty: ci.qty };
        });
        const total = items.reduce((acc, it) => acc + (it.price * it.qty), 0);
        const timestamp = new Date().toISOString();
        return res.json({ receipt: { name: name || null, email: email || null, items, total, timestamp }});
      });
      return;
    }

    // Else: use server cart for this user
    const sql = `
      SELECT p.id as productId, p.name, p.price, c.qty
      FROM cart c JOIN products p ON c.productId = p.id
      WHERE c.userId = ?
    `;
    db.all(sql, [userId], (err, rows) => {
      if (err) {
        console.error('POST /api/checkout select error', err);
        return res.status(500).json({ error: 'Server error' });
      }
      const total = rows.reduce((acc, r) => acc + r.price * r.qty, 0);
      const timestamp = new Date().toISOString();
      // Clear only this user's cart after checkout
      db.run("DELETE FROM cart WHERE userId = ?", [userId], function(delErr) {
        if (delErr) console.error('clear cart error', delErr);
        return res.json({ receipt: { name: name || null, email: email || null, items: rows, total, timestamp } });
      });
    });

  } catch (err) {
    console.error("checkout route error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Extra: route to fetch/expose external products (proxy)
app.get('/api/products/external', async (req, res) => {
  try {
    const r = await fetch('https://fakestoreapi.com/products');
    if (!r.ok) return res.status(502).json({ error: 'External API error' });
    const data = await r.json();
    // Map to simplified shape
    const simplified = data.map(p => ({ id: p.id, name: p.title || p.name, price: Number(p.price) || 0 }));
    res.json(simplified);
  } catch (err) {
    console.error('Error fetching external products:', err);
    res.status(500).json({ error: 'Failed to fetch external products' });
  }
});

// Health check route
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Generic error handler
app.use(errorHandler);

// Export app for tests (and also listen if run directly)
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Backend running on port ${port}`);
  });
} else {
  module.exports = app;
}

