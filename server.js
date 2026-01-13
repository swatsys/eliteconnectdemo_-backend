const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 5001;

// --- CONFIGURATION ---
const PRICE_PER_CHAT = 5; 
const SUB_COST_WLD = 3;   
const SUB_DAYS = 30;      
const FREE_UNLOCKS = 2;   

app.use(cors({ origin: '*' }));
app.use(bodyParser.json());

// --- MONGODB CONNECTION ---
const mongoURI = process.env.MONGODB_URI || 'mongodb+srv://eliteadmin:vwNgyGly1PKqC72V@cluster0.5zj6yth.mongodb.net/elite-connect?appName=Cluster0';

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
  worldId: { type: String, unique: true, required: true },
  name: String,
  age: Number,
  gender: String,
  bio: String,
  balance: { type: Number, default: 25 },
  avatarColor: String,
  freeUnlocksUsed: { type: Number, default: 0 },
  subscription: {
    active: { type: Boolean, default: false },
    expiresAt: { type: Date }
  },
  likes: [String],
  joinedAt: { type: Date, default: Date.now }
});

const matchSchema = new mongoose.Schema({
  matchId: { type: String, unique: true },
  users: [String],
  unlocked: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  messages: [{
    id: String,
    senderId: String,
    text: String,
    timestamp: { type: Date, default: Date.now }
  }]
});

const User = mongoose.model('User', userSchema);
const Match = mongoose.model('Match', matchSchema);

// --- HELPER ---
function getRandomGradient() {
  const gradients = ['from-purple-500 to-pink-500', 'from-blue-500 to-teal-400', 'from-orange-400 to-red-400', 'from-indigo-400 to-purple-400'];
  return gradients[Math.floor(Math.random() * gradients.length)];
}

// --- MIDDLEWARE ---
const authenticate = async (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ success: false, error: "No token provided" });
  
  const parts = token.split('_');
  if (parts.length < 2) return res.status(401).json({ success: false, error: "Invalid token format" });

  const worldId = parts[1];
  try {
    const user = await User.findOne({ worldId });
    if (user) {
      req.user = user;
      next();
    } else {
      res.status(401).json({ success: false, error: "User not found" });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: "Database error" });
  }
};

// --- ROUTES ---

app.get('/', (req, res) => {
  res.send('Elite Connect Backend is Running! Access /api/health to check status.');
});

app.get('/api/health', (req, res) => {
  res.status(200).send('OK');
});

// 1. LOGIN (ROBUST UPSERT)
app.post('/api/auth/login', async (req, res) => {
  console.log("Login attempt Body:", req.body);
  const { proof } = req.body;
  let worldId;

  // 1. Extract worldId safely
  if (proof === 'mock') {
    worldId = 'mock_user_' + Math.floor(Math.random() * 100000); 
  } else if (typeof proof === 'object' && proof !== null) {
    // Handle different proof structures
    worldId = proof.nullifier_hash || proof.uuid;
  }

  console.log("Derived World ID:", worldId);

  // 2. Validate worldId
  if (!worldId) {
      return res.status(400).json({ success: false, error: "Invalid ID: Missing nullifier_hash. Please try again." });
  }

  try {
    // 3. Try to find existing user
    let user = await User.findOne({ worldId });

    if (user) {
      console.log("User found, logging in:", worldId);
      const token = `token_${worldId}`;
      return res.json({ success: true, token, isNew: !user.name });
    }

    // 4. If not found, create new user
    console.log("Creating new user for:", worldId);
    user = new User({
      worldId,
      balance: 25,
      avatarColor: getRandomGradient(),
      likes: []
    });

    await user.save();
    console.log("User saved successfully");
    
    const token = `token_${worldId}`;
    return res.json({ success: true, token, isNew: true });

  } catch (err) {
    console.error("Login Critical Error:", err);

    // 5. Graceful Recovery: Race condition (E11000)
    if (err.code === 11000) {
        console.log("⚠️ Race condition detected (E11000). Recovering...");
        try {
            const existingUser = await User.findOne({ worldId });
            if (existingUser) {
                const token = `token_${worldId}`;
                return res.json({ success: true, token, isNew: !existingUser.name });
            }
        } catch (recoveryErr) {
            console.error("Recovery failed:", recoveryErr);
        }
    }

    return res.status(500).json({ success: false, error: "DB Error: " + err.message });
  }
});

// 2. ONBOARD
app.post('/api/auth/onboard', authenticate, async (req, res) => {
  const { name, age, gender, bio } = req.body;
  req.user.name = name;
  req.user.age = age;
  req.user.gender = gender;
  req.user.bio = bio;
  await req.user.save();
  res.json({ success: true });
});

// 3. ME
app.get('/api/me', authenticate, async (req, res) => {
  if (req.user.subscription.active && req.user.subscription.expiresAt) {
    if (new Date() > req.user.subscription.expiresAt) {
      req.user.subscription.active = false;
      await req.user.save();
    }
  }
  res.json({ success: true, user: req.user });
});

// 4. EXPLORE
app.get('/api/explore', authenticate, async (req, res) => {
  try {
    const matches = await Match.find({ users: req.user.worldId });
    const matchedIds = matches.map(m => m.users.find(u => u !== req.user.worldId));
    const excludeIds = [req.user.worldId, ...req.user.likes, ...matchedIds];

    const randomUsers = await User.aggregate([
      { $match: { worldId: { $nin: excludeIds }, name: { $exists: true, $ne: null } } },
      { $sample: { size: 1 } }
    ]);

    if (randomUsers.length === 0) return res.json({ success: true, profile: null });
    
    const p = randomUsers[0];
    const safeProfile = { worldId: p.worldId, name: p.name, age: p.age, gender: p.gender, bio: p.bio, avatarColor: p.avatarColor };
    
    res.json({ success: true, profile: safeProfile });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// 5. LIKE
app.post('/api/explore/like', authenticate, async (req, res) => {
  const { targetId } = req.body;
  
  if (!req.user.likes.includes(targetId)) {
    req.user.likes.push(targetId);
    await req.user.save();
  }

  const targetUser = await User.findOne({ worldId: targetId });
  if (!targetUser) return res.status(404).json({ error: "User not found" });

  const isMatch = targetUser.likes.includes(req.user.worldId);
  if (isMatch) {
    const newMatch = new Match({
      matchId: Date.now().toString(),
      users: [req.user.worldId, targetId],
      unlocked: false,
      messages: []
    });
    await newMatch.save();
    return res.json({ success: true, match: true });
  }

  res.json({ success: true, match: false });
});

// 6. MATCHES
app.get('/api/matches', authenticate, async (req, res) => {
  const matches = await Match.find({ users: req.user.worldId });
  const formatted = await Promise.all(matches.map(async (m) => {
    const otherId = m.users.find(u => u !== req.user.worldId);
    const otherUser = await User.findOne({ worldId: otherId });
    return {
      matchId: m.matchId,
      name: otherUser ? otherUser.name : 'Unknown',
      avatarColor: otherUser ? otherUser.avatarColor : 'bg-gray-500',
      unlocked: m.unlocked
    };
  }));
  res.json({ success: true, matches: formatted });
});

// 7. UNLOCK
app.post('/api/matches/unlock', authenticate, async (req, res) => {
  const { matchId } = req.body;
  const match = await Match.findOne({ matchId });
  if (!match) return res.status(404).json({ success: false });

  const isSubscribed = req.user.subscription.active && new Date() < req.user.subscription.expiresAt;
  
  if (isSubscribed) {
    match.unlocked = true;
    await match.save();
    return res.json({ success: true, message: "Unlocked via Premium" });
  }

  if (req.user.freeUnlocksUsed < FREE_UNLOCKS) {
    req.user.freeUnlocksUsed += 1;
    await req.user.save();
    match.unlocked = true;
    await match.save();
    return res.json({ success: true, message: "Used Free Unlock" });
  }

  if (req.user.balance >= PRICE_PER_CHAT) {
    req.user.balance -= PRICE_PER_CHAT;
    await req.user.save();
    match.unlocked = true;
    await match.save();
    return res.json({ success: true, message: "Unlocked with 5 WLD" });
  }

  res.status(400).json({ success: false, error: "Insufficient WLD" });
});

// 8. UPGRADE
app.post('/api/subscription/upgrade', authenticate, async (req, res) => {
  if (req.user.balance >= SUB_COST_WLD) {
    req.user.balance -= SUB_COST_WLD;
    const now = new Date();
    const expiry = new Date(now.setDate(now.getDate() + SUB_DAYS));
    req.user.subscription = { active: true, expiresAt: expiry };
    await req.user.save();
    res.json({ success: true, user: req.user });
  } else {
    res.status(400).json({ success: false, error: "Insufficient WLD" });
  }
});

// 9. CHAT
app.get('/api/chat/:matchId', authenticate, async (req, res) => {
  const match = await Match.findOne({ matchId: req.params.matchId });
  if (!match) return res.status(404).json({ success: false });
  const mapped = match.messages.map(m => ({
    id: m.id || m._id,
    text: m.text,
    senderId: m.senderId,
    timestamp: m.timestamp,
    isMine: m.senderId === req.user.worldId
  }));
  res.json({ success: true, messages: mapped });
});

app.post('/api/chat/send', authenticate, async (req, res) => {
  const { matchId, text } = req.body;
  const match = await Match.findOne({ matchId });
  if (match) {
    match.messages.push({
      id: Date.now().toString(),
      senderId: req.user.worldId,
      text,
      timestamp: new Date()
    });
    await match.save();
  }
  res.json({ success: true });
});

// CONNECT AND START SERVER
mongoose.connect(mongoURI)
  .then(async () => {
    console.log('✅ Connected to MongoDB');
    
    // --- DATABASE SANITIZATION ---
    // 1. Drop bad indexes
    try {
      console.log('🧹 Cleanup: Dropping indexes...');
      await mongoose.connection.collection('users').dropIndexes();
      console.log('✅ Indexes dropped.');
    } catch (e) {
      console.log('ℹ️ Index info:', e.message);
    }
    
    // 2. Delete corrupted users (missing worldId)
    try {
        console.log('🧹 Cleanup: Removing corrupted users...');
        const result = await mongoose.connection.collection('users').deleteMany({
            $or: [{ worldId: null }, { worldId: { $exists: false } }]
        });
        console.log(`✅ Deleted ${result.deletedCount} corrupted user records.`);
    } catch (e) {
        console.log('⚠️ Cleanup Error:', e.message);
    }

    app.listen(PORT, '0.0.0.0', () => console.log(`Backend running on port ${PORT}`));
  })
  .catch(err => {
    console.error('❌ MongoDB Connection Error:', err);
  });
