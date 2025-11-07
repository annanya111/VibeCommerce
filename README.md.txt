# Vibe Commerce — Mock E-commerce Cart

## Backend
cd backend
npm install
node server.js
# server runs on http://localhost:5000

## Frontend
cd frontend
npm install
npm start
# frontend runs on http://localhost:3000

## APIs
- GET /api/products
- GET /api/cart
- POST /api/cart { productId, qty }
- PATCH /api/cart-update { cartId, qty }
- DELETE /api/cart/:id
- POST /api/checkout { name, email }

DB file: backend/db.sqlite (auto-created)
