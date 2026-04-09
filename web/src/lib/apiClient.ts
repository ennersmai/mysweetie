import { supabase } from './supabaseClient';

function normalizeBaseUrl(raw: string | undefined): string {
  let base = (raw || '').trim();
  // Fix common typo: missing colon in scheme (e.g., "http//localhost:3001/api")
  if (/^http\/\//i.test(base)) base = base.replace(/^http\//i, 'http://');
  if (/^https\/\//i.test(base)) base = base.replace(/^https\//i, 'https://');
  // If still not absolute, default to local backend
  if (!/^https?:\/\//i.test(base)) {
    base = 'http://localhost:3001/api';
  }
  // Remove trailing slash for consistent joining
  base = base.replace(/\/$/, '');
  return base;
}

const API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL);

function joinUrl(endpoint: string): string {
  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${API_BASE_URL}${path}`;
}

async function getAuthToken() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token;
}

export const apiClient = {
  async post(endpoint: string, body: any) {
    const token = await getAuthToken();
    const response = await fetch(joinUrl(endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    return response;
  },

  async get(endpoint: string) {
    const token = await getAuthToken();
    const response = await fetch(joinUrl(endpoint), {
      method: 'GET',
      cache: 'no-store',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });
    return response;
  },

  async put(endpoint: string, body: any) {
    const token = await getAuthToken();
    const response = await fetch(joinUrl(endpoint), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    return response;
  },

  async delete(endpoint: string) {
    const token = await getAuthToken();
    const response = await fetch(joinUrl(endpoint), {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });
    return response;
  },
  
  // Specifically for the chat stream
  async stream(endpoint: string, body: any) {
    const token = await getAuthToken();
    return fetch(joinUrl(endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  },

  // Specifically for the audio stream
  async streamAudio(endpoint: string, body: any, signal?: AbortSignal) {
    const token = await getAuthToken();
    return fetch(joinUrl(endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'audio/pcm',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal,
    });
  },
};
