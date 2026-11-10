import React from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './styles/dsh-tokens.css';
import './styles/app.css';
import './styles/markdown.css';
import './styles/editor.css';
import './styles/desktop.css';
import './styles/mobile.css';
import { App } from './App.tsx';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
