# Running behind a reverse proxy

Rate limits are keyed on the client's IP (`getClientIp` in `#core/server/utils/client-ip`). Behind a proxy, the socket peer is the proxy, and the real client is somewhere in `X-Forwarded-For`. The app has to know which addresses in that header it can believe. That's what `NUXT_TRUSTED_PROXIES` is for.

## How the client IP is chosen

Each proxy appends the address it received the request from. The leftmost entries are whatever the client sent, so they can't be trusted. `getClientIp` works from the right:

1. Start with the socket peer.
2. While the current address is a **trusted proxy**, move one entry left in `X-Forwarded-For`.
3. The first untrusted address is the client.

A forged entry sits to the left of the attacker's real address. The real address is never trusted, so the walk stops there and never reaches the forgery. If the socket peer isn't trusted (nothing in front of the app), the header is ignored.

## `NUXT_TRUSTED_PROXIES`

A comma-separated list of presets, CIDRs and bare addresses. Default: `loopback,private,cloudflare`, so a deploy behind Cloudflare works without setting anything.

| Preset | Ranges |
|---|---|
| `loopback` | `127.0.0.0/8`, `::1` |
| `private` | RFC 1918, `100.64.0.0/10` (CGNAT, used inside many PaaS networks), link-local, `fc00::/7` |
| `cloudflare` | Cloudflare's published edge ranges ([cloudflare.com/ips](https://www.cloudflare.com/ips/)), bundled in `client-ip.ts` |

An unknown preset or malformed CIDR throws on the first request, so a typo fails loudly. It can't quietly trust nothing.

## Pick a value

| Setup | Value |
|---|---|
| Cloudflare in front of the app, or a platform that routes through Cloudflare itself | `loopback,private,cloudflare` (default) |
| Nothing in front of the app (it listens on a public IP) | `loopback,private`. The header is ignored for public peers. |
| A PaaS or load balancer on a private network (Railway, Render, Fly, a DO load balancer, nginx on the same host) | `loopback,private` |
| A proxy with a fixed public address | `loopback,private,cloudflare,203.0.113.10` |

**Behind Cloudflare, keep `cloudflare`.** Without it, the Cloudflare edge IP becomes the "client". Every visitor routed through that edge then shares one bucket, and one abuser can use up the limit for all of them.

**Without Cloudflare, drop it.** Nothing legitimate reaches the app from a Cloudflare address, and trusting those ranges only opens the Workers gap described under [Limits](#limits).

Trusting `cloudflare` stays safe when the origin is also reachable directly (for example a `*.ondigitalocean.app` or `*.up.railway.app` URL). A direct request reaches the app through the platform's own ingress, which appends the caller's real address. That address isn't a Cloudflare one, so the walk stops there. You don't need to lock the origin down to Cloudflare-only for this to hold.

## Check what your platform sends

If you're not sure what's in front of the app, log one request in production:

```ts
console.log(event.node.req.socket.remoteAddress, getRequestHeader(event, 'x-forwarded-for'))
```

Every address to the right of your own IP in that output, plus the socket address, must be covered by `NUXT_TRUSTED_PROXIES`. Nothing that the public can send from should be covered.

## Limits

- Trusting `cloudflare` (the default) also trusts Cloudflare Workers, which make requests from Cloudflare addresses. Someone who sends requests through their own Worker can set `X-Forwarded-For` themselves. If that matters, use a WAF rate-limit rule at Cloudflare as well, or set `loopback,private` on a deploy that isn't behind Cloudflare.
- Only rate-limit paths that call `getClientIp` follow this setting. Code that calls h3's `getRequestIP(event, { xForwardedFor: true })` takes the leftmost entry, which the client controls.
