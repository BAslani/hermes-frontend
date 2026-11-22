import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Development only: open the dev server from another device on the local
  // network, whatever address this machine has there (localhost is always allowed).
  allowedDevOrigins: ["10.*.*.*", "172.*.*.*", "192.168.*.*"],
  cacheComponents: true,
  partialPrefetching: true,
  // Self-contained server bundle, as map-witel deploys it.
  output: "standalone",
  poweredByHeader: false,
  // Development only: /sat imagery tiles allow just the 141.ir origin, so the
  // dev server proxies them to stay same-origin. In production, off map.141.ir,
  // src/lib/imagery.ts falls back to imagery rendered by tileserver-gl.
  async rewrites() {
    if (process.env.NODE_ENV !== "development") return [];
    const tileServer =
      process.env.NEXT_PUBLIC_TILE_SERVER_URL ?? "https://map.141.ir";
    return [{ source: "/sat/:path*", destination: `${tileServer}/sat/:path*` }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
