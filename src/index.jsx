import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './main.js';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { wagmiConfig } from './main.js';

const queryClient = new QueryClient();

const root = createRoot(document.getElementById('root'));
root.render(
  <WagmiProvider config={wagmiConfig}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </WagmiProvider>
);
