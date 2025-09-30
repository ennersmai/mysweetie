import { Request, Response } from 'express';
import { updateUserProfile } from '../services/userService';
import { logger } from '../utils/logger';

export const updateProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    // @ts-ignore
    const userId = req.user.id;
    const { nsfw_enabled, display_name } = req.body;

    // Build update object with only provided fields
    const updates: any = {};
    
    if (typeof nsfw_enabled === 'boolean') {
      updates.nsfw_enabled = nsfw_enabled;
    }
    
    if (typeof display_name === 'string') {
      // Validate and sanitize display_name
      const trimmed = display_name.trim();
      if (trimmed.length > 0 && trimmed.length <= 64) {
        updates.display_name = trimmed;
      } else if (trimmed.length > 64) {
        res.status(400).json({ error: 'Display name must be 64 characters or less.' });
        return;
      }
    }

    // Ensure at least one field is being updated
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'No valid fields to update.' });
      return;
    }

    const { data, error } = await updateUserProfile(userId, updates);

    if (error) {
      res.status(500).json({ error: 'Failed to update user profile.' });
      return;
    }

    res.status(200).json({ message: 'Profile updated successfully.', data });

  } catch (error: any) {
    logger.error({
      message: 'Error updating user profile',
      error: error.message,
      stack: error.stack,
      path: 'userController.ts',
    });
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
