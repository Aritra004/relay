import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Keep React debug data in the page payload. A delayed development WebSocket
    // must not block hydration and leave the local workspace waiting to restore.
    reactDebugChannel: false,
  },
  async headers() {
    return [{ source: "/sw.js", headers: [
      { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
      { key: "Service-Worker-Allowed", value: "/" },
    ] }];
  },
};

export default nextConfig;
