# sam-gov-mcp

A remote MCP server exposing the **SAM.gov Get Opportunities Public API**
(GSA's official US federal contract opportunities database) as tools for AI
agents -- NAICS-code search, response-deadline filtering, and full
description retrieval.

Same confirmed-working stack as the World Bank server in this account
(`agents@0.20.1`, `@modelcontextprotocol/server@2.0.0`, `zod@^4.4.3`,
`z.object()` schemas, per-request `env` closure, try/catch error logging).

## Tools exposed

- **`search_sam_opportunities`** -- search by NAICS code (recommended),
  title keyword, notice type, set-aside type, state, posted-date window,
  and response-deadline window.
- **`get_sam_opportunity`** -- full detail + description text for one
  notice by `noticeId`.

**Useful NAICS codes for software/AI work:** 541511 (custom computer
programming), 541512 (computer systems design), 541519 (other computer
services), 541690 (other scientific/technical consulting), 518210 (data
processing/hosting).

**On eligibility:** every result includes `setAside` / `setAsideCode`.
A large share of federal contracts are small-business set-asides --
closed to non-US-small-business firms. Full-and-open (no set-aside) is
the pool actually worth evaluating as a foreign company.

## 1. Get a SAM.gov API key (new step vs. the World Bank server)

Unlike World Bank's API, this one requires a key.

1. Register/sign in at [sam.gov](https://sam.gov).
2. Go to **Account Details** (top-right profile menu).
3. Request a **Public API Key**, entering your account password when
   prompted. The key is shown once on that page -- copy it immediately.
4. Free tier: 10 requests/day unauthenticated is not usable for this
   server (it requires a key for every call); the registered key gives
   **1,000 requests/day**, which is what you want.

## 2. Local setup

```bash
unzip sam-gov-mcp.zip
cd sam-gov-mcp
npm install
```

Create `.dev.vars` (gitignored, never committed) for local testing:

```bash
echo 'SAM_API_KEY="your-key-here"' > .dev.vars
```

Run it:

```bash
npm start
```

Test with the MCP Inspector in a second terminal:

```bash
npx @modelcontextprotocol/inspector@latest
```
Point it at `http://localhost:8788/mcp`, Connect, List Tools, try
`search_sam_opportunities` with `naicsCode: "541511"`.

## 3. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit: SAM.gov MCP server"
```

Create an empty repo on GitHub, then:

```bash
git remote add origin https://github.com/<your-username>/sam-gov-mcp.git
git branch -M main
git push -u origin main
```

## 4. Deploy to Cloudflare

**CLI:**

```bash
npx wrangler login
npx wrangler secret put SAM_API_KEY
# paste your key when prompted
npx wrangler deploy
```

**From your phone only (same pattern as the World Bank server):**

1. **Workers & Pages -> Create -> Import a repository**, pick this repo.
   Cloudflare detects `wrangler.jsonc` automatically.
2. Before or after first deploy: **Workers & Pages -> sam-gov-mcp ->
   Settings -> Variables and Secrets -> Add -> Secret**. Name:
   `SAM_API_KEY`, value: your key. Save (this redeploys automatically).
3. Every push to `main` redeploys.

Without step 2, every tool call will return a clear error telling you
the secret is missing -- it won't silently fail.

## 5. Connect it

```json
{
  "mcpServers": {
    "sam-gov": {
      "command": "npx",
      "args": ["mcp-remote", "https://sam-gov-mcp.<your-account>.workers.dev/mcp"]
    }
  }
}
```

## Notes

- `postedFrom`/`postedTo` are mandatory on SAM.gov's API and capped at a
  1-year range -- `search_sam_opportunities` handles this for you via
  `postedWithinDays` (default 90), so you don't need to think about it.
- `title` search is literal substring matching against titles only, not
  full-text or semantic -- lead with `naicsCode` for precision, same
  lesson learned from World Bank's noisier free-text search.
- If you ever see a Worker build fail with a version-resolution error
  like the World Bank server hit twice, check whether `agents` or
  `@modelcontextprotocol/server` have moved past the versions pinned
  here -- this ecosystem ships new releases every few days right now.
