import { NextResponse } from "next/server";
import { createProxyPool } from "@/models";

// Relay worker source code deployed to Cloudflare.
//
// Two extensions over the plain forwarder:
//   1. If the client sends no Authorization header, the worker injects the
//      9router API key read from the ROUTER_API_KEY env var. The key never
//      reaches the client device, so it cannot leak from there.
//   2. If RELAY_SECRET is set, the worker requires a matching x-relay-secret
//      header. This is a deliberate second gate: a URL is not a secret, so
//      without this anyone who learns the workers.dev hostname gets the key
//      for free.
//
// The env vars are optional. Without them the worker behaves exactly like the
// original forwarder, which keeps existing deployments valid after upgrade.
const RELAY_WORKER_CODE = `
export default {
  async fetch(request, env, ctx) {
    const target = request.headers.get("x-relay-target");
    const relayPath = request.headers.get("x-relay-path") || "/";

    if (!target) {
      return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    // Gate 1: shared secret. Only enforced when the operator set one.
    if (env.RELAY_SECRET) {
      const provided = request.headers.get("x-relay-secret");
      if (provided !== env.RELAY_SECRET) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
    }

    const targetUrl = target.replace(/\\/$/, "") + relayPath;
    const newRequestInit = {
      method: request.method,
      headers: new Headers(request.headers),
    };

    newRequestInit.headers.delete("x-relay-target");
    newRequestInit.headers.delete("x-relay-path");
    newRequestInit.headers.delete("x-relay-secret");
    newRequestInit.headers.delete("host");

    // Gate 2: auto-key. When the client did not bring its own credential and
    // the operator stored one, this is what makes the relay usable without
    // shipping the key to every device.
    if (env.ROUTER_API_KEY && !newRequestInit.headers.get("authorization")) {
      newRequestInit.headers.set("authorization", \`Bearer \${env.ROUTER_API_KEY}\`);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      newRequestInit.body = request.body;
      newRequestInit.duplex = "half";
    }

    try {
      const response = await fetch(targetUrl, newRequestInit);
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  },
};
`;

// POST /api/proxy-pools/cloudflare-deploy
export async function POST(request) {
  try {
    const body = await request.json();
    const accountId = body.accountId?.trim();
    const apiToken = body.apiToken?.trim();
    const projectName = body.projectName?.trim() || `relay-${Date.now().toString(36)}`;
    // Optional. When present, the worker injects the 9router key and requires
    // the shared secret from callers. Both env vars are stored on the Worker
    // (not on the client), so a leaked relay URL alone is not enough access.
    const routerApiKey = typeof body.routerApiKey === "string" ? body.routerApiKey.trim() : "";
    const relaySecret = typeof body.relaySecret === "string" ? body.relaySecret.trim() : "";

    if (!accountId || !apiToken) {
      return NextResponse.json({ error: "Cloudflare Account ID and API Token are required" }, { status: 400 });
    }

    // 1. Upload Worker Script
    const workerScriptUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${projectName}`;
    
    // Cloudflare requires multipart/form-data for worker script upload
    const formData = new FormData();
    formData.append("index.js", new Blob([RELAY_WORKER_CODE], { type: "application/javascript+module" }), "index.js");
    formData.append("metadata", new Blob([JSON.stringify({
      main_module: "index.js",
      compatibility_date: "2024-03-20",
      observability: { enabled: true }
    })], { type: "application/json" }), "metadata.json");

    const uploadRes = await fetch(workerScriptUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      body: formData,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}));
      console.error("Cloudflare upload error:", err);
      return NextResponse.json(
        { error: err.errors?.[0]?.message || "Failed to upload Worker to Cloudflare" },
        { status: uploadRes.status }
      );
    }

    // 2. Enable workers.dev subdomain for the script
    const enableSubdomainRes = await fetch(`${workerScriptUrl}/subdomain`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: true }),
    });

    if (!enableSubdomainRes.ok) {
      const err = await enableSubdomainRes.json().catch(() => ({}));
      console.error("Cloudflare subdomain enable error:", err);
      // We don't fail completely here, just continue
    }

    // 2b. Store the optional credentials on the Worker itself.
    //
    // The Worker runs in Cloudflare's edge; the values must live there, not be
    // sent by each caller. Cloudflare accepts a plain-text env PUT; we only
    // send the keys the operator supplied, so a deployment without them stays
    // a plain forwarder.
    if (routerApiKey || relaySecret) {
      const envVars = {};
      if (routerApiKey) envVars.ROUTER_API_KEY = routerApiKey;
      if (relaySecret) envVars.RELAY_SECRET = relaySecret;
      const envRes = await fetch(`${workerScriptUrl}/settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ bindings: Object.entries(envVars).map(([name, text]) => ({ type: "plain_text", name, text })) }),
      });
      if (!envRes.ok) {
        const err = await envRes.json().catch(() => ({}));
        // Failing open here would leave the Worker thinking it has no key,
        // which silently breaks the auto-key contract. Report it.
        return NextResponse.json(
          { error: err.errors?.[0]?.message || "Worker deployed but failed to set env vars" },
          { status: envRes.status }
        );
      }
    }

    // 3. Get the workers.dev subdomain for the account to construct the final URL
    let deployUrl = "";
    const subdomainRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
    });

    if (subdomainRes.ok) {
      const subdomainData = await subdomainRes.json();
      if (subdomainData.result && subdomainData.result.subdomain) {
        deployUrl = `https://${projectName}.${subdomainData.result.subdomain}.workers.dev`;
      }
    }

    if (!deployUrl) {
       return NextResponse.json(
        { error: "Worker deployed but failed to retrieve workers.dev subdomain. Make sure you have setup a workers.dev subdomain in Cloudflare Dashboard." },
        { status: 400 }
      );
    }

    // Create proxy pool entry with type cloudflare
    const proxyPool = await createProxyPool({
      name: projectName,
      proxyUrl: deployUrl,
      type: "cloudflare",
      noProxy: "",
      isActive: true,
      strictProxy: false,
    });

    return NextResponse.json({ proxyPool, deployUrl }, { status: 201 });
  } catch (error) {
    console.log("Error deploying Cloudflare relay:", error);
    return NextResponse.json({ error: error.message || "Deploy failed" }, { status: 500 });
  }
}
