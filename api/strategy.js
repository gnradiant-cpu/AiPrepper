import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export default async function handler(req, res) {
  const { lassoid } = req.query;

  if (!lassoid) {
    return res.status(400).json({ error: "Missing lassoid" });
  }

  try {
    const response = await fetch(
      `https://api.lassox.com/${lassoid}/reports/latest/pdf`,
      {
        headers: {
          "lasso-api-key": process.env.LASSO_API_KEY
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({
        error: "Report fetch failed",
        details: errorText
      });
    }

    const contentType = response.headers.get("content-type") || "";
    const raw = await response.text();

    const decodeEntities = (text) => {
      return text
        .replace(/&#173;/g, "")
        .replace(/&#160;/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
    };

    const cleanedText = decodeEntities(
      raw
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );

    const analysis = await analyzeReportWithLLM(cleanedText, lassoid);

    return res.status(200).json({
      source: contentType.includes("xhtml") ? "ixbrl" : contentType,
      contentType,
      lassoid,
      analysis
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}

async function analyzeReportWithLLM(text, lassoid) {
  const trimmedText = text.slice(0, 20000);

  const response = await client.responses.create({
    model: "gpt-5",
    input: [
      {
        role: "system",
        content: `
Du analyserer tekst fra en dansk årsrapport.

Returner KUN gyldig JSON med disse felter:
- company_name
- cvr
- report_period
- business_description
- management_commentary
- auditor_statement
- risk_signals
- qualitative_signals
- investment_takeaway

Regler:
- Brug kun information, der fremgår af teksten.
- Hvis noget ikke kan findes sikkert, brug null.
- risk_signals og qualitative_signals skal være arrays af strings.
- Svar kun med JSON.
        `.trim()
      },
      {
        role: "user",
        content: `
Lassoid: ${lassoid}

Rapporttekst:
${trimmedText}
        `.trim()
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "annual_report_analysis",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            company_name: { type: ["string", "null"] },
            cvr: { type: ["string", "null"] },
            report_period: { type: ["string", "null"] },
            business_description: { type: ["string", "null"] },
            management_commentary: { type: ["string", "null"] },
            auditor_statement: { type: ["string", "null"] },
            risk_signals: {
              type: "array",
              items: { type: "string" }
            },
            qualitative_signals: {
              type: "array",
              items: { type: "string" }
            },
            investment_takeaway: { type: ["string", "null"] }
          },
          required: [
            "company_name",
            "cvr",
            "report_period",
            "business_description",
            "management_commentary",
            "auditor_statement",
            "risk_signals",
            "qualitative_signals",
            "investment_takeaway"
          ]
        }
      }
    }
  });

  return JSON.parse(response.output_text);
}