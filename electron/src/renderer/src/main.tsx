import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Headless } from './Headless';
import { Gallery } from './Gallery';
import './styles.css';

// main loads index.html?headless=1 for `OpenScreen --export`.
// index.html?gallery=<view> shows one hard-to-reach screen with made-up content (development).
const params = new URLSearchParams(location.search);
const gallery = params.get('gallery');
createRoot(document.getElementById('root')!).render(
  params.has('headless') ? <Headless /> : gallery ? <Gallery view={gallery} /> : <App />,
);
