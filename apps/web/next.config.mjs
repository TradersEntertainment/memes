import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

// The monorepo keeps one .env at the repo root; Next only auto-loads app-local
// env files, so pull the root one in for DATABASE_URL etc.
config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@insiderscope/db', '@insiderscope/shared'],
};

export default nextConfig;
