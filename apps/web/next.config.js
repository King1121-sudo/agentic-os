/** @type {import('next').NextConfig} */
const API = process.env.AGENTIC_API_URL || 'http://localhost:4000';

const nextConfig = {
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API}/api/:path*` },
    ];
  },
};

module.exports = nextConfig;
