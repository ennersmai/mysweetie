/**
 * Resemble Project Service
 * 
 * Manages Resemble.ai project UUID retrieval from database with caching.
 */

import { supabaseAdmin } from '../config/database';
import { logger } from '../utils/logger';

class ResembleProjectService {
  private cachedProjectUuid: string | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL = 60 * 60 * 1000; // 1 hour cache

  /**
   * Get Resemble project UUID from database
   * Caches the result in memory for performance
   */
  async getProjectUuid(): Promise<string> {
    // Return cached value if still valid
    const now = Date.now();
    if (this.cachedProjectUuid && (now - this.cacheTimestamp) < this.CACHE_TTL) {
      return this.cachedProjectUuid;
    }

    try {
      const { data, error } = await supabaseAdmin
        .from('resemble_projects')
        .select('project_uuid')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        logger.error('Error fetching Resemble project UUID:', error);
        throw new Error(`Failed to fetch Resemble project UUID: ${error.message}`);
      }

      if (!data || !data.project_uuid) {
        throw new Error(
          'Resemble project UUID not found in database. ' +
          'Please create a project in Resemble dashboard and insert the UUID into the resemble_projects table.'
        );
      }

      // Cache the result
      this.cachedProjectUuid = data.project_uuid;
      this.cacheTimestamp = now;

      logger.info('Resemble project UUID loaded from database');
      return this.cachedProjectUuid;
    } catch (error: any) {
      logger.error('Error in getProjectUuid:', error);
      throw error;
    }
  }

  /**
   * Clear the cached project UUID
   * Useful for testing or when project UUID changes
   */
  clearCache(): void {
    this.cachedProjectUuid = null;
    this.cacheTimestamp = 0;
    logger.info('Resemble project UUID cache cleared');
  }
}

// Singleton instance
export const resembleProjectService = new ResembleProjectService();

