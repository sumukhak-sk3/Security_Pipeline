import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { backendPlugin } from "./vite-backend-plugin";

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
  const hasImpactCreds = !!(env.IMPACT_JENKINS_USER && env.IMPACT_JENKINS_API_TOKEN);
  const impactAuth = hasImpactCreds
    ? `${env.IMPACT_JENKINS_USER}:${env.IMPACT_JENKINS_API_TOKEN}`
    : incaAuth;
  const hasQa2Creds = !!(env.QA2_JENKINS_USER && env.QA2_JENKINS_API_TOKEN);
  const qa2Auth = hasQa2Creds
    ? `${env.QA2_JENKINS_USER}:${env.QA2_JENKINS_API_TOKEN}`
    : incaAuth;
  const rpToken = env.RP_BEARER_KEY ?? "";
  const dtrackToken = env.DTRACK_API_KEY ?? "";

  // Disambiguate dedicated creds vs inherited fallback so a missing
  // IMPACT_*/QA2_* token does not silently masquerade as configured.
  const authState = (
    hasDedicated: boolean,
    resolved: string | undefined,
  ): string => {
    if (hasDedicated) return "set";
    if (resolved) return "set(via-inca-fallback)";
    return "MISSING";
  };

  // TLS verification on the Jenkins HTTPS proxies. Default is to verify;
  // set JENKINS_PROXY_TLS_INSECURE=1 in .env.local only when the upstream
  // uses a self-signed or otherwise untrusted cert.
  const proxySecure = env.JENKINS_PROXY_TLS_INSECURE !== "1";

  // Boot log so missing tokens are obvious in the terminal.
  // eslint-disable-next-line no-console
  console.log(
    "[vite proxy] jenkins auth \u2192",
    `inca=${incaAuth ? "set" : "MISSING"}`,
    `ut=${utAuth ? "set" : "MISSING"}`,
    `impact=${authState(hasImpactCreds, impactAuth)}`,
    `qa2=${authState(hasQa2Creds, qa2Auth)}`,
    `rp=${rpToken ? "set" : "MISSING"}`,
    `dtrack=${dtrackToken ? "set" : "MISSING"}`,
    `tls=${proxySecure ? "verify" : "INSECURE"}`,
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
    plugins: [react(), backendPlugin()],
    server: {
      port: 5173,
      hmr: {
        path: "/__vite_hmr",  // Use explicit path so it doesn't conflict with /_ws
      },
      proxy: {
        "/_jenkins/impact": {
          target: "https://jenkins.inca.infoblox.com",
          changeOrigin: true,
          secure: proxySecure,
          auth: impactAuth,
          rewrite: (p) => p.replace(/^\/_jenkins\/impact/, ""),
          configure: stripBasicChallenge,
        },
        "/_jenkins/inca": {
          target: "https://jenkins.inca.infoblox.com",
          changeOrigin: true,
          secure: proxySecure,
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
        "/_jenkins/qa2": {
          target: env.QA2_JENKINS_BASE_URL || "https://jenkins-qa2.inca.infoblox.com",
          changeOrigin: true,
          secure: proxySecure,
          auth: qa2Auth,
          rewrite: (p) => p.replace(/^\/_jenkins\/qa2/, ""),
          configure: stripBasicChallenge,
        },
        "/_rp": {
          target: "http://10.34.98.129:8080",
          changeOrigin: true,
          secure: false,
          rewrite: (p) => p.replace(/^\/_rp/, ""),
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              if (rpToken) {
                proxyReq.setHeader("Authorization", `Bearer ${rpToken}`);
              }
            });
            proxy.on("error", (err) => {
              // eslint-disable-next-line no-console
              console.error("[vite proxy] RP upstream error:", err.message);
            });
          },
        },
        "/_dtrack": {
          target: "http://54.215.67.129:8081",
          changeOrigin: true,
          secure: false,
          rewrite: (p) => p.replace(/^\/_dtrack/, ""),
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              if (dtrackToken) {
                proxyReq.setHeader("X-Api-Key", dtrackToken);
              }
            });
            proxy.on("error", (err) => {
              // eslint-disable-next-line no-console
              console.error("[vite proxy] DTrack upstream error:", err.message);
            });
          },
        },
      },
    },
  };
});
