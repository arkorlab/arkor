# Getting Started

This page walks you through setting up Arkor for the first time.  
If you haven’t already, read the [Introduction](../introduction/index.md) to understand why Arkor is safe by design.

---

## 1. Create an Arkor Project

1. Go to the [Arkor Dashboard](https://arkor.io).
2. Click **New Project**.  
   A new database cluster will be created with:
   - Unique `DATABASE_URL`
   - Unique `ARKOR_KEY`
3. Copy these values for later.

---

## [WIP] 2. Install the Arkor Client

Install the npm package in your Next.js (or Node.js) app:

```bash
npm install arkor
````

---

## 3. Configure Environment Variables

In your local project, create a `.env.local` file and add:

```env
DATABASE_URL=postgres://your-project-id.region.arkor.ai/db
ARKOR_KEY=arkor_xxxxxxxxxxxxxxxxx
```

For production, add the same variables in your deployment provider (e.g. [Vercel](./vercel-integration.md)).

---

## [WIP] 4. Connect in Code

Create a database client that uses your project credentials:

```ts
// lib/db.ts
import { createClient } from 'arkor';

export const db = createClient({
  url: process.env.DATABASE_URL!,
  key: process.env.ARKOR_KEY!,
});
```

You can now run queries safely:

```ts
const users = await db.query("SELECT * FROM user_core LIMIT 5");
console.log(users);
```

---

## 5. Deploy to Vercel

* Push your code to GitHub.
* Set `DATABASE_URL` and `ARKOR_KEY` in your Vercel project settings.
* Deploy — Arkor will automatically connect to your cluster.

For step-by-step instructions, see [Vercel Integration](./vercel-integration.md).

---

## 6. Verify Safety

Unlike a raw Postgres instance, Arkor enforces:

* **Environment isolation** — dev tokens cannot touch prod.
* **Zero-trust defaults** — every table starts private.
* **Provider-scoped access** — prod only accepts traffic from allowed deploys from Vercel.

You don’t need to configure these — they are built-in.

---

## Next Steps

* Explore [Introduction → Why Arkor is Safe (Coming soon)](../introduction/index.md)
* Try the [Vercel Integration](./vercel-integration.md) for production deploys
* Read about reporting issues in [Security](../security/vulnerability-reporting.md)
