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

    if (!user.isApproved || user.status !== 'ACTIVE') {
      return res.status(403).json({ success: false, error: 'Account is pending admin approval or inactive' });
    }

    req.user = user;
    next();
  });
}

// Middleware for Super Admin only
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  next();
}

/**
 * POST /api/v1/auth/register
 * Register a new merchant user (Requires Admin Approval)
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
      return res.status(400).json({ success: false, error: 'Email is already registered. Please log in.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const newUser = await db.createUser({
      email,
      name: name || email.split('@')[0],
      passwordHash,
      role: 'MERCHANT',
      status: 'PENDING_APPROVAL',
      isApproved: false, // Requires Admin Approval
    });

    const safeUser = { ...newUser };
    delete safeUser.passwordHash;

    return res.status(201).json({
      success: true,
      pendingApproval: true,
      message: 'Registration successful! Your account is currently pending admin approval. You will be able to log in once activated by the admin.',
      user: safeUser,
    });
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Server error' });
  }
});

/**
 * POST /api/v1/auth/login
 * Login merchant or admin user
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

    // Check Admin Approval
    if (!user.isApproved || user.status === 'PENDING_APPROVAL') {
      return res.status(403).json({
        success: false,
        pendingApproval: true,
        error: '⏳ Your account is awaiting admin approval. Please contact the administrator to activate your account.',
      });
    }

    if (user.status === 'REJECTED') {
      return res.status(403).json({
        success: false,
        error: '❌ Your account registration has been rejected by the administrator.',
      });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      config.jwtSecret,
      { expiresIn: '7d' }
    );

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
