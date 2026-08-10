import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // This app lives in a subdirectory of a repo that also has its own
  // package-lock.json (Netlify Forms functions at repo root) -- pin the
  // workspace root explicitly so Turbopack doesn't have to guess.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
