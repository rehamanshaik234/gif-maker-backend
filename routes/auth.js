import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_gif_maker_jwt_key_2025';

// Middleware to authenticate JWT
export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// Optional Auth (for endpoints that can work with or without login)
export function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    req.user = null;
    return next();
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (!err) {
      req.user = user;
    }
    next();
  });
}

// 1. Register User (Grants 1 Free Credit)
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, error: 'Name, email, and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }

    // Check if user exists
    const [existingUsers] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUsers.length > 0) {
      return res.status(400).json({ success: false, error: 'Email is already registered' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Default 1 free credit on registration
    const initialCredits = 1;
    const [result] = await pool.query(
      'INSERT INTO users (name, email, password, credits) VALUES (?, ?, ?, ?)',
      [name, email, hashedPassword, initialCredits]
    );

    const userId = result.insertId;
    const token = jwt.sign({ id: userId, email }, JWT_SECRET, { expiresIn: '30d' });

    return res.status(201).json({
      success: true,
      message: 'Account created successfully with 1 free credit!',
      token,
      user: {
        id: userId,
        name,
        email,
        credits: initialCredits
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Registration failed' });
  }
});

// 2. Login User
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const user = users[0];
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        credits: user.credits
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Login failed' });
  }
});

// 3. Google / Firebase Auth Login & Registration
router.post('/google', async (req, res) => {
  try {
    const { email, name, firebase_uid } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required for Google login' });
    }

    const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);

    let user;
    let isNewUser = false;

    if (users.length > 0) {
      user = users[0];
    } else {
      // First time Google Sign In -> Grant 1 free credit!
      isNewUser = true;
      const initialCredits = 1;
      const randomPassword = await bcrypt.hash(firebase_uid || `${email}_${Date.now()}`, 10);
      const userName = name || email.split('@')[0];

      const [result] = await pool.query(
        'INSERT INTO users (name, email, password, credits) VALUES (?, ?, ?, ?)',
        [userName, email, randomPassword, initialCredits]
      );

      user = {
        id: result.insertId,
        name: userName,
        email: email,
        credits: initialCredits
      };
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });

    return res.json({
      success: true,
      message: isNewUser ? 'Welcome! You received 1 free credit.' : 'Logged in successfully',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        credits: user.credits
      }
    });
  } catch (error) {
    console.error('Google login error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Google login failed' });
  }
});

// 4. Get User Profile & Credit Balance
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const [users] = await pool.query('SELECT id, name, email, credits, created_at FROM users WHERE id = ?', [req.user.id]);
    if (users.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    return res.json({
      success: true,
      user: users[0]
    });
  } catch (error) {
    console.error('Profile error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to fetch profile' });
  }
});

// 5. Deduct 1 Credit (When user downloads / saves with account)
router.post('/deduct-credit', authenticateToken, async (req, res) => {
  try {
    const [users] = await pool.query('SELECT credits FROM users WHERE id = ?', [req.user.id]);
    if (users.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const currentCredits = users[0].credits;
    if (currentCredits <= 0) {
      return res.status(400).json({
        success: false,
        error: 'No credits remaining. Watch an ad or buy credits.'
      });
    }

    await pool.query('UPDATE users SET credits = credits - 1 WHERE id = ?', [req.user.id]);

    return res.json({
      success: true,
      message: '1 credit deducted successfully',
      remainingCredits: currentCredits - 1
    });
  } catch (error) {
    console.error('Deduct credit error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to deduct credit' });
  }
});

// 6. Add Credits (For in-app purchase or rewards)
router.post('/add-credits', authenticateToken, async (req, res) => {
  try {
    const { amount } = req.body;
    const addCount = parseInt(amount, 10) || 1;

    await pool.query('UPDATE users SET credits = credits + ? WHERE id = ?', [addCount, req.user.id]);
    const [users] = await pool.query('SELECT credits FROM users WHERE id = ?', [req.user.id]);

    return res.json({
      success: true,
      message: `${addCount} credits added successfully`,
      credits: users[0].credits
    });
  } catch (error) {
    console.error('Add credits error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to add credits' });
  }
});

export default router;
