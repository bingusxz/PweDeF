import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'pdfjs-dist/web/pdf_viewer.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/courier-prime/400.css';
import '@fontsource/courier-prime/700.css';
import './styles.css';
import App from './App';

// The app frame never scrolls. If something (a focused field, a resize) nudges the page, put it straight back,
// so the title bar and toolbar can't end up cut off.
const keepInPlace = () => {
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  const el = document.scrollingElement;
  if (el && (el.scrollTop || el.scrollLeft)) {
    el.scrollTop = 0;
    el.scrollLeft = 0;
  }
};
window.addEventListener('scroll', keepInPlace, { passive: true });
window.addEventListener('resize', keepInPlace, { passive: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
