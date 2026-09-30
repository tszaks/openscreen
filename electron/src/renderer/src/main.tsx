import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Headless } from './Headless';
import './styles.css';

// main loads index.html?headless=1 for `OpenScreen --export`.
const headless = new URLSearchParams(location.search).has('headless');
createRoot(document.getElementById('root')!).render(headless ? <Headless /> : <App />);
