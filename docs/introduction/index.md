# Introduction

Arkor is an open-source Postgres-compatible database that can’t leak by design.  
Most security incidents start as small permission slips—an open table, an unchecked wildcard role, an AI agent holding a broad token.  
Arkor makes that structurally impossible.

## Our Philosophy

**Protect the developer to protect the user.**

Most products fight leaks by giving developers yet another rule language, but one typo—by a human or an AI—still causes a breach.  
Arkor flips the model: the schema already knows who owns each row, so the database writes the only safe policy and locks it in—no super-user keys, no last-minute configs, no blame on the dev.  
Security is structural, not optional.

## What Arkor is for

| Outcome you want                                                             | Why the old way keeps failing                                                                             | How Arkor fixes it                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Ship code in dev without endangering prod—or breaking when it hits prod.** | Local databases and “test-mode” staging often share credentials; a forgotten flag turns into a prod leak. | **Environment Isolation** — each developer, staging, and prod run in separate clusters with unique credentials. Dev tokens can’t reach staging or prod.                                                                                                |
| **Block direct access to production.**                                       | A leaked service token or DB password lets attackers walk straight in via psql/SSH.                       | **Provider-Scoped Access** — prod only accepts traffic from whitelisted deploy targets (e.g., Vercel); direct psql/SSH is refused.                                                                                                                     |
| **Expose only what you intend—nothing more.**                                | RLS or Security Rules are easy to mis-write; defaults are often “public.”                                 | **Zero-Trust Defaults** — every table starts private; only those prefixed **`Public_*`** are ever exposed.                                                                                                                                             |
| **Let AI agents or contractors in—safely.**                                  | Blanket _service_role_ or DB passwords let an agent hit prod and do anything.                              | **AI-Safe Tokens + No-Prod-Access** — agents receive row-scoped, time-boxed keys that only work in their dev/staging cluster. The prod cluster refuses all direct tokens and has no _service_role_ key, so even a “rogue agent” can’t touch live data. |

## The main features include:

1. **Environment Isolation** – each developer, staging, and prod live in their own cluster with unique credentials, so AI agents can explore freely while production stays untouched.  
2. **Provider-Scoped Access** – production only accepts traffic from whitelisted deploys (Vercel, Cloudflare, etc.); direct SSH or psql from laptops is refused.  
3. **Zero-Trust Defaults** – every table is private by default; naming it `Public_*` is the only way to expose data.  
4. **Unified Auth + RLS** – SQL-native policies stored alongside your schema—no separate DSL, no extra service.  
