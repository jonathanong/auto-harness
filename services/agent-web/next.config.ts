import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@auto-harness/ui", "@auto-harness/shared"],
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
