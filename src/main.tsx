import {createRoot} from 'react-dom/client';
import {registerSW} from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

// Register service worker for PWA installation & offline shell caching
registerSW({immediate: true});

createRoot(document.getElementById('root')!).render(<App />);
