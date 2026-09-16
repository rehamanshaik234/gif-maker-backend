import express from 'express';
import { pool } from '../db.js';
import { authenticateToken, optionalAuth } from './auth.js';

const router = express.Router();

// Get all saved GIFs for authenticated user or by user_id
router.get('/user', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id || req.query.user_id || req.query.userId;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID or token required' });
    }

    const [rows] = await pool.query(
      'SELECT * FROM generated_gifs WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );

    return res.json({
      success: true,
      gifs: rows
    });
  } catch (error) {
    console.error('Fetch GIFs error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to fetch GIFs' });
  }
});

// Get GIFs by explicit user_id param
router.get('/user/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const [rows] = await pool.query(
      'SELECT * FROM generated_gifs WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );

    return res.json({
      success: true,
      gifs: rows
    });
  } catch (error) {
    console.error('Fetch GIFs error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to fetch GIFs' });
  }
});

// Save / Record generated GIF in database
router.post('/save', authenticateToken, async (req, res) => {
  try {
    const { prompt, style, environment, action, gif_url, gif_no_watermark_url, video_url, video_no_watermark_url, sticker_url, sticker_no_watermark_url } = req.body;

    if (!gif_url) {
      return res.status(400).json({ success: false, error: 'gif_url is required' });
    }

    const [result] = await pool.query(
      `INSERT INTO generated_gifs 
        (user_id, prompt, style, environment, action, gif_url, gif_no_watermark_url, video_url, video_no_watermark_url, sticker_url, sticker_no_watermark_url) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        prompt || '',
        style || '',
        environment || '',
        action || '',
        gif_url,
        gif_no_watermark_url || null,
        video_url || '',
        video_no_watermark_url || null,
        sticker_url || '',
        sticker_no_watermark_url || null
      ]
    );

    return res.json({
      success: true,
      message: 'GIF saved to user cloud account',
      id: result.insertId
    });
  } catch (error) {
    console.error('Save GIF error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to save GIF' });
  }
});

export default router;
