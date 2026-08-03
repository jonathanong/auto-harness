import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@auto-harness/ui", "@auto-harness/shared"],
  // Monorepo sources use .ts extensions in imports
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
