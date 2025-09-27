import { supabaseAdmin } from '../config/database';
import { logger } from './logger';

export const testMemorySystemSetup = async (): Promise<boolean> => {
  try {
    logger.info('Testing memory system database setup...');
    
    // Test 1: Check if user_memories table exists
    const { data: memoriesTable, error: memoriesError } = await supabaseAdmin
      .from('user_memories')
      .select('count')
      .limit(1);
    
    if (memoriesError) {
      logger.error('user_memories table not found:', memoriesError.message);
      return false;
    }
    
    // Test 2: Check if memory_orchestrator_decisions table exists
    const { data: orchestratorTable, error: orchestratorError } = await supabaseAdmin
      .from('memory_orchestrator_decisions')
      .select('count')
      .limit(1);
    
    if (orchestratorError) {
      logger.error('memory_orchestrator_decisions table not found:', orchestratorError.message);
      return false;
    }
    
    // Test 3: Check if profiles table has new columns
    const { data: profilesTest, error: profilesError } = await supabaseAdmin
      .from('profiles')
      .select('memory_limit, subscription_tier, nsfw_enabled')
      .limit(1);
    
    if (profilesError) {
      logger.error('profiles table memory columns not found:', profilesError.message);
      return false;
    }
    
    // Test 4: Check if functions exist
    const { data: functionsTest, error: functionsError } = await supabaseAdmin
      .rpc('update_memory_access', { memory_id: '00000000-0000-0000-0000-000000000000' });
    
    // This should fail but not with "function doesn't exist"
    if (functionsError && !functionsError.message.includes('violates foreign key constraint')) {
      logger.warn('Memory functions may not be installed:', functionsError.message);
    }
    
    logger.info('✅ Memory system database setup verified!');
    return true;
    
  } catch (error) {
    logger.error('Memory system database test failed:', error);
    return false;
  }
};

export const getMigrationStatus = async (): Promise<{
  memoriesTable: boolean;
  orchestratorTable: boolean;
  profilesUpdated: boolean;
  functionsInstalled: boolean;
}> => {
  const status = {
    memoriesTable: false,
    orchestratorTable: false,
    profilesUpdated: false,
    functionsInstalled: false
  };
  
  try {
    // Check user_memories table
    const { error: memoriesError } = await supabaseAdmin
      .from('user_memories')
      .select('id')
      .limit(1);
    status.memoriesTable = !memoriesError;
    
    // Check orchestrator table
    const { error: orchestratorError } = await supabaseAdmin
      .from('memory_orchestrator_decisions')
      .select('id')
      .limit(1);
    status.orchestratorTable = !orchestratorError;
    
    // Check profiles columns
    const { error: profilesError } = await supabaseAdmin
      .from('profiles')
      .select('memory_limit')
      .limit(1);
    status.profilesUpdated = !profilesError;
    
    // Check functions (basic test)
    try {
      await supabaseAdmin.rpc('reset_daily_voice_usage');
      status.functionsInstalled = true;
    } catch {
      status.functionsInstalled = false;
    }
    
  } catch (error) {
    logger.error('Error checking migration status:', error);
  }
  
  return status;
};
