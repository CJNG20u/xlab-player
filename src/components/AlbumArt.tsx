import {Disc3, Heart, Music2} from 'lucide-react';
import React, {useEffect, useState} from 'react';
import {getCoverUrl} from '../lib/api';

interface AlbumArtProps {
  coverFile?: string | null;
  externalUrl?: string | null;
  alt: string;
  color?: string;
  className?: string;
  iconSize?: number;
}

export const AlbumArt: React.FC<AlbumArtProps> = ({
  coverFile,
  externalUrl,
  alt,
  color = '#242424',
  className = 'w-12 h-12 rounded',
  iconSize = 20,
}) => {
  const [errored, setErrored] = useState(false);
  const src = coverFile ? getCoverUrl(coverFile) : externalUrl || null;

  useEffect(() => {
    setErrored(false);
  }, [src]);

  if (!src || errored) {
    return (
      <div
        className={`${className} flex items-center justify-center shrink-0 overflow-hidden select-none`}
        style={{
          background: `linear-gradient(135deg, ${color} 0%, #181818 100%)`,
        }}
        aria-label={alt}
      >
        <Music2 size={iconSize} className="text-white/50" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setErrored(true)}
      className={`${className} object-cover shrink-0 bg-[#282828]`}
      loading="lazy"
    />
  );
};

interface PlaylistMosaicProps {
  covers: string[];
  variant?: 'default' | 'liked' | 'recent' | 'all';
  alt: string;
  className?: string;
}

export const PlaylistMosaic: React.FC<PlaylistMosaicProps> = ({
  covers,
  variant = 'default',
  alt,
  className = 'w-full aspect-square rounded-md',
}) => {
  if (variant === 'liked') {
    return (
      <div
        className={`${className} flex items-center justify-center bg-gradient-to-br from-[#3b28cc] via-[#2b4d8f] to-[#1DB954] shadow-lg`}
        aria-label={alt}
      >
        <Heart className="w-1/3 h-1/3 text-white fill-white" />
      </div>
    );
  }

  if (variant === 'recent') {
    return (
      <div
        className={`${className} flex items-center justify-center bg-gradient-to-br from-[#1DB954] via-[#157a3c] to-[#121212] shadow-lg`}
        aria-label={alt}
      >
        <Disc3 className="w-1/3 h-1/3 text-white" />
      </div>
    );
  }

  const valid = covers.filter(Boolean).slice(0, 4);

  if (valid.length === 0) {
    return (
      <div
        className={`${className} flex items-center justify-center bg-gradient-to-br from-[#282828] to-[#181818]`}
        aria-label={alt}
      >
        <Music2 className="w-1/3 h-1/3 text-[#6A6A6A]" />
      </div>
    );
  }

  if (valid.length < 4) {
    return (
      <AlbumArt
        coverFile={valid[0]}
        alt={alt}
        className={`${className} shadow-lg`}
        iconSize={36}
      />
    );
  }

  return (
    <div
      className={`${className} grid grid-cols-2 grid-rows-2 overflow-hidden bg-[#282828] shadow-lg`}
      aria-label={alt}
    >
      {valid.map((file, i) => (
        <AlbumArt
          key={`${file}-${i}`}
          coverFile={file}
          alt={`${alt} cover ${i + 1}`}
          className="w-full h-full rounded-none"
          iconSize={18}
        />
      ))}
    </div>
  );
};
