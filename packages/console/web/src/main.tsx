import React from "react";
import ReactDOM from "react-dom/client";
// normalize.css first: it's the single source of cross-browser default styles,
// so it must precede every other stylesheet (including index.css's tailwind
// layers and antd's runtime CSS-in-JS).
import "normalize.css";
import "./index.css";
import { createHashRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "./theme";
import { App } from './App';
import './console-visual.css';

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        const status = (error as { status?: number })?.status;
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 1;
      },
    },
  },
});

const router = createHashRouter([{ path: '*', element: <App /> }]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
