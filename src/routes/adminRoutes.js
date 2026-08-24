import express from 'express';
import { authenticateToken, requireAdmin } from './authRoutes.js';
import { db } from '../db/database.js';

export const adminRouter = express.Router();

// Apply auth + admin guard to all admin routes
adminRouter.use(authenticateToken, requireAdmin);

/**
 * GET /api/v1/admin/overview
 * Global platform overview
 */
adminRouter.get('/overview', (req, res) => {
  const users = db.listUsers();
  const orders = db.listOrders(1000).orders;

  const pendingCount = users.filter(u => u.status === 'PENDING_APPROVAL' || !u.isApproved).length;
  const activeCount = users.filter(u => u.status === 'ACTIVE' && u.isApproved).length;
  const totalVolume = orders
    .filter(o => o.status === 'PAID')
    .reduce((sum, o) => sum + parseFloat(o.orderAmount || 0), 0);

  res.json({
    success: true,
    stats: {
      totalUsers: users.length,
      pendingApprovals: pendingCount,
      activeMerchants: activeCount,
      totalOrders: orders.length,
      totalPlatformVolumeUSDT: totalVolume.toFixed(2),
    },
  });
});

/**
 * GET /api/v1/admin/users
 * List all users with approval statuses
 */
adminRouter.get('/users', (req, res) => {
  const users = db.listUsers().map(u => {
    const safe = { ...u };
    delete safe.passwordHash;
    return safe;
  });
  res.json({ success: true, users });
});

/**
 * POST /api/v1/admin/approve/:userId
 * Approve a pending user account
 */
adminRouter.post('/approve/:userId', (req, res) => {
  const { userId } = req.params;
  const user = db.getUserById(userId);

  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  const updatedUser = db.approveUser(userId);
  const safe = { ...updatedUser };
  delete safe.passwordHash;

  console.log(`✅ Admin approved user account: ${user.email} (${user.id})`);

  return res.json({
    success: true,
    message: `User ${user.email} has been approved and activated successfully.`,
    user: safe,
  });
});

/**
 * POST /api/v1/admin/reject/:userId
 * Reject a user account
 */
adminRouter.post('/reject/:userId', (req, res) => {
  const { userId } = req.params;
  const user = db.getUserById(userId);

  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  const updatedUser = db.rejectUser(userId);
  const safe = { ...updatedUser };
  delete safe.passwordHash;

  console.log(`❌ Admin rejected user account: ${user.email} (${user.id})`);

  return res.json({
    success: true,
    message: `User ${user.email} has been rejected.`,
    user: safe,
  });
});

/**
 * DELETE /api/v1/admin/user/:userId
 * Delete a user account
 */
adminRouter.delete('/user/:userId', (req, res) => {
  const { userId } = req.params;
  if (userId === req.user.id) {
    return res.status(400).json({ success: false, error: 'Cannot delete own admin account' });
  }

  const success = db.deleteUser(userId);
  if (!success) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  return res.json({
    success: true,
    message: 'User deleted successfully',
  });
});
