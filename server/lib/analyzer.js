const { chat } = require('./llm');

async function extractFeatures(item, productName) {
  const messages = [
    { role: 'system', content: 'You are a product-management analyst tracking SIEM competitors. Output strict JSON only.' },
    { role: 'user', content: `Extract features from this release/announcement by ${productName}.

TITLE: ${item.title}
URL: ${item.url}
CONTENT:
${(item.content || '').slice(0, 6000)}

Return JSON:
{
  "version": "release version if mentioned, else null",
  "release_date": "YYYY-MM-DD if found, else null",
  "release_url": "if the page contains a more specific link to this release (anchor like #v9.3 or a separate per-version page), return its absolute URL, else null",
  "release_summary": "1-2 sentence summary",
  "features": [
    {
      "name": "short feature name",
      "category": "one of: Detection, Response, Search, Compliance, Integration, UEBA, SOAR, Cloud, Endpoint, Network, Identity, Specialized, Other",
      "summary": "1 sentence what it does",
      "source_url": "the most specific absolute URL that documents this feature — prefer an in-page anchor (e.g. URL#section-id) or a sub-page link explicitly mentioned in CONTENT for this feature; if none exists, return the article URL itself"
    }
  ]
}

IMPORTANT: source_url MUST be an absolute http(s) URL. If you cannot find a more specific anchor, fall back to the article URL above. Never return null.` },
  ];
  return chat(messages, { json: true });
}

async function scoreImplementability(feature, ourProductName, ourFeatures) {
  const messages = [
    { role: 'system', content: 'You are a senior PM scoring whether our product can implement a competitor feature. Output strict JSON only.' },
    { role: 'user', content: `Our product: ${ourProductName}.
Our existing features: ${ourFeatures.map(f => f.name).join(', ')}.

Score implementation confidence for this competitor feature:
NAME: ${feature.name}
CATEGORY: ${feature.category}
DESCRIPTION: ${feature.summary || ''}

Return JSON:
{
  "confidence": 0-100 integer (likelihood we can ship this in 1-2 release cycles),
  "effort": "low" | "medium" | "high",
  "rationale": "1-2 sentence reasoning",
  "recommendation": "build" | "consider" | "skip",
  "is_gap": true if we don't already have something equivalent, else false
}` },
  ];
  return chat(messages, { json: true });
}

module.exports = { extractFeatures, scoreImplementability };
