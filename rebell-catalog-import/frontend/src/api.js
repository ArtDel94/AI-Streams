// Points to the backend. In production, set VITE_API_BASE_URL to the Railway backend URL.
// In local dev it's empty so relative paths work via the Vite proxy.
export const API_BASE = import.meta.env.VITE_API_BASE_URL || ''
