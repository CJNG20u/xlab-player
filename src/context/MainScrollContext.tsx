import React, {createContext, useCallback, useContext, useMemo, useRef} from 'react';

export interface MainScrollContextValue {
  element: HTMLElement | null;
  getElement: () => HTMLElement | null;
}

const defaultMainScrollValue: MainScrollContextValue = {
  element: null,
  getElement: () => null,
};

const MainScrollContext = createContext<MainScrollContextValue>(defaultMainScrollValue);

interface MainScrollProviderProps {
  element: HTMLElement | null;
  children: React.ReactNode;
}

export const MainScrollProvider: React.FC<MainScrollProviderProps> = ({element, children}) => {
  const elementRef = useRef<HTMLElement | null>(element);
  elementRef.current = element;

  const getElement = useCallback(() => elementRef.current, []);

  const value = useMemo<MainScrollContextValue>(
    () => ({
      element,
      getElement,
    }),
    [element, getElement]
  );

  return <MainScrollContext.Provider value={value}>{children}</MainScrollContext.Provider>;
};

export function useMainScroll(): MainScrollContextValue {
  return useContext(MainScrollContext);
}
