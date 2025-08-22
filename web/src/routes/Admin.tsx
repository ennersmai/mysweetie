import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../contexts/AuthContext';

type Character = {
  id: string;
  name: string;
  avatar_url: string | null;
};

export default function Admin() {
  const { user } = useAuth();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string>('');
  const [caption, setCaption] = useState<string>('');
  const [isPreview, setIsPreview] = useState<boolean>(false);
  const [files, setFiles] = useState<FileList | null>(null);
  const [uploading, setUploading] = useState<boolean>(false);
  const [message, setMessage] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    const loadCharacters = async () => {
      const { data, error } = await supabase
        .from('characters')
        .select('id, name, avatar_url')
        .order('created_at', { ascending: true });
      
      if (error) {
        setError(error.message);
      } else {
        setCharacters(data || []);
        if (data && data.length > 0) {
          setSelectedCharacterId(data[0].id);
        }
      }
    };

    loadCharacters();
  }, []);

  const handleUpload = async (e: FormEvent) => {
    e.preventDefault();
    if (!files || files.length === 0) {
      setError('Please select at least one file');
      return;
    }
    if (!selectedCharacterId) {
      setError('Please select a character');
      return;
    }

    setUploading(true);
    setError('');
    setMessage('');

    try {
      const uploadedImages = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        
        // Generate unique filename
        const fileExt = file.name.split('.').pop();
        const fileName = `${Date.now()}-${Math.random().toString(36).substring(2)}.${fileExt}`;
        const filePath = `galleries/${fileName}`;

        // Upload to Supabase Storage
        const { error: uploadError } = await supabase.storage
          .from('galleries')
          .upload(filePath, file, {
            cacheControl: '3600',
            upsert: false
          });

        if (uploadError) {
          throw uploadError;
        }

        // Get public URL
        const { data: urlData } = supabase.storage
          .from('galleries')
          .getPublicUrl(filePath);

        // Save to database
        const { error: dbError } = await supabase
          .from('character_galleries')
          .insert({
            character_id: selectedCharacterId,
            image_path: filePath,
            caption: caption || null,
            is_preview: isPreview
          });

        if (dbError) {
          throw dbError;
        }

        uploadedImages.push(fileName);
      }

      setMessage(`Successfully uploaded ${uploadedImages.length} image(s)!`);
      setCaption('');
      setIsPreview(false);
      setFiles(null);
      
      // Reset file input
      const fileInput = document.getElementById('file-input') as HTMLInputElement;
      if (fileInput) {
        fileInput.value = '';
      }

    } catch (err: any) {
      setError(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  if (!user) {
    return (
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl backdrop-blur">
        <h2 className="mb-4 text-xl font-semibold text-white">Admin - Gallery Upload</h2>
        <p className="text-gray-300">Please sign in to access admin features.</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl backdrop-blur">
      <h2 className="mb-4 text-xl font-semibold text-white">Gallery Upload</h2>
      
      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-red-200">
          {error}
        </div>
      )}
      
      {message && (
        <div className="mb-4 rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-green-200">
          {message}
        </div>
      )}

      <form onSubmit={handleUpload} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-white mb-2">
            Character
          </label>
          <select
            value={selectedCharacterId}
            onChange={(e) => setSelectedCharacterId(e.target.value)}
            className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-white focus:border-pink-500 focus:outline-none"
            required
          >
            <option value="">Select a character...</option>
            {characters.map((char) => (
              <option key={char.id} value={char.id} className="bg-gray-900">
                {char.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-white mb-2">
            Images
          </label>
          <input
            id="file-input"
            type="file"
            multiple
            accept="image/*"
            onChange={(e) => setFiles(e.target.files)}
            className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-white focus:border-pink-500 focus:outline-none file:mr-4 file:py-1 file:px-2 file:rounded file:border-0 file:text-sm file:bg-pink-500 file:text-white hover:file:bg-pink-600"
            required
          />
          <p className="mt-1 text-xs text-gray-400">
            Select one or more images to upload. Supported formats: JPG, PNG, GIF, WebP
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-white mb-2">
            Caption (Optional)
          </label>
          <input
            type="text"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-white focus:border-pink-500 focus:outline-none"
            placeholder="Enter a caption for the images..."
          />
        </div>

        <div className="flex items-center">
          <input
            type="checkbox"
            id="is-preview"
            checked={isPreview}
            onChange={(e) => setIsPreview(e.target.checked)}
            className="h-4 w-4 rounded border-white/20 bg-white/5 text-pink-500 focus:ring-pink-500"
          />
          <label htmlFor="is-preview" className="ml-2 text-sm text-white">
            Mark as preview image
          </label>
        </div>

        <button
          type="submit"
          disabled={uploading}
          className="w-full rounded-lg bg-gradient-to-r from-pink-500 to-purple-600 px-4 py-2 text-white shadow transition hover:brightness-110 disabled:opacity-50"
        >
          {uploading ? 'Uploading...' : 'Upload Images'}
        </button>
      </form>

      <div className="mt-8">
        <h3 className="mb-3 text-lg font-medium text-white">Instructions:</h3>
        <ul className="space-y-2 text-sm text-gray-300">
          <li>• Select the character you want to upload images for</li>
          <li>• Choose one or more image files (JPG, PNG, GIF, WebP)</li>
          <li>• Add an optional caption that will apply to all selected images</li>
          <li>• Check "Mark as preview" if these should be preview images</li>
          <li>• Click "Upload Images" to add them to the gallery</li>
        </ul>
      </div>
    </section>
  );
}
