# Vercel Integration

## Overview

The Arkor Vercel integration allows you to deploy applications on Vercel with a Postgres-compatible database that is safe by design.  
By adding your Arkor credentials as environment variables, your app will automatically use Arkor in both local and production environments.

## [Create a Vercel App](#create-a-vercel-app)

To use the Vercel integration you'll need to create your own integration in Vercel. To start, click "Create" in the [Integrations Developer Console](https://vercel.com/dashboard/integrations/console).

---

## 1. Requirements

- A Vercel account
- An Arkor project (from the [Arkor Dashboard](https://arkor.ai))
- `DATABASE_URL` and `ARKOR_KEY` for your project (you can issue them from the [Arkor Dashboard](https://arkor.ai))

---

## 2. Add Environment Variables

1. In your Vercel project, go to **Settings → Environment Variables**.
2. Add the following variables:

| Name           | Value                                    | Environment |
| -------------- | ---------------------------------------- | ----------- |
| `DATABASE_URL` | Postgres connection string from Arkor    | All         |
| `ARKOR_KEY`    | Project key from the Arkor Dashboard     | All         |

3. Click **Save**.

---

## [WIP] 3. Update Your Code

Ensure your application loads the environment variables.  
For example, in a Next.js project:

```ts
// lib/db.ts
import { createClient } from 'arkor';

const db = createClient({
  url: process.env.DATABASE_URL!,
  key: process.env.ARKOR_KEY!,
});

export default db;
````

---

## 4. Deploy

1. Push your code to GitHub.
2. Trigger a deployment in Vercel.
3. Vercel will inject the `DATABASE_URL` and `ARKOR_KEY` into your app at build and runtime.

---

## [WIP] 5. Verify Integration

Run a test query to confirm the connection:

```ts
const users = await db.query("SELECT * FROM user_core LIMIT 1");
console.log(users);
```

If successful, you’ll see a result set from your Arkor database.

---

## [WIP] 6. Local Development

For local dev, add the same environment variables to `.env.local`:

```env
DATABASE_URL=postgres://...
ARKOR_KEY=arkor_...
```

Next.js and many frameworks will automatically load these.

---

## [WIP] 7. Troubleshooting

* **Invalid credentials**: Check that `DATABASE_URL` and `ARKOR_KEY` are correct and active in the Arkor Dashboard.
* **Connection issues on deploy**: Verify that the environment variables are set in all environments (Production, Preview, Development).
* **Permission errors**: Ensure your queries run through Arkor’s client, not a raw Postgres driver.

---

## [WIP] Next Steps

* Learn how Arkor enforces **safety by design** in [[Introduction → Why Safe](https://github.com/arkorlab/arkor/introduction/index.md)](../introduction/index.md)
* Explore more examples in [[Getting Started](https://github.com/arkorlab/arkor/compare/index.md)](./index.md (Coming soon))
