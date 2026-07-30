import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  SAM_API_KEY: string;
}

const SAM_BASE = "https://api.sam.gov/opportunities/v2/search";

const NOTICE_TYPE_MAP: Record<string, string> = {
  solicitation: "o",
  presolicitation: "p",
  combined_synopsis: "k",
  sources_sought: "r",
  special_notice: "s",
  award: "a",
  justification: "u",
  sale_of_surplus: "g",
  intent_to_bundle: "i",
};

/** MM/dd/yyyy, as required by the SAM.gov API. */
function formatMMDDYYYY(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

/** Converts a caller-supplied ISO date (YYYY-MM-DD) to SAM.gov's MM/dd/yyyy. */
function isoToMMDDYYYY(iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) throw new Error(`Expected YYYY-MM-DD, got "${iso}"`);
  return `${m}/${d}/${y}`;
}

/** Strips HTML tags/entities from SAM.gov description text. */
function cleanHtml(html: string | undefined): string {
  if (!html) return "";
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&ndash;|&mdash;/g, "-")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

interface SamOpportunity {
  noticeId: string;
  title: string;
  solicitationNumber?: string;
  fullParentPathName?: string;
  postedDate?: string;
  type?: string;
  baseType?: string;
  active?: string;
  typeOfSetAside?: string;
  typeOfSetAsideDescription?: string;
  responseDeadLine?: string;
  naicsCode?: string;
  classificationCode?: string;
  placeOfPerformance?: { state?: { code?: string; name?: string }; city?: { name?: string } };
  uiLink?: string;
  description?: string;
}

interface SamSearchResponse {
  totalRecords: number;
  limit: number;
  offset: number;
  opportunitiesData?: SamOpportunity[];
}

async function samFetch(
  env: Env,
  params: Record<string, string | number | undefined>,
): Promise<SamSearchResponse> {
  if (!env.SAM_API_KEY) {
    throw new Error(
      "SAM_API_KEY is not configured on this Worker. Run: npx wrangler secret put SAM_API_KEY",
    );
  }

  const url = new URL(SAM_BASE);
  url.searchParams.set("api_key", env.SAM_API_KEY);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`SAM.gov API returned ${res.status}: ${body.slice(0, 300)}`);
  }

  return (await res.json()) as SamSearchResponse;
}

function normalizeOpportunity(o: SamOpportunity) {
  return {
    noticeId: o.noticeId,
    title: o.title,
    solicitationNumber: o.solicitationNumber?.trim(),
    agency: o.fullParentPathName,
    noticeType: o.type,
    postedDate: o.postedDate,
    responseDeadline: o.responseDeadLine,
    naicsCode: o.naicsCode,
    classificationCode: o.classificationCode,
    active: o.active,
    // Surfaced deliberately: this is the field that tells you whether a
    // non-US / non-small-business firm is even eligible to bid.
    setAside: o.typeOfSetAsideDescription ?? null,
    setAsideCode: o.typeOfSetAside ?? null,
    placeOfPerformanceState: o.placeOfPerformance?.state?.name ?? o.placeOfPerformance?.state?.code,
    uiLink: o.uiLink,
    // Not the actual text -- a URL to fetch separately. See get_sam_opportunity.
    descriptionUrl: o.description,
  };
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "sam-gov-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "search_sam_opportunities",
    {
      description:
        "Search US federal contract opportunities on SAM.gov (System for Award Management), the official GSA procurement database. Prefer filtering by naicsCode over keyword for precision -- SAM.gov's title search is literal text matching, not semantic. Requires the Worker's SAM_API_KEY secret to be configured.",
      inputSchema: z.object({
        naicsCode: z
          .string()
          .optional()
          .describe(
            "NAICS code (up to 6 digits) -- the primary, most reliable filter. Common software/IT/AI-relevant codes: 541511 (custom computer programming), 541512 (computer systems design), 541519 (other computer services), 541690 (other scientific/technical consulting), 518210 (data processing, hosting).",
          ),
        keyword: z
          .string()
          .optional()
          .describe(
            "Literal text search against the opportunity title only (not full-text/semantic). Best combined with naicsCode rather than used alone.",
          ),
        noticeType: z
          .enum([
            "solicitation",
            "presolicitation",
            "combined_synopsis",
            "sources_sought",
            "special_notice",
            "award",
            "justification",
            "sale_of_surplus",
            "intent_to_bundle",
          ])
          .optional()
          .describe("Filter by procurement notice type."),
        setAsideType: z
          .string()
          .optional()
          .describe(
            "Set-aside code to filter by, e.g. 'SBA' (total small business), '8A', 'WOSB', 'SDVOSBC', 'HZC'. Leave unset to see all -- set-aside status is always returned in results regardless, since it determines eligibility.",
          ),
        state: z
          .string()
          .length(2)
          .optional()
          .describe("Two-letter US state code for place of performance, e.g. 'VA', 'CA'."),
        postedWithinDays: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("How many days back from today to search postings (default 90, max 365)."),
        responseDeadlineFrom: z
          .string()
          .optional()
          .describe("Only show opportunities with response deadline on/after this date, format YYYY-MM-DD."),
        responseDeadlineTo: z
          .string()
          .optional()
          .describe("Only show opportunities with response deadline on/before this date, format YYYY-MM-DD."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Number of results to return (default 25, max 100 -- API supports up to 1000)."),
        offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)."),
      }),
    },
    async ({
      naicsCode,
      keyword,
      noticeType,
      setAsideType,
      state,
      postedWithinDays,
      responseDeadlineFrom,
      responseDeadlineTo,
      limit,
      offset,
    }) => {
      const today = new Date();
      const from = new Date(today);
      from.setDate(from.getDate() - (postedWithinDays ?? 90));

      const data = await samFetch(env, {
        postedFrom: formatMMDDYYYY(from),
        postedTo: formatMMDDYYYY(today),
        ncode: naicsCode,
        title: keyword,
        ptype: noticeType ? NOTICE_TYPE_MAP[noticeType] : undefined,
        typeOfSetAside: setAsideType,
        state,
        rdlfrom: responseDeadlineFrom ? isoToMMDDYYYY(responseDeadlineFrom) : undefined,
        rdlto: responseDeadlineTo ? isoToMMDDYYYY(responseDeadlineTo) : undefined,
        limit: limit ?? 25,
        offset: offset ?? 0,
      });

      const opportunities = (data.opportunitiesData ?? []).map(normalizeOpportunity);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total: data.totalRecords,
                returned: opportunities.length,
                offset: data.offset,
                opportunities,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_sam_opportunity",
    {
      description:
        "Fetch full details, including the complete description text, for a single SAM.gov opportunity by its noticeId (returned from search_sam_opportunities).",
      inputSchema: z.object({
        noticeId: z.string().describe("The SAM.gov notice ID, e.g. 'ff826a59eac743c4a1a07ff5e0cf3e3a'."),
      }),
    },
    async ({ noticeId }) => {
      const today = new Date();
      const from = new Date(today);
      // SAM.gov's docs say the max range is "1 year," but its own validation
      // rejects an exact 365-day span as "more than 1 year apart" -- pull in
      // a few days to stay safely under whatever the real boundary is.
      from.setDate(from.getDate() - 360);

      const data = await samFetch(env, {
        noticeid: noticeId,
        postedFrom: formatMMDDYYYY(from),
        postedTo: formatMMDDYYYY(today),
        limit: 1,
        offset: 0,
      });

      const raw = data.opportunitiesData?.[0];
      if (!raw) {
        return {
          content: [
            {
              type: "text",
              text: `No opportunity found with noticeId ${noticeId} in the last 365 days of postings.`,
            },
          ],
          isError: true,
        };
      }

      const opportunity = normalizeOpportunity(raw);
      let descriptionText = "";

      if (raw.description) {
        try {
          const descUrl = new URL(raw.description);
          descUrl.searchParams.set("api_key", env.SAM_API_KEY);
          const descRes = await fetch(descUrl.toString(), {
            headers: { Accept: "application/json" },
          });
          if (descRes.ok) {
            const descBody = await descRes.text();
            // This endpoint sometimes returns JSON ({"description": "..."})
            // and sometimes raw HTML/text depending on the notice -- handle both.
            try {
              const parsed = JSON.parse(descBody) as { description?: string };
              descriptionText = cleanHtml(parsed.description ?? descBody);
            } catch {
              descriptionText = cleanHtml(descBody);
            }
          }
        } catch {
          // Leave descriptionText empty; the raw link is still returned below.
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...opportunity, description: descriptionText || null }, null, 2),
          },
        ],
      };
    },
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname } = new URL(request.url);

    if (pathname === "/") {
      return new Response(
        "sam-gov-mcp is running. Connect an MCP client to /mcp (POST, not a browser GET).",
        { status: 200, headers: { "content-type": "text/plain" } },
      );
    }

    try {
      return await createMcpHandler(() => createServer(env))(request, env, ctx);
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error("MCP handler threw:", message);

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : "Internal server error",
          },
          id: null,
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  },
} satisfies ExportedHandler<Env>;
