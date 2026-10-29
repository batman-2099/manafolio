const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const codex = require('../codexDeckClient');
const catalog = require('../catalog');
const languages = require('../utils/languages');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { BACKUP_DIR, listBackups, createBackup } = require('../backup');

const router = express.Router();

router.use(authenticateToken, requireAdmin);

// Get all users with their statistics
router.get('/users', async (req, res) => {
  try {
    const users = await db.all(`
      SELECT id, username, role, share_enabled, created_at
      FROM users
      ORDER BY username ASC
    `);

    // Fetch stats for each user
    const usersWithStats = [];
    for (const u of users) {
      const stats = await db.get(`
        SELECT COUNT(c.id) as unique_cards, SUM(c.quantity) as total_cards,
          SUM(c.quantity * CASE
            WHEN c.printing = 'Holofoil' AND cc.price_holofoil IS NOT NULL AND cc.price_holofoil > 0 THEN cc.price_holofoil
            WHEN c.printing = 'Normal' AND cc.price_normal IS NOT NULL AND cc.price_normal > 0 THEN cc.price_normal
            ELSE cc.price_trend
          END) as total_value
        FROM collection c
        JOIN card_cache cc ON c.card_id = cc.id
        WHERE c.user_id = ? AND COALESCE(c.list_type, 'collection') != 'graveyard'
      `, [u.id]);

      usersWithStats.push({
        ...u,
        total_cards: stats.total_cards || 0,
        unique_cards: stats.unique_cards || 0,
        total_value: parseFloat((stats.total_value || 0).toFixed(2))
      });
    }

    res.json(usersWithStats);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve users list' });
  }
});

// Create a new user from Admin Panel
router.post('/users', async (req, res) => {
  const { username, password, role = 'member' } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const cleanUsername = username.trim().toLowerCase();
  if (cleanUsername.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (role !== 'member' && role !== 'admin') {
    return res.status(400).json({ error: 'Invalid role specification' });
  }

  try {
    const existingUser = await db.get(`SELECT id FROM users WHERE username = ?`, [cleanUsername]);
    if (existingUser) {
      return res.status(400).json({ error: 'Username is already taken' });
    }

    const passwordHash = db.hashPassword(password);
    const shareToken = crypto.randomBytes(16).toString('hex');

    await db.run(`
      INSERT INTO users (username, password_hash, role, share_token, share_enabled)
      VALUES (?, ?, ?, ?, ?)
    `, [cleanUsername, passwordHash, role, shareToken, 0]);

    res.status(201).json({ message: `User "${cleanUsername}" created successfully.` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Update a user (Change password or Role) from Admin Panel
router.put('/users/:id', async (req, res) => {
  const { id } = req.params;
  const { password, role } = req.body;

  try {
    const targetUser = await db.get(`SELECT id, username, role FROM users WHERE id = ?`, [id]);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (password !== undefined && (typeof password !== 'string' || password.length < 8)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    if (role !== undefined) {
      if (role !== 'member' && role !== 'admin') {
        return res.status(400).json({ error: 'Invalid role' });
      }
      // Block admin demoting themselves
      if (parseInt(id, 10) === req.user.id && role !== 'admin') {
        return res.status(400).json({ error: 'You cannot demote yourself from Administrator role.' });
      }
    }

    const updates = {};
    if (password !== undefined) updates.password_hash = db.hashPassword(password);
    if (role !== undefined) updates.role = role;
    const fields = Object.keys(updates);
    if (fields.length) {
      const updateUser = () => db.run(`UPDATE users SET ${fields.map(key => `${key} = ?`).join(', ')} WHERE id = ?`, [...Object.values(updates), id]);
      if (password !== undefined) {
        await db.withTransaction(async () => {
          await updateUser();
          await db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
        });
      } else {
        await updateUser();
      }
    }

    res.json({ message: 'User updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Delete user from Admin Panel
router.delete('/users/:id', async (req, res) => {
  const { id } = req.params;

  if (parseInt(id, 10) === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own Administrator account.' });
  }

  try {
    const targetUser = await db.get(`SELECT id, username FROM users WHERE id = ?`, [id]);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    await codex.disposeUser(targetUser.id);
    await db.withTransaction(async () => {
      await db.run(`DELETE FROM sessions WHERE user_id = ?`, [id]);
      await db.run(`DELETE FROM collection WHERE user_id = ?`, [id]);
      await db.run(`DELETE FROM locations WHERE user_id = ?`, [id]);
      await db.run(`DELETE FROM users WHERE id = ?`, [id]);
    });

    res.json({ message: `User "${targetUser.username}" and all their card collections/locations have been permanently deleted.` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});



// --- Set-index build management ---

const isGame = (g) => g === 'mtg';

// List persisted builds plus any in-flight/recent build progress.
// --- Catalogs -------------------------------------------------------------
//
// A catalog is one (game, language). Building it caches every set's cards and
// then embeds their artwork; scanning searches the result. This replaced the
// per-set and whole-game ORB index endpoints, which asked the user to reason
// about scan indexes, recall depth and set scoping to get a working scanner.
// There is one thing to build now, and the list below says how complete it is.
router.get('/catalogs', async (req, res) => {
  try {
    res.json({
      catalogs: await catalog.list(),
      progress: catalog.state(),
      last: catalog.lastResult(),
    });
  } catch (e) {
    console.error('catalog list failed:', e.message);
    res.status(500).json({ error: 'Could not list catalogs' });
  }
});


router.post('/catalogs/build', (req, res) => {
  // `sets` scopes the build to the sets the user actually has in front of them,
  // which is minutes instead of hours. Omit it for the whole game. A scoped build
  // MERGES into the existing catalog (catalog.js embedPhase), so building one set
  // never discards the sets built before it.
  const { game = 'mtg', lang, skipCache, sets } = req.body || {};
  if (!isGame(game)) return res.status(400).json({ error: 'Unsupported game' });
  try {
    res.json({ progress: catalog.start(game, lang, { skipCache: !!skipCache, sets: Array.isArray(sets) ? sets : [] }) });
  } catch (e) {
    // "already running" is a conflict, not a server fault — the UI shows the
    // running build rather than an error.
    res.status(409).json({ error: e.message, progress: catalog.state() });
  }
});

// The scan engine's downloadable pieces: what is installed, what it would cost,
// and the licence the models carry. See utils/modelAssets for why the models are
// a deliberate download rather than part of the image.
router.get('/models', async (req, res) => {
  res.json(require('../utils/modelAssets').status());
});

// `what`: 'models' or a supported 'catalog:<game>'. Downloading is the
// operator's own act on their own install — which is precisely why it is a button
// they press rather than something that happens on startup.
router.post('/models/download', (req, res) => {
  const modelAssets = require('../utils/modelAssets');
  try {
    res.json({ progress: modelAssets.start(String((req.body || {}).what || 'models')) });
  } catch (e) {
    res.status(409).json({ error: e.message, progress: modelAssets.state() });
  }
});

router.post('/catalogs/stop', (req, res) => {
  res.json({ stopped: catalog.stop(), progress: catalog.state() });
});

// Progress is polled while a build runs, so it stays cheap: in-memory counters,
// no database and no filesystem.
router.get('/catalogs/progress', (req, res) => {
  res.json({ progress: catalog.state(), last: catalog.lastResult() });
});

router.get('/backups', (req, res) => {
  res.json({ dir: BACKUP_DIR, backups: listBackups() });
});

router.post('/backups', async (req, res) => {
  try {
    const meta = await createBackup();
    res.status(201).json(meta);
  } catch (error) {
    console.error('BACKUP ERROR:', error);
    res.status(500).json({ error: 'Backup failed', message: error.message });
  }
});

router.get('/backups/:file/download', (req, res) => {
  const name = path.basename(req.params.file); // strip any path traversal
  const full = path.join(BACKUP_DIR, name);
  if (!name.endsWith('.bak') || !fs.existsSync(full)) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  res.download(full);
});

module.exports = router;
