import { useEffect, useState } from 'react';

interface PrefetchOptions {
  priority?: 'high' | 'low';
  timeout?: number;
}

/**
 * Custom hook for prefetching images
 * @param imageUrls Array of image URLs to prefetch
 * @param options Prefetch options
 */
export function useImagePrefetch(
  imageUrls: string[],
  options: PrefetchOptions = {}
) {
  const [prefetchedUrls, setPrefetchedUrls] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { priority = 'low', timeout = 10000 } = options;

  useEffect(() => {
    if (!imageUrls.length) return;

    setLoading(true);
    setError(null);

    const prefetchPromises = imageUrls.map((url) => {
      return new Promise<string>((resolve, reject) => {
        const img = new Image();
        const timeoutId = setTimeout(() => {
          reject(new Error(`Prefetch timeout for ${url}`));
        }, timeout);

        img.onload = () => {
          clearTimeout(timeoutId);
          resolve(url);
        };

        img.onerror = () => {
          clearTimeout(timeoutId);
          reject(new Error(`Failed to load ${url}`));
        };

        // Set loading priority
        if (priority === 'high') {
          img.loading = 'eager';
        } else {
          img.loading = 'lazy';
        }

        img.src = url;
      });
    });

    Promise.allSettled(prefetchPromises)
      .then((results) => {
        const successful = results
          .filter((result) => result.status === 'fulfilled')
          .map((result) => (result as PromiseFulfilledResult<string>).value);
        
        setPrefetchedUrls(new Set(successful));
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [imageUrls, priority, timeout]);

  return {
    prefetchedUrls,
    loading,
    error,
    isPrefetched: (url: string) => prefetchedUrls.has(url),
  };
}

/**
 * Hook for prefetching images with intersection observer
 * Only prefetches images when they come into view
 */
export function useIntersectionPrefetch(
  imageUrls: string[],
  options: PrefetchOptions = {}
) {
  const [visibleUrls, setVisibleUrls] = useState<Set<string>>(new Set());
  const [prefetchedUrls, setPrefetchedUrls] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!imageUrls.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const url = entry.target.getAttribute('data-src');
            if (url) {
              setVisibleUrls((prev) => new Set([...prev, url]));
            }
          }
        });
      },
      {
        rootMargin: '50px', // Start prefetching 50px before image comes into view
        threshold: 0.1,
      }
    );

    // Create placeholder elements for intersection observer
    const elements = imageUrls.map((url) => {
      const element = document.createElement('div');
      element.setAttribute('data-src', url);
      element.style.height = '1px';
      element.style.width = '1px';
      element.style.position = 'absolute';
      element.style.top = '-1000px';
      document.body.appendChild(element);
      observer.observe(element);
      return element;
    });

    return () => {
      elements.forEach((element) => {
        observer.unobserve(element);
        document.body.removeChild(element);
      });
      observer.disconnect();
    };
  }, [imageUrls]);

  // Prefetch visible images
  useEffect(() => {
    if (!visibleUrls.size) return;

    const urlsToPrefetch = Array.from(visibleUrls).filter(
      (url) => !prefetchedUrls.has(url)
    );

    if (!urlsToPrefetch.length) return;

    const prefetchPromises = urlsToPrefetch.map((url) => {
      return new Promise<string>((resolve, reject) => {
        const img = new Image();
        const timeoutId = setTimeout(() => {
          reject(new Error(`Prefetch timeout for ${url}`));
        }, options.timeout || 10000);

        img.onload = () => {
          clearTimeout(timeoutId);
          resolve(url);
        };

        img.onerror = () => {
          clearTimeout(timeoutId);
          reject(new Error(`Failed to load ${url}`));
        };

        img.src = url;
      });
    });

    Promise.allSettled(prefetchPromises)
      .then((results) => {
        const successful = results
          .filter((result) => result.status === 'fulfilled')
          .map((result) => (result as PromiseFulfilledResult<string>).value);
        
        setPrefetchedUrls((prev) => new Set([...prev, ...successful]));
      });
  }, [visibleUrls, prefetchedUrls, options.timeout]);

  return {
    prefetchedUrls,
    isPrefetched: (url: string) => prefetchedUrls.has(url),
  };
}
