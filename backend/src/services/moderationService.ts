import { logger } from '../utils/logger';

interface ModerationResult {
  flagged: boolean;
  categories?: {
    'sexual/minors'?: boolean;
    hate?: boolean;
    'hate/threatening'?: boolean;
  };
}

/**
 * Check content against OpenAI moderation API
 * Hard-blocks sexual/minors (CSAM-related), hate, and hate/threatening content
 */
export async function checkModeration(content: string): Promise<ModerationResult> {
  if (!content || content.trim().length === 0) {
    return { flagged: false };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set, skipping moderation check');
    return { flagged: false };
  }

  try {
    const response = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        input: content,
        model: 'omni-moderation-latest',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      logger.error({
        message: 'OpenAI moderation API error',
        status: response.status,
        error: errorText,
      });
      // On API error, allow content through (fail open) but log it
      return { flagged: false };
    }

    const data = await response.json() as {
      results?: Array<{
        categories?: Record<string, boolean>;
        category_scores?: Record<string, number>;
      }>;
    };
    const results = data.results?.[0];

    if (!results) {
      logger.warn('Unexpected moderation API response format', { data });
      return { flagged: false };
    }

    // Check for hard-block categories: sexual/minors, hate, hate/threatening
    const categories = results.categories || {};
    const categoryScores = results.category_scores || {};
    
    const flaggedCategories: ModerationResult['categories'] = {};
    let shouldBlock = false;

    // Check sexual/minors (CSAM-related)
    if (categories['sexual/minors']) {
      flaggedCategories['sexual/minors'] = true;
      shouldBlock = true;
      logger.warn({
        message: 'Content flagged for sexual/minors (CSAM-related)',
        score: categoryScores['sexual/minors'],
        contentPreview: content.substring(0, 100),
      });
    }

    // Check hate
    if (categories.hate) {
      flaggedCategories.hate = true;
      shouldBlock = true;
      logger.warn({
        message: 'Content flagged for hate',
        score: categoryScores.hate,
        contentPreview: content.substring(0, 100),
      });
    }

    // Check hate/threatening
    if (categories['hate/threatening']) {
      flaggedCategories['hate/threatening'] = true;
      shouldBlock = true;
      logger.warn({
        message: 'Content flagged for hate/threatening',
        score: categoryScores['hate/threatening'],
        contentPreview: content.substring(0, 100),
      });
    }

    if (shouldBlock) {
      logger.error({
        message: 'Content blocked by moderation',
        flaggedCategories,
        contentLength: content.length,
        contentPreview: content.substring(0, 200),
      });
    }

    const result: ModerationResult = {
      flagged: shouldBlock
    };

    if (Object.keys(flaggedCategories).length > 0) {
      result.categories = flaggedCategories;
    }

    return result;
  } catch (error: any) {
    logger.error({
      message: 'Error calling OpenAI moderation API',
      error: error.message,
      stack: error.stack,
    });
    // On error, allow content through (fail open) but log it
    return { flagged: false };
  }
}

