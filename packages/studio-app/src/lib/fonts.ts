// Side-effect imports that pull Geist Sans + Geist Mono variable woff2 in
// via Fontsource. Imported once from `main.tsx` so every page uses Geist
// without a runtime <link> to Google Fonts (Studio runs against a local
// Hono server and must work offline).
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
