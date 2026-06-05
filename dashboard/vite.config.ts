import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite dev server config.
 *
 * Reverse proxies so the browser can talk to Jenkins without CORS, with API
 * tokens injected server-side (never shipped to the client bundle):
 *
 *   /_jenkins/impact/*  →  https://jenkins.inca.infoblox.com/*
 *                          IMPACT_JENKINS_USER / IMPACT_JENKINS_API_TOKEN
 *   /_jenkins/inca/*    →  https://jenkins.inca.infoblox.com/*
 *                          JENKINS_USER / JENKINS_API_TOKEN
 *   /_jenkins/ut/*      →  http://10.197.38.69:8080/*
 *                          UT_JENKINS_USER / UT_JENKINS_API_TOKEN
 *
 * These env vars MUST NOT be prefixed with VITE_ — otherwise they would be
 * inlined into the client bundle. Put them in `.env.local` (gitignored).
 *
 * IMPORTANT: when an upstream returns 401 it includes a `WWW-Authenticate:
 * Basic` header. If we forward that to the browser, Chrome/Safari pop a
 * native login dialog for localhost:5173. We strip it so auth failures
 * surface as in-app error cards instead.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  const incaAuth =
    env.JENKINS_USER && env.JENKINS_API_TOKEN
      ? `${env.JENKINS_USER}:${env.JENKINS_API_TOKEN}`
      : undefined;
  const utAuth =
    env.UT_JENKINS_USER && env.UT_JENKINS_API_TOKEN
      ? `${env.UT_JENKINS_USER}:${env.UT_JENKINS_API_TOKEN}`
      : undefined;
  const impactAuth =
    env.IMPACT_JENKINS_USER && env.IMPACT_JENKINS_API_TOKEN
      ? `${env.IMPACT_JENKINS_USER}:${env.IMPACT_JENKINS_API_TOKEN}`
      : incaAuth;

  // Boot log so missing tokens are obvious in the terminal.
  // eslint-disable-next-line no-console
  console.log(
    "[vite proxy] jenkins auth →",
    `inca=${incaAuth ? "set" : "MISSING"}`,
    `ut=${utAuth ? "set" : "MISSING"}`,
    `impact=${impactAuth ? "set" : "MISSING"}`,
  );

  const stripBasicChallenge: ProxyOptions["configure"] = (proxy) => {
    proxy.on("proxyRes", (proxyRes) => {
      delete proxyRes.headers["www-authenticate"];
    });
    proxy.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[vite proxy] upstream error:", err.message);
    });
  };

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/_jenkins/impact": {
          target: "https://jenkins.inca.infoblox.com",
          changeOrigin: true,
          secure: false,
          auth: impactAuth,
          rewrite: (p) => p.replace(/^\/_jenkins\/impact/, ""),
          configure: stripBasicChallenge,
        },
        "/_jenkins/inca": {
          target: "https://jenkins.inca.infoblox.com",
          changeOrigin: true,
          secure: false,
          auth: incaAuth,
          rewrite: (p) => p.replace(/^\/_jenkins\/inca/, ""),
          configure: stripBasicChallenge,
        },
        "/_jenkins/ut": {
          target: "http://10.197.38.69:8080",
          changeOrigin: true,
          secure: false,
          auth: utAuth,
          rewrite: (p) => p.replace(/^\/_jenkins\/ut/, ""),
          configure: stripBasicChallenge,
        },
      },
    },
  };
});
