/**
 * Static export: the site is plain files served by GitHub Pages. There is no
 * server. All data is fetched by the browser from the JSON the worker publishes.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  basePath,
  images: { unoptimized: true },
  reactStrictMode: true,
  transpilePackages: ["@flowstate/shared", "@flowstate/anomaly-engine", "@flowstate/market-data"],
};

export default nextConfig;
