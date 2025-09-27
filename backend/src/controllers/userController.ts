import { Request, Response } from 'express';
import { updateUserProfile } from '../services/userService';
import { logger } from '../utils/logger';

export const updateProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    // @ts-ignore
    const userId = req.user.id;
    const { nsfw_enabled } = req.body;

    // Basic validation
    if (typeof nsfw_enabled !== 'boolean') {
      res.status(400).json({ error: 'Invalid request body. "nsfw_enabled" must be a boolean.' });
      return;
    }

    const { data, error } = await updateUserProfile(userId, { nsfw_enabled });

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
