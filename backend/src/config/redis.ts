import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redisPassword = process.env.REDIS_PASSWORD;

export class RedisManager {
  private static instance: RedisManager;
  private client: RedisClientType | null = null;
  private connected: boolean = false;
  private initialized: boolean = false;

  private constructor() {
    // Don't create client until explicitly initialized
  }

  private initializeClient() {
    if (this.initialized) return;
    
    const clientOptions: any = {
      url: redisUrl,
      socket: {
        reconnectStrategy: (retries: number) => {
          if (retries > 5) {
            logger.warn('Redis reconnection stopped after 5 attempts');
            return false; // Stop retrying
          }
          return Math.min(retries * 1000, 5000);
        }
      }
    };
    
    if (redisPassword) {
      clientOptions.password = redisPassword;
    }
    
    this.client = createClient(clientOptions);
    this.initialized = true;

    this.client.on('error', (err) => {
      // Only log first error, then suppress
      if (this.connected) {
        logger.warn('Redis connection lost');
        this.connected = false;
      }
    });

    this.client.on('connect', () => {
      logger.info('Redis connected successfully');
      this.connected = true;
    });

    this.client.on('disconnect', () => {
      if (this.connected) {
        logger.info('Redis disconnected');
        this.connected = false;
      }
    });
  }

  public static getInstance(): RedisManager {
    if (!RedisManager.instance) {
      RedisManager.instance = new RedisManager();
    }
    return RedisManager.instance;
  }

  public async connect(): Promise<void> {
    this.initializeClient();
    if (!this.client) {
      throw new Error('Redis client not initialized');
    }
    
    try {
      await this.client.connect();
      this.connected = true;
      logger.info('Redis connection established');
    } catch (error) {
      logger.warn('Redis connection failed - continuing without cache');
      this.connected = false;
      // Don't throw error, just continue without Redis
    }
  }

  public async disconnect(): Promise<void> {
    if (!this.client || !this.connected) return;
    
    try {
      await this.client.disconnect();
      this.connected = false;
      logger.info('Redis disconnected');
    } catch (error) {
      logger.warn('Error disconnecting from Redis:', error);
    }
  }

  public getClient(): RedisClientType | null {
    if (!this.connected || !this.client) {
      return null; // Return null instead of throwing
    }
    return this.client;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  // Memory caching methods
  public async cacheMemories(userId: string, characterId: string, memories: any[]): Promise<void> {
    if (!this.connected || !this.client) {
      return; // Silently skip caching if Redis not available
    }
    
    try {
      const key = `memories:${userId}:${characterId}`;
      await this.client.setEx(key, 3600, JSON.stringify(memories)); // Cache for 1 hour
    } catch (error) {
      logger.debug('Failed to cache memories (Redis unavailable)');
    }
  }

  public async getCachedMemories(userId: string, characterId: string): Promise<any[] | null> {
    if (!this.connected || !this.client) {
      return null; // No cache available
    }
    
    try {
      const key = `memories:${userId}:${characterId}`;
      const cached = await this.client.get(key);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      logger.debug('Failed to get cached memories (Redis unavailable)');
      return null;
    }
  }

  public async deleteCachedMemories(userId: string, characterId: string): Promise<void> {
    if (!this.connected || !this.client) {
      return;
    }
    try {
      const key = `memories:${userId}:${characterId}`;
      await this.client.del(key);
    } catch (error) {
      logger.debug('Failed to delete cached memories (Redis unavailable)');
    }
  }

  public async cacheUserSubscription(userId: string, subscription: any): Promise<void> {
    if (!this.connected || !this.client) {
      return; // Silently skip caching if Redis not available
    }
    
    try {
      const key = `subscription:${userId}`;
      await this.client.setEx(key, 1800, JSON.stringify(subscription)); // Cache for 30 minutes
    } catch (error) {
      logger.debug('Failed to cache user subscription (Redis unavailable)');
    }
  }

  public async getCachedUserSubscription(userId: string): Promise<any | null> {
    if (!this.connected || !this.client) {
      return null; // No cache available
    }
    
    try {
      const key = `subscription:${userId}`;
      const cached = await this.client.get(key);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      logger.debug('Failed to get cached subscription (Redis unavailable)');
      return null;
    }
  }
}

export const redis = RedisManager.getInstance();

export const getCachedMemories = async (userId: string, characterId: string): Promise<any[] | null> => {
  return redis.getCachedMemories(userId, characterId);
};

export const cacheMemories = async (userId: string, characterId: string, memories: any[], expiresIn: number): Promise<void> => {
  return redis.cacheMemories(userId, characterId, memories);
};
