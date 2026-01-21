
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- DATABASE CONNECTION (PostgreSQL) ---
// Vercel automatically provides POSTGRES_URL when you add a storage database
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Required for Vercel/Neon Postgres
});

// --- INIT SQL TABLES (Auto-Migration) ---
const initDB = async () => {
  const client = await pool.connect();
  try {
    // Users Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        world_id TEXT PRIMARY KEY,
        name TEXT,
        age INT,
        gender TEXT,
        bio TEXT,
        balance INT DEFAULT 25,
        avatar_color TEXT,
        free_unlocks_used INT DEFAULT 0,
        sub_active BOOLEAN DEFAULT FALSE,
        sub_expires TIMESTAMP,
        likes TEXT[] DEFAULT '{}'
      );
    `);

    // Matches Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS matches (
        match_id TEXT PRIMARY KEY,
        user_a TEXT,
        user_b TEXT,
        unlocked BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Messages Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        match_id TEXT,
        sender_id TEXT,
        text TEXT,
        timestamp TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("✅ Database tables verified");
  } catch (err) {
    console.error("❌ DB Init Error:", err);
  } finally {
    client.release();
  }
};

// Initialize DB on first load
initDB();

// --- HELPERS ---
function getRandomGradient() {
  const gradients = ['from-purple-500 to-pink-500', 'from-blue-500 to-teal-400', 'from-orange-400 to-red-400', 'from-indigo-400 to-purple-400'];
  return gradients[Math.floor(Math.random() * gradients.length)];
}

// --- MIDDLEWARE ---
const authenticate = async (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ success: false, error: "No token" });
  
  const worldId = token.replace('token_', '');
  
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE world_id = $1', [worldId]);
    if (rows.length > 0) {
      req.user = rows[0];
      next();
    } else {
      res.status(401).json({ success: false, error: "User not found" });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: "Auth DB Error" });
  }
};

// --- ROUTES ---

app.get('/api/health', (req, res) => res.send('Postgres Backend Running'));

// 1. LOGIN
app.post('/api/auth/login', async (req, res) => {
  const { proof } = req.body;
  let worldId;

  // Handle mock vs real proof
  if (proof === 'mock') {
    worldId = 'mock_' + Math.floor(Math.random() * 100000);
  } else if (typeof proof === 'object') {
    worldId = proof.nullifier_hash || proof.sub;
  }

  if (!worldId) return res.status(400).json({ success: false, error: "Missing World ID" });

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE world_id = $1', [worldId]);
    
    if (rows.length > 0) {
      return res.json({ success: true, token: `token_${worldId}`, isNew: !rows[0].name });
    } else {
      // Create new user
      const color = getRandomGradient();
      await pool.query(
        'INSERT INTO users (world_id, balance, avatar_color) VALUES ($1, $2, $3)',
        [worldId, 25, color]
      );
      return res.json({ success: true, token: `token_${worldId}`, isNew: true });
    }
  } catch (err) {
    console.error(err);
    // Handle race condition (unique constraint)
    if (err.code === '23505') {
       return res.json({ success: true, token: `token_${worldId}`, isNew: false });
    }
    res.status(500).json({ success: false, error: "Login failed" });
  }
});

// 2. ONBOARD
app.post('/api/auth/onboard', authenticate, async (req, res) => {
  const { name, age, gender, bio } = req.body;
  try {
    await pool.query(
      'UPDATE users SET name=$1, age=$2, gender=$3, bio=$4 WHERE world_id=$5',
      [name, age, gender, bio, req.user.world_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// 3. ME
app.get('/api/me', authenticate, async (req, res) => {
  // Check subscription expiry
  if (req.user.sub_active && req.user.sub_expires && new Date() > new Date(req.user.sub_expires)) {
     await pool.query('UPDATE users SET sub_active = FALSE WHERE world_id = $1', [req.user.world_id]);
     req.user.sub_active = false;
  }

  res.json({ 
    success: true, 
    user: {
      worldId: req.user.world_id,
      name: req.user.name,
      balance: req.user.balance,
      avatarColor: req.user.avatar_color,
      subscription: { active: req.user.sub_active, expiresAt: req.user.sub_expires }
    } 
  });
});

// 4. EXPLORE
app.get('/api/explore', authenticate, async (req, res) => {
  try {
    // Get users who are NOT me, NOT already matched (implied by likes logic usually), and NOT in my likes list
    const { rows } = await pool.query(`
      SELECT * FROM users 
      WHERE world_id != $1 
      AND name IS NOT NULL 
      AND NOT (world_id = ANY($2::text[]))
      ORDER BY RANDOM() 
      LIMIT 1
    `, [req.user.world_id, req.user.likes || []]);

    if (rows.length === 0) return res.json({ success: true, profile: null });
    
    const p = rows[0];
    res.json({ success: true, profile: { worldId: p.world_id, name: p.name, age: p.age, gender: p.gender, bio: p.bio, avatarColor: p.avatar_color } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// 5. LIKE
app.post('/api/explore/like', authenticate, async (req, res) => {
  const { targetId } = req.body;
  const myId = req.user.world_id;

  try {
    // Add to my likes
    await pool.query('UPDATE users SET likes = array_append(likes, $1) WHERE world_id = $2', [targetId, myId]);
    
    // Check if they liked me
    const { rows } = await pool.query('SELECT likes FROM users WHERE world_id = $1', [targetId]);
    const targetLikes = rows[0]?.likes || [];
    
    if (targetLikes.includes(myId)) {
      const matchId = Date.now().toString();
      await pool.query('INSERT INTO matches (match_id, user_a, user_b) VALUES ($1, $2, $3)', [matchId, myId, targetId]);
      return res.json({ success: true, match: true });
    }

    res.json({ success: true, match: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// 6. MATCHES
app.get('/api/matches', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM matches WHERE user_a = $1 OR user_b = $1', [req.user.world_id]);
    
    const formatted = await Promise.all(rows.map(async (m) => {
      const otherId = m.user_a === req.user.world_id ? m.user_b : m.user_a;
      const uRes = await pool.query('SELECT name, avatar_color FROM users WHERE world_id = $1', [otherId]);
      const otherUser = uRes.rows[0];
      return {
        matchId: m.match_id,
        name: otherUser ? otherUser.name : 'Unknown',
        avatarColor: otherUser ? otherUser.avatar_color : 'bg-gray-500',
        unlocked: m.unlocked
      };
    }));
    
    res.json({ success: true, matches: formatted });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// 7. UNLOCK
app.post('/api/matches/unlock', authenticate, async (req, res) => {
  const { matchId } = req.body;
  const COST = 5;
  const FREE_UNLOCKS = 2;

  try {
    // Check subscription
    if (req.user.sub_active) {
        await pool.query('UPDATE matches SET unlocked = TRUE WHERE match_id = $1', [matchId]);
        return res.json({ success: true, message: "Unlocked via Premium" });
    }

    // Check free unlocks
    if (req.user.free_unlocks_used < FREE_UNLOCKS) {
        await pool.query('UPDATE users SET free_unlocks_used = free_unlocks_used + 1 WHERE world_id = $1', [req.user.world_id]);
        await pool.query('UPDATE matches SET unlocked = TRUE WHERE match_id = $1', [matchId]);
        return res.json({ success: true, message: "Used Free Unlock" });
    }

    // Pay with WLD
    if (req.user.balance >= COST) {
      await pool.query('UPDATE users SET balance = balance - $1 WHERE world_id = $2', [COST, req.user.world_id]);
      await pool.query('UPDATE matches SET unlocked = TRUE WHERE match_id = $1', [matchId]);
      res.json({ success: true, message: "Unlocked with WLD" });
    } else {
      res.status(400).json({ success: false, error: "Insufficient funds" });
    }
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// 8. UPGRADE
app.post('/api/subscription/upgrade', authenticate, async (req, res) => {
  const COST = 3;
  const DAYS = 30;

  try {
    if (req.user.balance >= COST) {
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + DAYS);
        
        await pool.query(
            'UPDATE users SET balance = balance - $1, sub_active = TRUE, sub_expires = $2 WHERE world_id = $3', 
            [COST, expiry, req.user.world_id]
        );
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false, error: "Insufficient funds" });
    }
  } catch (err) {
      res.status(500).json({ success: false });
  }
});

// 9. CHAT MESSAGES
app.get('/api/chat/:matchId', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM messages WHERE match_id = $1 ORDER BY timestamp ASC', [req.params.matchId]);
    const mapped = rows.map(m => ({
      id: m.id,
      text: m.text,
      isMine: m.sender_id === req.user.world_id,
      timestamp: m.timestamp
    }));
    res.json({ success: true, messages: mapped });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.post('/api/chat/send', authenticate, async (req, res) => {
  const { matchId, text } = req.body;
  try {
    await pool.query('INSERT INTO messages (match_id, sender_id, text) VALUES ($1, $2, $3)', [matchId, req.user.world_id, text]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// LOCAL DEV SERVER
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Backend running locally on port ${PORT}`));
}

module.exports = app;
