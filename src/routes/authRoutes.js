import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../db/database.js';
import { config } from '../config/env.js';

export const authRouter = express.Router();

// Middleware to authenticate JWT Token
export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ success: false, error: 'Access token required' });
  }

  jwt.verify(token, config.jwtSecret, (err, decoded) => {
    if (err) {
      return res.status(403).json({ success: false, error: 'Invalid or expired token' });
    }
    const user = db.getUserById(decoded.userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User account not found' });
    }
    req.user = user;
    next();
  });
}

/**
 * POST /api/v1/auth/register
 * Register a new merchant user
 */
authRouter.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }

    const existingUser = db.getUserByEmail(email);
    if (existingUser) {
      return res.status(400).json({ success: false, error: 'Email is already registered. Please login.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const newUser = db.createUser({
      email,
      name: name || email.split('@')[0],
      passwordHash,
    });

    const token = jwt.sign({ userId: newUser.id, email: newUser.email }, config.jwtSecret, { expiresIn: '7d' });

    const safeUser = { ...newUser };
    delete safeUser.passwordHash;

    return res.status(201).json({
      success: true,
      message: 'Account created successfully',
      token,
      user: safeUser,
    });
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Server error' });
  }
});

/**
 * POST /api/v1/auth/login
 * Login existing merchant user
 */
authRouter.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const user = db.getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, config.jwtSecret, { expiresIn: '7d' });

    const safeUser = { ...user };
    delete safeUser.passwordHash;

    return res.json({
      success: true,
      message: 'Login successful',
      token,
      user: safeUser,
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Server error' });
  }
});

/**
 * GET /api/v1/auth/me
 * Get current logged in user details
 */
authRouter.get('/me', authenticateToken, (req, res) => {
  const safeUser = { ...req.user };
  delete safeUser.passwordHash;
  return res.json({
    success: true,
    user: safeUser,
  });
});
