import React from 'react';

interface BrandLogoProps {
  size?: 'sm' | 'md' | 'lg';
  showWordmark?: boolean;
}

export const BrandLogo: React.FC<BrandLogoProps> = ({size = 'md', showWordmark = true}) => {
  const iconDims = size === 'sm' ? 'h-7 w-7' : size === 'lg' ? 'h-12 w-12' : 'h-8 w-8';
  const textSize =
    size === 'sm' ? 'text-base' : size === 'lg' ? 'text-2xl' : 'text-lg';

  return (
    <div className="inline-flex items-center gap-2.5 select-none whitespace-nowrap shrink-0">
      <svg
        viewBox="0 0 512 512"
        className={`${iconDims} shrink-0`}
        aria-hidden="true"
      >
        <rect width="512" height="512" rx="104" fill="#121212" />
        <circle cx="256" cy="256" r="204" fill="#1DB954" />
        <rect x="132" y="216" width="24" height="80" rx="12" fill="#121212" />
        <rect x="172" y="172" width="24" height="168" rx="12" fill="#121212" />
        <path
          d="M222 174C222 164.5 232.3 158.6 240.5 163.4L368.5 239.4C376.5 244.1 376.5 255.9 368.5 260.6L240.5 336.6C232.3 341.4 222 335.5 222 326V174Z"
          fill="#121212"
        />
      </svg>
      {showWordmark && (
        <span className={`font-display font-bold tracking-tight text-white ${textSize}`}>
          xlabplayer
        </span>
      )}
    </div>
  );
};
