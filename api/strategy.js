export default async function handler(req, res) {
  const { lassoid } = req.query;

  if (!lassoid) {
    return res.status(400).json({ error: "Missing lassoid" });
  }

  if (!process.env.LASSO_API_KEY) {
    return res.status(500).json({ error: "Missing LASSO_API_KEY" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
  }

  try {
    const reportResponse = await fetch(
      `https://api.lassox.com/${lassoid}/reports/latest/pdf`,
      {
        headers: {
          "lasso-api-key": process.env.LASSO_API_KEY
        }
      }
    );

    if (!reportResponse.ok) {
      const errorText = await reportResponse.text();
      return res.status(reportResponse.status).json({
        error: "Report fetch failed",
        details: errorText
      });
    }

    const contentType = reportResponse.headers.get("content-type") || "";
    const raw = await reportResponse.text();

    const cleanedText = decodeEntities(
      raw
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );

    if (!cleanedText || cleanedText.length < 100) {
      return res.status(422).json({
        error: "Extracted text is too short",
        source: contentType.includes("xhtml") ? "ixbrl" : contentType,
        contentType,
        lassoid
      });
    }

    const analysis = await analyzeReportWithLLM(cleanedText, lassoid);

    return res.status(200).json({
      source: contentType.includes("xhtml") ? "ixbrl" : contentType,
      contentType,
      lassoid,
      analysis
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Unknown server error"
    });
  }
}

function decodeEntities(text) {
  return text
    .replace(/&#173;/g, "")
    .replace(/&#160;/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function analyzeReportWithLLM(text, lassoid) {
  const trimmedText = text.slice(0, 20000);

  const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-5",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "Du analyserer tekst fra en dansk årsrapport. Returner kun gyldig JSON. Brug kun information, der fremgår af teksten. Hvis noget ikke kan findes sikkert, brug null. risk_signals og qualitative_signals skal være arrays af strings."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `Udtræk følgende felter fra årsrapporten:\n\n` +
                `- company_name\n` +
                `- cvr\n` +
                `- report_period\n` +
                `- business_description\n` +
                `- management_commentary\n` +
                `- auditor_statement\n` +
                `- risk_signals\n` +
                `- qualitative_signals\n` +
                `- investment_takeaway\n\n` +
                `Lassoid: ${lassoid}\n\n` +
                `Rapporttekst:\n${trimmedText}`
            }
          ]
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
    })
  });

  const payload = await openaiResponse.json();

  if (!openaiResponse.ok) {
    throw new Error(
      payload?.error?.message || "OpenAI request failed"
    );
  }

  if (!payload.output_text) {
    throw new Error("OpenAI returned empty output");
  }

  return JSON.parse(payload.output_text);
}