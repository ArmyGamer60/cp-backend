require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ── Base de datos ──────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ── Inicializar tablas ─────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cards (
      id SERIAL PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS brands (
      id SERIAL PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // PIN por defecto si no existe
  const pin = await pool.query("SELECT value FROM settings WHERE key = 'pin'");
  if (pin.rows.length === 0) {
    await pool.query("INSERT INTO settings (key, value) VALUES ('pin', $1)", [
      process.env.DEFAULT_PIN || '1234'
    ]);
    console.log('PIN por defecto creado: 1234');
  }

  console.log('Base de datos lista');
}

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// ── WebSocket clients ──────────────────────────────────────────────────────
const clients = new Set();

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  clients.forEach(client => {
    if (client !== excludeWs && client.readyState === 1) {
      client.send(msg);
    }
  });
}

// ── WebSocket ──────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`Cliente conectado. Total: ${clients.size}`);

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);

      // Actualización de cards
      if (msg.type === 'UPDATE_CARDS') {
        await pool.query(`
          INSERT INTO cards (id, data, updated_at) VALUES (1, $1, NOW())
          ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()
        `, [JSON.stringify(msg.payload)]);
        broadcast({ type: 'CARDS_UPDATED', payload: msg.payload }, ws);
      }

      // Actualización de brands
      if (msg.type === 'UPDATE_BRANDS') {
        await pool.query(`
          INSERT INTO brands (id, data, updated_at) VALUES (1, $1, NOW())
          ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()
        `, [JSON.stringify(msg.payload)]);
        broadcast({ type: 'BRANDS_UPDATED', payload: msg.payload }, ws);
      }

      // Actualización de users
      if (msg.type === 'UPDATE_USERS') {
        await pool.query(`
          INSERT INTO users (id, data, updated_at) VALUES (1, $1, NOW())
          ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()
        `, [JSON.stringify(msg.payload)]);
        broadcast({ type: 'USERS_UPDATED', payload: msg.payload }, ws);
      }

    } catch (err) {
      console.error('WS error:', err.message);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`Cliente desconectado. Total: ${clients.size}`);
  });
});

// ── REST API ───────────────────────────────────────────────────────────────

// Verificar PIN
app.post('/api/auth', async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN requerido' });

  const result = await pool.query("SELECT value FROM settings WHERE key = 'pin'");
  const correct = result.rows[0]?.value;

  if (pin === correct) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'PIN incorrecto' });
  }
});

// Cargar todos los datos al conectarse
app.get('/api/data', async (req, res) => {
  try {
    const [cards, brands, users] = await Promise.all([
      pool.query('SELECT data FROM cards WHERE id = 1'),
      pool.query('SELECT data FROM brands WHERE id = 1'),
      pool.query('SELECT data FROM users WHERE id = 1'),
    ]);

    res.json({
      cards: cards.rows[0]?.data || [],
      brands: brands.rows[0]?.data || [],
      users: users.rows[0]?.data || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cambiar PIN (opcional)
app.post('/api/change-pin', async (req, res) => {
  const { currentPin, newPin } = req.body;
  const result = await pool.query("SELECT value FROM settings WHERE key = 'pin'");
  const correct = result.rows[0]?.value;

  if (currentPin !== correct) return res.status(401).json({ error: 'PIN incorrecto' });
  if (!newPin || newPin.length < 4) return res.status(400).json({ error: 'PIN debe tener mínimo 4 caracteres' });

  await pool.query("UPDATE settings SET value = $1 WHERE key = 'pin'", [newPin]);
  res.json({ ok: true });
});

// Health check para Railway
app.get('/health', (_, res) => res.json({ status: 'ok', clients: clients.size }));

// ── Arrancar ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
  });
}).catch(err => {
  console.error('Error iniciando DB:', err);
  process.exit(1);
});
