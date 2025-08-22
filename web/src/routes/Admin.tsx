import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../contexts/AuthContext';

type Character = {
  id: string;
  name: string;
  avatar_url: string | null;
};

type GalleryImage = {
  id: string;
  character_id: string;
  image_path: string;
  caption: string | null;
  is_preview: boolean;
  url: string;
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
  const [galleryImages, setGalleryImages] = useState<GalleryImage[]>([]);
  const [loadingGallery, setLoadingGallery] = useState<boolean>(false);
  const [selectedManageCharacterId, setSelectedManageCharacterId] = useState<string>('');
  const [deleteConfirm, setDeleteConfirm] = useState<{imageId: string, imagePath: string} | null>(null);

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
          setSelectedManageCharacterId(data[0].id);
        }
      }
    };

    loadCharacters();
  }, []);

  const loadGalleryImages = async (characterId: string) => {
    if (!characterId) return;
    
    setLoadingGallery(true);
    try {
      const { data, error } = await supabase
        .from('character_galleries')
        .select('*')
        .eq('character_id', characterId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const imagesWithUrls = (data || []).map(img => ({
        ...img,
        url: supabase.storage.from('galleries').getPublicUrl(img.image_path).data.publicUrl
      }));

      setGalleryImages(imagesWithUrls);
    } catch (err: any) {
      setError(`Failed to load gallery images: ${err.message}`);
    } finally {
      setLoadingGallery(false);
    }
  };

  const deleteGalleryImage = async (imageId: string, imagePath: string) => {
    try {
      // Delete from storage
      const { error: storageError } = await supabase.storage
        .from('galleries')
        .remove([imagePath]);

      if (storageError) throw storageError;

      // Delete from database
      const { error: dbError } = await supabase
        .from('character_galleries')
        .delete()
        .eq('id', imageId);

      if (dbError) throw dbError;

      setMessage('Image deleted successfully!');
      setDeleteConfirm(null);
      
      // Reload gallery images
      if (selectedManageCharacterId) {
        loadGalleryImages(selectedManageCharacterId);
      }
    } catch (err: any) {
      setError(`Failed to delete image: ${err.message}`);
      setDeleteConfirm(null);
    }
  };

  useEffect(() => {
    if (selectedManageCharacterId) {
      loadGalleryImages(selectedManageCharacterId);
    }
  }, [selectedManageCharacterId]);

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

        // Get public URL (for reference, stored in database as image_path)
        supabase.storage
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

      {/* Gallery Management Section */}
      <div className="mt-12 border-t border-white/10 pt-8">
        <h3 className="mb-4 text-xl font-semibold text-white">Manage Gallery Images</h3>
        
        <div className="mb-4">
          <label className="block text-sm font-medium text-white mb-2">
            Select Character to Manage
          </label>
          <select
            value={selectedManageCharacterId}
            onChange={(e) => setSelectedManageCharacterId(e.target.value)}
            className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-white focus:border-pink-500 focus:outline-none"
          >
            <option value="">Select a character...</option>
            {characters.map((char) => (
              <option key={char.id} value={char.id} className="bg-gray-900">
                {char.name}
              </option>
            ))}
          </select>
        </div>

        {loadingGallery && (
          <p className="text-gray-300">Loading gallery images...</p>
        )}

        {selectedManageCharacterId && !loadingGallery && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
            {galleryImages.map((image) => (
              <div key={image.id} className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/5">
                <img 
                  src={image.url} 
                  alt={image.caption || 'Gallery image'} 
                  className="w-full aspect-[3/4] object-cover"
                />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/60 transition-colors flex items-center justify-center">
                  <button
                    onClick={() => setDeleteConfirm({imageId: image.id, imagePath: image.image_path})}
                    className="opacity-0 group-hover:opacity-100 transition-opacity bg-red-500 hover:bg-red-600 text-white px-3 py-1 rounded-lg text-sm font-medium"
                  >
                    Delete
                  </button>
                </div>
                {image.caption && (
                  <div className="absolute bottom-0 left-0 right-0 bg-black/70 p-2">
                    <p className="text-xs text-white truncate">{image.caption}</p>
                  </div>
                )}
                {image.is_preview && (
                  <div className="absolute top-2 left-2 bg-pink-500 text-white px-2 py-1 rounded text-xs font-medium">
                    Preview
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {selectedManageCharacterId && !loadingGallery && galleryImages.length === 0 && (
          <p className="text-gray-300">No gallery images found for this character.</p>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setDeleteConfirm(null)}
        >
          <div 
            className="mx-4 w-full max-w-md rounded-2xl border border-white/20 bg-gray-900/95 p-6 shadow-2xl backdrop-blur-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 text-xl font-semibold text-white">Confirm Delete</h3>
            <p className="mb-6 text-gray-300">
              Are you sure you want to delete this image? This action cannot be undone.
            </p>
            
            <div className="flex gap-3">
              <button
                onClick={() => deleteGalleryImage(deleteConfirm.imageId, deleteConfirm.imagePath)}
                className="flex-1 rounded-lg bg-red-500 hover:bg-red-600 px-4 py-2 text-white font-medium transition"
              >
                Delete
              </button>
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 rounded-lg border border-white/20 bg-white/5 hover:bg-white/10 px-4 py-2 text-white font-medium transition"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
